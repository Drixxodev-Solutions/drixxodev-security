/**
 * app/(operator)/dashboard/page.tsx — Operator dashboard (§6.7, M4).
 *
 * Lists all clients with:
 *   - Name + status badge (active / paused)
 *   - Connection health (each provider's status)
 *   - This-month usage (calls and cost vs cap)
 *   - Link to the client detail page
 *
 * SAFE FIELDS ONLY: we never select encryptedAccessToken,
 * encryptedRefreshToken, or any prompt/key column (§7.2).
 *
 * force-dynamic: prevents Next.js from pre-rendering at build time,
 * which would fail without a live DB or Clerk keys (§9 M4 acceptance).
 */

export const dynamic = "force-dynamic";

import Link from "next/link";
import { prisma } from "@/lib/db";
import styles from "./dashboard.module.css";

// ---------------------------------------------------------------------------
// Data loading — safe fields only (§7.2)
// ---------------------------------------------------------------------------

async function getAllClients() {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  return prisma.client.findMany({
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
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type ClientStatus = "active" | "paused";
type ConnectionStatus = "active" | "expired" | "revoked";

function StatusBadge({ status }: { status: ClientStatus }) {
  if (status === "active") {
    return <span className={styles.badgeActive}>Active</span>;
  }
  return <span className={styles.badgePaused}>Paused</span>;
}

function ConnectionPill({
  provider,
  status,
}: {
  provider: string;
  status: ConnectionStatus;
}) {
  const cls =
    status === "active"
      ? styles.connActive
      : status === "expired"
      ? styles.connExpired
      : styles.connRevoked;

  return (
    <span className={`${styles.connPill} ${cls}`}>
      {provider} — {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DashboardPage() {
  const clients = await getAllClients();

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Clients</h1>
      <p className={styles.pageSubtitle}>
        {clients.length} client{clients.length !== 1 ? "s" : ""} total
      </p>

      {clients.length === 0 ? (
        <div className={styles.empty}>No clients yet.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Client</th>
              <th>Status</th>
              <th>Connections</th>
              <th>This Month</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => {
              const usage = client.usageCounters[0];
              const overCap =
                usage &&
                (usage.callsUsed > usage.callsIncluded ||
                  usage.costUsd > usage.capUsd);

              return (
                <tr key={client.id}>
                  {/* Name + email */}
                  <td>
                    <div style={{ fontWeight: 600 }}>{client.name}</div>
                    <div style={{ fontSize: "0.8rem", color: "#888" }}>
                      {client.contactEmail}
                    </div>
                  </td>

                  {/* Status badge */}
                  <td>
                    <StatusBadge status={client.status as ClientStatus} />
                  </td>

                  {/* Connection health */}
                  <td>
                    {client.connections.length === 0 ? (
                      <span style={{ color: "#aaa", fontSize: "0.82rem" }}>
                        None
                      </span>
                    ) : (
                      <div className={styles.connections}>
                        {client.connections.map((conn) => (
                          <ConnectionPill
                            key={conn.provider}
                            provider={conn.provider}
                            status={conn.status as ConnectionStatus}
                          />
                        ))}
                      </div>
                    )}
                  </td>

                  {/* Usage */}
                  <td>
                    {usage ? (
                      <div
                        className={`${styles.usageRow} ${overCap ? styles.usageOver : ""}`}
                      >
                        {usage.callsUsed}/{usage.callsIncluded} calls
                        <br />${usage.costUsd.toFixed(2)} / ${usage.capUsd.toFixed(2)} cap
                        {overCap && " ⚠"}
                      </div>
                    ) : (
                      <span style={{ color: "#aaa", fontSize: "0.82rem" }}>
                        No data
                      </span>
                    )}
                  </td>

                  {/* Detail link */}
                  <td>
                    <Link
                      href={`/dashboard/clients/${client.id}`}
                      className={styles.detailLink}
                    >
                      View
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
