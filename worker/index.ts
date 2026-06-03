/**
 * worker/index.ts — Long-running automation poll loop (§6.4, M2)
 *
 * This is a separate Node process (NOT serverless — §4). Run with:
 *   npm run worker
 *
 * Responsibilities:
 *   - On each tick, load all enabled email_triage automations with their client
 *   - Skip paused clients (kill switch §6.5) — no polling, no LLM
 *   - For each automation whose pollInterval has elapsed, run poll() → process()
 *   - Resilient: one automation/client failing must NOT crash the loop
 *   - Graceful shutdown on SIGINT / SIGTERM
 *
 * Scheduling: simple in-process map tracking lastRunAt per automation ID.
 * Webhooks / cron-based scheduling are M4 concerns.
 *
 * Security: LLM keys and OAuth tokens are server-side only (§7.3).
 * Never log token values.
 */

import { prisma } from "@/lib/db";
import { poll, processItem } from "@/automations/email_triage/index";
import type { EmailTriageConfig } from "@/automations/email_triage/index";
import type { Client } from "@prisma/client";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How often (ms) the outer loop ticks. Keep short so poll intervals are honoured. */
const TICK_INTERVAL_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// In-process scheduler state
// ---------------------------------------------------------------------------

/** Map from automationId → timestamp of last successful poll start */
const lastRunAt = new Map<string, number>();

function shouldRun(automationId: string, pollIntervalSeconds: number): boolean {
  const last = lastRunAt.get(automationId) ?? 0;
  return Date.now() - last >= pollIntervalSeconds * 1000;
}

// ---------------------------------------------------------------------------
// Shutdown handling
// ---------------------------------------------------------------------------

let shuttingDown = false;

function handleShutdown(signal: string): void {
  console.log(`[worker] received ${signal}; shutting down gracefully…`);
  shuttingDown = true;
  // Give in-flight automations a moment to record their Runs, then exit
  setTimeout(() => {
    console.log("[worker] bye");
    process.exit(0);
  }, 3000);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// Core tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (shuttingDown) return;

  // Load all enabled email_triage automations along with their client
  let automations: Array<{
    id: string;
    clientId: string;
    config: unknown;
    pollInterval: number;
    client: Client;
  }>;

  try {
    automations = await prisma.automation.findMany({
      where: {
        type: "email_triage",
        enabled: true,
      },
      include: { client: true },
    });
  } catch (err) {
    console.error(
      "[worker] tick: failed to load automations: " +
        (err instanceof Error ? err.message : String(err))
    );
    return;
  }

  for (const automation of automations) {
    if (shuttingDown) break;

    // Kill switch (§6.5): skip entirely if client is paused
    if (automation.client.status === "paused") {
      continue;
    }

    // Respect the automation's poll interval
    if (!shouldRun(automation.id, automation.pollInterval)) {
      continue;
    }

    // Mark as running now (before the async work, so we don't double-schedule)
    lastRunAt.set(automation.id, Date.now());

    // One automation failing must not crash the loop (§6.4)
    try {
      await runAutomation(automation.client, automation.id, automation.config);
    } catch (err) {
      // Any unhandled error from runAutomation is caught here as a safety net.
      // Individual item failures are recorded on Run rows inside process().
      console.error(
        `[worker] tick: unexpected error for automation ${automation.id}: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }
}

async function runAutomation(
  client: Client,
  automationId: string,
  rawConfig: unknown
): Promise<void> {
  const config = (rawConfig ?? {}) as EmailTriageConfig;

  console.log(
    `[worker] polling automation=${automationId} client=${client.id} (${client.name})`
  );

  // poll() handles its own errors and returns [] on failure
  const items = await poll(client, config);

  if (items.length === 0) {
    return;
  }

  console.log(`[worker] automation=${automationId} found ${items.length} item(s)`);

  for (const item of items) {
    if (shuttingDown) break;
    // Attach the automationId (poll() doesn't know it)
    item.automationId = automationId;
    // process() handles its own try/catch and records Run on failure
    await processItem(item, { automationId });
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[worker] starting automation poll worker (M2)");
  console.log(`[worker] tick interval: ${TICK_INTERVAL_MS / 1000}s`);

  // Run an initial tick immediately, then on interval
  await tick();

  const interval = setInterval(async () => {
    if (shuttingDown) {
      clearInterval(interval);
      return;
    }
    try {
      await tick();
    } catch (err) {
      // Belt-and-suspenders: the tick itself is wrapped in try/catch above,
      // but catch here too so setInterval never swallows unhandled rejections.
      console.error(
        "[worker] tick threw unexpectedly: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }, TICK_INTERVAL_MS);

  // Keep the process alive
  console.log("[worker] running — send SIGINT or SIGTERM to stop");
}

main().catch((err) => {
  console.error("[worker] fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
