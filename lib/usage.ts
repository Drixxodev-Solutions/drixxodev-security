/**
 * lib/usage.ts — Usage cap guard + metering + alerts (§6.4, §6.5, §8.2)
 *
 * M3 additions:
 *   - 80% alert: after recordUsage increments, fire notifyOperator once per month
 *     when either the call count or dollar spend crosses 80% of the client's cap.
 *   - Overage auto-pause (kill switch, §6.5): when checkCap detects a cap is
 *     already exceeded, pause the Client and stamp pausedForOverageAt — both
 *     idempotent (guarded by null checks + conditional DB writes).
 *
 * Design decision: auto-pause is triggered inside checkCap (when allowed=false),
 * NOT inside recordUsage. Rationale: checkCap already reads the counter and
 * evaluates the cap condition; triggering there guarantees the client is paused
 * even if they somehow reach the cap on a concurrent request that bypasses
 * recordUsage (e.g. a failed run that still counted). It also means the pause
 * is enacted before any LLM spend occurs, aligning with §8.2 "cap enforced BEFORE
 * any LLM call".
 *
 * Security: never log token values, email content, or API keys.
 */

import { prisma } from "@/lib/db";
import { notifyOperator } from "@/lib/alerts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the current UTC month as "YYYY-MM" */
function currentMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CapResult {
  allowed: boolean;
  counter: {
    callsUsed: number;
    callsIncluded: number;
    costUsd: number;
    capUsd: number;
  };
}

/**
 * checkCap — call this BEFORE every LLM call (§6.4, §8.2).
 *
 * Upserts the current-month UsageCounter for the client, then returns:
 *   allowed = true  → client is within both their call cap and dollar cap.
 *   allowed = false → client has exceeded either limit; skip the LLM call.
 *
 * "allowed" is false if callsUsed >= callsIncluded OR costUsd >= capUsd.
 * This is a strict check — >= means the cap is already hit, not about to be hit.
 *
 * M3 additional effect (auto-pause, §6.5):
 *   When allowed=false, atomically pauses the Client and stamps
 *   pausedForOverageAt on the UsageCounter — idempotent: only fires once per
 *   month (both writes are guarded by null/status preconditions).
 */
export async function checkCap(clientId: string): Promise<CapResult> {
  const month = currentMonth();

  // Upsert: creates the row with defaults if this is the client's first call
  // this month; otherwise returns the existing row untouched.
  const counter = await prisma.usageCounter.upsert({
    where: { clientId_month: { clientId, month } },
    create: { clientId, month },
    update: {}, // no-op update — we only want the existing values
    select: {
      callsUsed: true,
      callsIncluded: true,
      costUsd: true,
      capUsd: true,
      pausedForOverageAt: true,
    },
  });

  const allowed =
    counter.callsUsed < counter.callsIncluded &&
    counter.costUsd < counter.capUsd;

  if (!allowed) {
    console.warn(
      `[usage] cap exceeded for client ${clientId} (${month}): ` +
        `calls=${counter.callsUsed}/${counter.callsIncluded} ` +
        `cost=$${counter.costUsd.toFixed(4)}/$${counter.capUsd.toFixed(4)}`
    );

    // Auto-pause (§6.5): only if not already paused for overage this month.
    // Idempotency: pausedForOverageAt null check ensures we alert + pause at most once.
    if (!counter.pausedForOverageAt) {
      await enactOveragePause(clientId, month, counter);
    }
  }

  return {
    allowed,
    counter: {
      callsUsed: counter.callsUsed,
      callsIncluded: counter.callsIncluded,
      costUsd: counter.costUsd,
      capUsd: counter.capUsd,
    },
  };
}

/**
 * Pause the client and stamp the counter — executed at most once per month per
 * client thanks to the pausedForOverageAt null guard in checkCap.
 *
 * Uses updateMany with a WHERE clause on status=active so the Client pause is
 * also a no-op if they were already paused by a concurrent request or by the
 * operator manually.
 */
async function enactOveragePause(
  clientId: string,
  month: string,
  counter: {
    callsUsed: number;
    callsIncluded: number;
    costUsd: number;
    capUsd: number;
  }
): Promise<void> {
  const now = new Date();

  try {
    // Stamp the counter first. Use updateMany with the null guard so concurrent
    // requests don't both proceed past this point.
    const stamped = await prisma.usageCounter.updateMany({
      where: {
        clientId,
        month,
        pausedForOverageAt: null, // idempotency guard
      },
      data: { pausedForOverageAt: now },
    });

    if (stamped.count === 0) {
      // Another concurrent request already stamped it — skip the rest
      return;
    }

    // Pause the client (only if currently active, to avoid clobbering a manual
    // operator-applied status).
    await prisma.client.updateMany({
      where: { id: clientId, status: "active" },
      data: { status: "paused" },
    });

    notifyOperator({
      type: "overage_pause",
      clientId,
      message: `Client ${clientId} auto-paused: monthly cap exceeded.`,
      details: {
        month,
        callsUsed: counter.callsUsed,
        callsIncluded: counter.callsIncluded,
        costUsd: counter.costUsd,
        capUsd: counter.capUsd,
        pausedAt: now.toISOString(),
      },
    });
  } catch (err) {
    // Non-fatal: log but do not crash the caller. The cap check (allowed=false)
    // still blocks the LLM call even if the pause write fails.
    console.error(
      `[usage] enactOveragePause failed for client ${clientId}: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

/**
 * recordUsage — call this AFTER a successful LLM call to increment the
 * client's monthly counters.
 *
 * Uses an atomic increment (prisma update with increment) to avoid races
 * when multiple automations for the same client run concurrently.
 *
 * M3 addition: after the increment, check if the client has crossed 80% of
 * either their call cap or dollar cap. If crossed and alerted80At is null,
 * stamp the timestamp (idempotent) and fire the operator alert once per month.
 */
export async function recordUsage(
  clientId: string,
  usage: { calls: number; costUsd: number }
): Promise<void> {
  const month = currentMonth();

  // Atomic increment; returns the updated counter for the 80% check
  const updated = await prisma.usageCounter.upsert({
    where: { clientId_month: { clientId, month } },
    create: {
      clientId,
      month,
      callsUsed: usage.calls,
      costUsd: usage.costUsd,
    },
    update: {
      callsUsed: { increment: usage.calls },
      costUsd: { increment: usage.costUsd },
    },
    select: {
      callsUsed: true,
      callsIncluded: true,
      costUsd: true,
      capUsd: true,
      alerted80At: true,
    },
  });

  // 80% alert check (§6.5)
  // Fire if either dimension has crossed 80% AND we haven't alerted this month yet.
  const callPct = updated.callsIncluded > 0
    ? updated.callsUsed / updated.callsIncluded
    : 0;
  const costPct = updated.capUsd > 0
    ? updated.costUsd / updated.capUsd
    : 0;

  if ((callPct >= 0.8 || costPct >= 0.8) && !updated.alerted80At) {
    await maybeAlert80(clientId, month, updated);
  }
}

/**
 * Stamp alerted80At (idempotent via updateMany null guard) and notify operator.
 * The updateMany WHERE alerted80At=null means at most one concurrent request
 * will actually send the alert even under parallel automation runs.
 */
async function maybeAlert80(
  clientId: string,
  month: string,
  counter: {
    callsUsed: number;
    callsIncluded: number;
    costUsd: number;
    capUsd: number;
  }
): Promise<void> {
  try {
    const stamped = await prisma.usageCounter.updateMany({
      where: {
        clientId,
        month,
        alerted80At: null, // idempotency guard — only the first writer proceeds
      },
      data: { alerted80At: new Date() },
    });

    if (stamped.count === 0) {
      // Another concurrent request already sent the alert — nothing to do
      return;
    }

    const callPct = counter.callsIncluded > 0
      ? Math.round((counter.callsUsed / counter.callsIncluded) * 100)
      : 0;
    const costPct = counter.capUsd > 0
      ? Math.round((counter.costUsd / counter.capUsd) * 100)
      : 0;

    notifyOperator({
      type: "usage_80",
      clientId,
      message:
        `Client ${clientId} has reached 80%+ of their monthly cap ` +
        `(calls: ${callPct}%, cost: ${costPct}%).`,
      details: {
        month,
        callsUsed: counter.callsUsed,
        callsIncluded: counter.callsIncluded,
        callPct,
        costUsd: counter.costUsd,
        capUsd: counter.capUsd,
        costPct,
      },
    });
  } catch (err) {
    // Non-fatal — a missed 80% alert is annoying but not critical
    console.error(
      `[usage] maybeAlert80 failed for client ${clientId}: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
}
