/**
 * worker/index.ts — Long-running automation poll loop (§6.4, M3)
 *
 * This is a separate Node process (NOT serverless — §4). Run with:
 *   npm run worker
 *
 * Responsibilities:
 *   - On each tick, load all enabled automations (any type) with their client
 *   - Dispatch each to its runner via the automation registry (automations/registry.ts)
 *   - Skip paused clients (kill switch §6.5) — no polling, no LLM
 *   - For each automation whose pollInterval has elapsed, run poll() → process()
 *   - Resilient: one automation/client failing must NOT crash the loop
 *   - Graceful shutdown on SIGINT / SIGTERM
 *   - M3: daily spend alert — once per UTC day, sum Run.costUsd for today and
 *     alert the operator if it exceeds DAILY_SPEND_ALERT_USD (default $25).
 *
 * Scheduling: simple in-process map tracking lastRunAt per automation ID.
 * Webhooks / cron-based scheduling are M4 concerns.
 *
 * Security: LLM keys and OAuth tokens are server-side only (§7.3).
 * Never log token values.
 */

import { prisma } from "@/lib/db";
import { getAutomationRunner } from "@/automations/registry";
import type { Client, AutomationType } from "@prisma/client";
import { notifyOperator } from "@/lib/alerts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How often (ms) the outer loop ticks. Keep short so poll intervals are honoured. */
const TICK_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Daily operator spend alert threshold (USD).
 * Read from DAILY_SPEND_ALERT_USD env var; defaults to $25 if not set.
 * This is an operator-level alert, not per-client. (§6.5)
 */
const DAILY_SPEND_ALERT_USD = parseFloat(
  process.env.DAILY_SPEND_ALERT_USD ?? "25"
);

// ---------------------------------------------------------------------------
// In-process scheduler state
// ---------------------------------------------------------------------------

/** Map from automationId → timestamp of last successful poll start */
const lastRunAt = new Map<string, number>();

/**
 * In-memory dedup for the daily spend alert.
 * Stores the UTC date string ("YYYY-MM-DD") for which an alert has already
 * been sent this process lifetime. Resets on worker restart — acceptable for
 * a long-running process. At most one alert per UTC day per worker process.
 */
let dailySpendAlertSentForDate: string | null = null;

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
// Daily spend alert (§6.5, M3)
// ---------------------------------------------------------------------------

/**
 * checkDailySpend — called once per tick; deduped to fire at most once per
 * UTC day (per worker process lifetime).
 *
 * Sums Run.costUsd for all runs started today (UTC). If the total exceeds
 * DAILY_SPEND_ALERT_USD, notifies the operator. The dedup flag resets on
 * worker restart — acceptable since the worker is a long-running process.
 *
 * Non-fatal: if the DB query fails the error is logged and the tick continues.
 */
async function checkDailySpend(): Promise<void> {
  const todayUtc = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  // Already alerted for today — skip
  if (dailySpendAlertSentForDate === todayUtc) {
    return;
  }

  try {
    const dayStart = new Date(`${todayUtc}T00:00:00.000Z`);

    // Sum costUsd for all runs started on or after today 00:00 UTC
    const result = await prisma.run.aggregate({
      _sum: { costUsd: true },
      where: { startedAt: { gte: dayStart } },
    });

    const totalCost = result._sum.costUsd ?? 0;

    if (totalCost >= DAILY_SPEND_ALERT_USD) {
      // Stamp the dedup flag BEFORE notifying so a slow notification path
      // doesn't cause duplicates if this function is re-entered
      dailySpendAlertSentForDate = todayUtc;

      notifyOperator({
        type: "daily_spend",
        message:
          `Daily LLM spend across all clients has reached $${totalCost.toFixed(4)}, ` +
          `exceeding the $${DAILY_SPEND_ALERT_USD.toFixed(2)} threshold.`,
        details: {
          date: todayUtc,
          totalCostUsd: totalCost,
          thresholdUsd: DAILY_SPEND_ALERT_USD,
        },
      });
    }
  } catch (err) {
    // Non-fatal — a missed daily alert is not worth crashing the tick
    console.error(
      "[worker] checkDailySpend: failed to query daily spend: " +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

// ---------------------------------------------------------------------------
// Core tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (shuttingDown) return;

  // Daily spend alert check (§6.5, M3) — runs once per tick, deduped per UTC day
  await checkDailySpend();

  // Load ALL enabled automations (any type) along with their client. The
  // runner for each type is resolved via the automation registry below, so the
  // worker no longer hardcodes a single type.
  let automations: Array<{
    id: string;
    type: AutomationType;
    clientId: string;
    config: unknown;
    pollInterval: number;
    client: Client;
  }>;

  try {
    automations = await prisma.automation.findMany({
      where: {
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
      await runAutomation(
        automation.type,
        automation.client,
        automation.id,
        automation.config
      );
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
  type: AutomationType,
  client: Client,
  automationId: string,
  rawConfig: unknown
): Promise<void> {
  // Resolve the runner for this automation type. An unregistered type (enum
  // value in the DB with no module wired up) is logged and skipped, not fatal.
  const runner = getAutomationRunner(type);
  if (!runner) {
    console.error(
      `[worker] no runner registered for automation type '${type}' (automation=${automationId}); skipping`
    );
    return;
  }

  console.log(
    `[worker] polling automation=${automationId} type=${type} client=${client.id} (${client.name})`
  );

  // poll() handles its own errors and returns [] on failure
  const items = await runner.poll(client, rawConfig);

  if (items.length === 0) {
    return;
  }

  console.log(`[worker] automation=${automationId} found ${items.length} item(s)`);

  for (const item of items) {
    if (shuttingDown) break;
    // processItem() handles its own try/catch and records the Run on failure.
    // automationId travels via the context, not by mutating the item.
    await runner.processItem(item, { automationId });
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[worker] starting automation poll worker (M3)");
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
