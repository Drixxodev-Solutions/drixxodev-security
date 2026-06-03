/**
 * lib/usage.ts — Minimal usage cap guard (§6.4, §6.5, §8.2)
 *
 * M2 scope: cap check before every LLM call + recording actual usage.
 * Full enforcement (80% alert, daily spend threshold, overage billing/pause)
 * is hardened in M3.
 *
 * TODO(M3): 80% + daily-spend alerts to operator, overage billing/pause logic.
 * TODO(M3): Kill switch: if overage policy is "pause", set Client.status=paused.
 */

import { prisma } from "@/lib/db";

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
  }

  return { allowed, counter };
}

/**
 * recordUsage — call this AFTER a successful LLM call to increment the
 * client's monthly counters.
 *
 * Uses an atomic increment (prisma update with increment) to avoid races
 * when multiple automations for the same client run concurrently.
 */
export async function recordUsage(
  clientId: string,
  usage: { calls: number; costUsd: number }
): Promise<void> {
  const month = currentMonth();

  await prisma.usageCounter.upsert({
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
  });
}
