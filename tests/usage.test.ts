/**
 * tests/usage.test.ts — Priority 4 & 6: Usage cap enforcement + auto-pause (kill switch)
 *
 * Tests:
 *   checkCap:
 *     - returns allowed=true when within both call and cost caps
 *     - returns allowed=false and triggers auto-pause when calls >= callsIncluded
 *     - returns allowed=false and triggers auto-pause when cost >= capUsd
 *     - auto-pause is idempotent (second call with pausedForOverageAt set does NOT re-pause)
 *     - auto-pause uses status:"active" guard on client.updateMany
 *   recordUsage:
 *     - increments calls and cost atomically
 *     - fires 80% alert when usage crosses 80% and alerted80At is null
 *     - does NOT re-alert if alerted80At is already set
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------

const mockUsageCounterUpsert = vi.fn();
const mockUsageCounterUpdateMany = vi.fn();
const mockClientUpdateMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    usageCounter: {
      upsert: (...args: unknown[]) => mockUsageCounterUpsert(...args),
      updateMany: (...args: unknown[]) => mockUsageCounterUpdateMany(...args),
    },
    client: {
      updateMany: (...args: unknown[]) => mockClientUpdateMany(...args),
    },
  },
}));

// Mock notifyOperator to avoid side effects
vi.mock("@/lib/alerts", () => ({
  notifyOperator: vi.fn(),
}));

describe("Usage cap enforcement — checkCap (Priority 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns allowed=true when client is within call and cost caps", async () => {
    mockUsageCounterUpsert.mockResolvedValue({
      callsUsed: 50,
      callsIncluded: 100,
      costUsd: 5.0,
      capUsd: 10.0,
      pausedForOverageAt: null,
    });

    const { checkCap } = await import("@/lib/usage");
    const result = await checkCap("client-within");

    expect(result.allowed).toBe(true);
    expect(result.counter.callsUsed).toBe(50);
    // auto-pause must NOT be triggered
    expect(mockUsageCounterUpdateMany).not.toHaveBeenCalled();
    expect(mockClientUpdateMany).not.toHaveBeenCalled();
  });

  it("returns allowed=false and triggers auto-pause when callsUsed >= callsIncluded", async () => {
    mockUsageCounterUpsert.mockResolvedValue({
      callsUsed: 100,
      callsIncluded: 100,
      costUsd: 2.0,
      capUsd: 10.0,
      pausedForOverageAt: null, // first time hitting the cap
    });

    // Simulate that the updateMany stamp succeeds (count=1 → proceed to pause client)
    mockUsageCounterUpdateMany.mockResolvedValue({ count: 1 });
    mockClientUpdateMany.mockResolvedValue({ count: 1 });

    const { checkCap } = await import("@/lib/usage");
    const result = await checkCap("client-over-calls");

    expect(result.allowed).toBe(false);
    // Counter update must be called with the idempotency guard
    expect(mockUsageCounterUpdateMany).toHaveBeenCalledOnce();
    const counterUpdateArgs = mockUsageCounterUpdateMany.mock.calls[0][0];
    expect(counterUpdateArgs.where.pausedForOverageAt).toBeNull();

    // Client pause must use the status:"active" guard
    expect(mockClientUpdateMany).toHaveBeenCalledOnce();
    const clientUpdateArgs = mockClientUpdateMany.mock.calls[0][0];
    expect(clientUpdateArgs.where.status).toBe("active");
    expect(clientUpdateArgs.data.status).toBe("paused");
  });

  it("returns allowed=false and triggers auto-pause when costUsd >= capUsd", async () => {
    mockUsageCounterUpsert.mockResolvedValue({
      callsUsed: 10,
      callsIncluded: 100,
      costUsd: 10.0,
      capUsd: 10.0,
      pausedForOverageAt: null,
    });

    mockUsageCounterUpdateMany.mockResolvedValue({ count: 1 });
    mockClientUpdateMany.mockResolvedValue({ count: 1 });

    const { checkCap } = await import("@/lib/usage");
    const result = await checkCap("client-over-cost");

    expect(result.allowed).toBe(false);
    expect(mockClientUpdateMany).toHaveBeenCalledOnce();
  });

  it("auto-pause is idempotent — does NOT re-pause when pausedForOverageAt is already set", async () => {
    mockUsageCounterUpsert.mockResolvedValue({
      callsUsed: 100,
      callsIncluded: 100,
      costUsd: 10.0,
      capUsd: 10.0,
      pausedForOverageAt: new Date(), // already stamped this month
    });

    const { checkCap } = await import("@/lib/usage");
    const result = await checkCap("client-already-paused");

    expect(result.allowed).toBe(false);
    // enactOveragePause must NOT be called (guard: pausedForOverageAt != null)
    expect(mockUsageCounterUpdateMany).not.toHaveBeenCalled();
    expect(mockClientUpdateMany).not.toHaveBeenCalled();
  });

  it("allowed=true when exactly one below the call cap (strict < check)", async () => {
    mockUsageCounterUpsert.mockResolvedValue({
      callsUsed: 99,
      callsIncluded: 100,
      costUsd: 0.0,
      capUsd: 10.0,
      pausedForOverageAt: null,
    });

    const { checkCap } = await import("@/lib/usage");
    const result = await checkCap("client-one-below");

    expect(result.allowed).toBe(true);
    expect(mockUsageCounterUpdateMany).not.toHaveBeenCalled();
  });

  it("when concurrent second request finds count=0 after stamp, skips client pause", async () => {
    mockUsageCounterUpsert.mockResolvedValue({
      callsUsed: 100,
      callsIncluded: 100,
      costUsd: 2.0,
      capUsd: 10.0,
      pausedForOverageAt: null,
    });

    // Simulate the concurrent request — stamped.count = 0 (another req already stamped)
    mockUsageCounterUpdateMany.mockResolvedValue({ count: 0 });

    const { checkCap } = await import("@/lib/usage");
    const result = await checkCap("client-concurrent");

    expect(result.allowed).toBe(false);
    expect(mockUsageCounterUpdateMany).toHaveBeenCalledOnce();
    // Client updateMany must NOT be called when count=0
    expect(mockClientUpdateMany).not.toHaveBeenCalled();
  });
});

describe("Usage metering — recordUsage (Priority 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments calls and costUsd atomically", async () => {
    mockUsageCounterUpsert.mockResolvedValue({
      callsUsed: 51,
      callsIncluded: 100,
      costUsd: 5.5,
      capUsd: 10.0,
      alerted80At: null,
    });

    const { recordUsage } = await import("@/lib/usage");
    await recordUsage("client-record", { calls: 1, costUsd: 0.005 });

    // The upsert update payload must use increment
    const upsertCall = mockUsageCounterUpsert.mock.calls[0][0];
    expect(upsertCall.update.callsUsed).toEqual({ increment: 1 });
    expect(upsertCall.update.costUsd).toEqual({ increment: 0.005 });
  });

  it("fires 80% alert when call usage crosses 80% and alerted80At is null", async () => {
    // callsUsed=80, callsIncluded=100 → 80% exactly
    mockUsageCounterUpsert.mockResolvedValue({
      callsUsed: 80,
      callsIncluded: 100,
      costUsd: 1.0,
      capUsd: 10.0,
      alerted80At: null,
    });

    // updateMany stamp succeeds → alert should fire
    mockUsageCounterUpdateMany.mockResolvedValue({ count: 1 });

    const { recordUsage } = await import("@/lib/usage");
    await recordUsage("client-80pct", { calls: 1, costUsd: 0.001 });

    expect(mockUsageCounterUpdateMany).toHaveBeenCalledOnce();
    const updateArgs = mockUsageCounterUpdateMany.mock.calls[0][0];
    // Must guard with alerted80At: null (idempotency)
    expect(updateArgs.where.alerted80At).toBeNull();
  });

  it("does NOT fire 80% alert when alerted80At is already set (idempotent)", async () => {
    mockUsageCounterUpsert.mockResolvedValue({
      callsUsed: 85,
      callsIncluded: 100,
      costUsd: 8.5,
      capUsd: 10.0,
      alerted80At: new Date(), // already alerted this month
    });

    const { recordUsage } = await import("@/lib/usage");
    await recordUsage("client-already-alerted", { calls: 1, costUsd: 0.01 });

    expect(mockUsageCounterUpdateMany).not.toHaveBeenCalled();
  });

  it("does NOT fire 80% alert when usage is below 80%", async () => {
    mockUsageCounterUpsert.mockResolvedValue({
      callsUsed: 79,
      callsIncluded: 100,
      costUsd: 0.5,
      capUsd: 10.0,
      alerted80At: null,
    });

    const { recordUsage } = await import("@/lib/usage");
    await recordUsage("client-under-80", { calls: 1, costUsd: 0.001 });

    expect(mockUsageCounterUpdateMany).not.toHaveBeenCalled();
  });
});
