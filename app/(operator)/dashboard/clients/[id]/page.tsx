/**
 * app/(operator)/dashboard/clients/[id]/page.tsx — Client detail page (§6.7, M4).
 *
 * Shows:
 *   - Client name, email, status
 *   - Connections with health status
 *   - This-month usage vs cap
 *   - Latest 20 Run rows (safe fields only — no prompt text, no raw tokens)
 *   - Pause/resume toggle (via PauseToggle client component)
 *
 * SAFE FIELDS ONLY: never select encryptedAccessToken,
 * encryptedRefreshToken, or any prompt/key column (§7.2).
 *
 * force-dynamic: DB queries must run at request time, not build time.
 */

export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import PauseToggle from "./PauseToggle";
import styles from "./detail.module.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageProps {
  params: { id: string };
}

type RunStatus = "pending" | "running" | "succeeded" | "failed";
type ConnectionStatus = "active" | "expired" | "revoked";

// ---------------------------------------------------------------------------
// Data loading — safe fields only (§7.2)
// ---------------------------------------------------------------------------

async function getClientDetail(id: string) {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      status: true,
      plan: true,
      createdAt: true,
      connections: {
        select: {
          provider: true,
          status: true,
          tokenExpiresAt: true,
          scopes: true,
        },
      },
      usageCounters: {
        where: { month },
        select: {
          month: true,
          callsUsed: true,
          callsIncluded: true,
          costUsd: true,
          capUsd: true,
          pausedForOverageAt: true,
        },
      },
      automations: {
        select: {
          id: true,
          type: true,
          enabled: true,
          runs: {
            select: {
              id: true,
              status: true,
              llmProvider: true,
              tokensUsed: true,
              costUsd: true,
              startedAt: true,
              finishedAt: true,
              outputSummary: true,
              error: true,
            },
            orderBy: { startedAt: "desc" },
            take: 20,
          },
        },
      },
    },
  });

  return client;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RunStatusChip({ status }: { status: RunStatus }) {
  const cls =
    status === "succeeded"
      ? styles.runSucceeded
      : status === "failed"
      ? styles.runFailed
      : status === "running"
      ? styles.runRunning
      : styles.runPending;

  return <span className={`${styles.runStatus} ${cls}`}>{status}</span>;
}

function ConnectionCard({
  provider,
  status,
}: {
  provider: string;
  status: ConnectionStatus;
}) {
  const cls =
    status === "active"
      ? styles.connCardActive
      : status === "expired"
      ? styles.connCardExpired
      : styles.connCardRevoked;

  return (
    <span className={`${styles.connCard} ${cls}`}>
      {provider} — {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ClientDetailPage({ params }: PageProps) {
  const client = await getClientDetail(params.id);

  if (!client) {
    notFound();
  }

  const usage = client.usageCounters[0];
  const callsOver = usage && usage.callsUsed > usage.callsIncluded;
  const costOver = usage && usage.costUsd > usage.capUsd;

  // Flatten all runs from all automations, re-sort by startedAt desc, take 20.
  const allRuns = client.automations
    .flatMap((a) => a.runs)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, 20);

  return (
    <div className={styles.page}>
      <Link href="/dashboard" className={styles.backLink}>
        ← All clients
      </Link>

      {/* Client header + toggle */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.clientName}>{client.name}</h1>
          <p className={styles.clientMeta}>
            {client.contactEmail} &middot; Plan: {client.plan}
          </p>
        </div>
        <PauseToggle
          clientId={client.id}
          currentStatus={client.status as "active" | "paused"}
        />
      </div>

      {/* Connections */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Connections</h2>
        <div className={styles.sectionBody}>
          {client.connections.length === 0 ? (
            <p className={styles.empty}>No connections yet.</p>
          ) : (
            <div className={styles.connGrid}>
              {client.connections.map((conn) => (
                <ConnectionCard
                  key={conn.provider}
                  provider={conn.provider}
                  status={conn.status as ConnectionStatus}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* This-month usage */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>
          Usage — {usage?.month ?? "this month"}
        </h2>
        <div className={styles.sectionBody}>
          {usage ? (
            <div className={styles.statsRow}>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Calls used</span>
                <span
                  className={`${styles.statValue} ${callsOver ? styles.statOver : ""}`}
                >
                  {usage.callsUsed} / {usage.callsIncluded}
                </span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Cost</span>
                <span
                  className={`${styles.statValue} ${costOver ? styles.statOver : ""}`}
                >
                  ${usage.costUsd.toFixed(4)} / ${usage.capUsd.toFixed(2)} cap
                </span>
              </div>
              {usage.pausedForOverageAt && (
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Auto-paused</span>
                  <span className={`${styles.statValue} ${styles.statOver}`}>
                    {new Date(usage.pausedForOverageAt).toLocaleDateString()}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <p className={styles.empty}>No usage data for this month.</p>
          )}
        </div>
      </section>

      {/* Recent runs */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Recent runs (last 20)</h2>
        <div>
          {allRuns.length === 0 ? (
            <p className={styles.empty} style={{ padding: "1rem 1.25rem" }}>
              No runs yet.
            </p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>LLM</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                  <th>Started</th>
                  <th>Output / Error</th>
                </tr>
              </thead>
              <tbody>
                {allRuns.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <RunStatusChip status={run.status as RunStatus} />
                    </td>
                    <td>{run.llmProvider ?? "—"}</td>
                    <td>{run.tokensUsed ?? "—"}</td>
                    <td>
                      {run.costUsd != null
                        ? `$${run.costUsd.toFixed(4)}`
                        : "—"}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {run.startedAt.toLocaleString()}
                    </td>
                    <td>
                      {run.status === "failed" && run.error ? (
                        <span style={{ color: "#991b1b" }}>{run.error}</span>
                      ) : (
                        run.outputSummary ?? "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
