/**
 * tests/meeting-prep.test.ts — meeting_prep poll filters/dedupe + cap-before-call.
 *
 * Tests:
 *   poll():
 *     - already-prepped events (dedupe marker) are skipped (§8.4)
 *     - low-value events (no title, or title with no attendees/agenda) skipped (§8.3)
 *     - worthy events are returned for processing
 *     - returns [] when the access token can't be obtained
 *   processItem():
 *     - checkCap BEFORE runLLM; cap exceeded → runLLM NOT called, Run failed
 *     - allowed=true → runLLM called, event patched, usage recorded, Run succeeded
 *
 * Mocks: @/lib/db, @/lib/llm, @/lib/usage, @/lib/connections,
 *        @/providers/gcal/client, fs (to avoid a real prompt file read).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@prisma/client";

const mockRunCreate = vi.fn();
const mockRunUpdate = vi.fn();
const mockCheckCap = vi.fn();
const mockRecordUsage = vi.fn();
const mockRunLLM = vi.fn();
const mockGetValidAccessToken = vi.fn();
const mockListUpcomingEvents = vi.fn();
const mockPatchEventPrep = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    run: {
      create: (...args: unknown[]) => mockRunCreate(...args),
      update: (...args: unknown[]) => mockRunUpdate(...args),
    },
  },
}));

vi.mock("@/lib/llm", () => ({
  runLLM: (...args: unknown[]) => mockRunLLM(...args),
}));

vi.mock("@/lib/usage", () => ({
  checkCap: (...args: unknown[]) => mockCheckCap(...args),
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}));

vi.mock("@/lib/connections", () => ({
  getValidAccessToken: (...args: unknown[]) => mockGetValidAccessToken(...args),
}));

vi.mock("@/providers/gcal/client", () => ({
  listUpcomingEvents: (...args: unknown[]) => mockListUpcomingEvents(...args),
  patchEventPrep: (...args: unknown[]) => mockPatchEventPrep(...args),
  PREP_MARKER_KEY: "drixxoMeetingPrep",
  PREP_MARKER_VALUE: "v1",
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue("You are a meeting prep assistant. Prepare the meeting."),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: "client-test",
    name: "Test Client",
    contactEmail: "test@example.com",
    status: "active",
    plan: "starter",
    createdAt: new Date(),
    ...overrides,
  } as Client;
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    summary: "Quarterly review with Acme",
    description: "Discuss Q2 numbers and renewal.",
    startISO: new Date(Date.now() + 3600_000).toISOString(),
    attendees: ["alice@acme.com", "bob@acme.com"],
    hasPrep: false,
    ...overrides,
  };
}

function makePrepItem() {
  return {
    clientId: "client-test",
    accessToken: "fake-access-token",
    event: makeEvent(),
    config: { calendarId: "primary", lookaheadHours: 48, maxPerPoll: 10 },
  };
}

// ---------------------------------------------------------------------------
// poll()
// ---------------------------------------------------------------------------

describe("meeting_prep poll — dedupe + filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetValidAccessToken.mockResolvedValue("fake-access-token");
  });

  it("skips events already carrying the prep marker (§8.4 dedupe)", async () => {
    mockListUpcomingEvents.mockResolvedValue([makeEvent({ hasPrep: true })]);

    const { poll } = await import("@/automations/meeting_prep/index");
    const items = await poll(makeClient(), {});

    expect(items).toHaveLength(0);
  });

  it("skips low-value events: title but no attendees and no agenda (§8.3)", async () => {
    mockListUpcomingEvents.mockResolvedValue([
      makeEvent({ summary: "Focus block", attendees: [], description: "" }),
    ]);

    const { poll } = await import("@/automations/meeting_prep/index");
    const items = await poll(makeClient(), {});

    expect(items).toHaveLength(0);
  });

  it("skips untitled events even if they have attendees", async () => {
    mockListUpcomingEvents.mockResolvedValue([
      makeEvent({ summary: "", attendees: ["x@y.com"] }),
    ]);

    const { poll } = await import("@/automations/meeting_prep/index");
    const items = await poll(makeClient(), {});

    expect(items).toHaveLength(0);
  });

  it("returns worthy events (title + attendees) for processing", async () => {
    mockListUpcomingEvents.mockResolvedValue([makeEvent()]);

    const { poll } = await import("@/automations/meeting_prep/index");
    const items = await poll(makeClient(), {});

    expect(items).toHaveLength(1);
    expect(items[0]?.event.id).toBe("evt-1");
  });

  it("keeps a titled event that has an agenda even with no attendees", async () => {
    mockListUpcomingEvents.mockResolvedValue([
      makeEvent({ attendees: [], description: "Agenda: review the roadmap draft." }),
    ]);

    const { poll } = await import("@/automations/meeting_prep/index");
    const items = await poll(makeClient(), {});

    expect(items).toHaveLength(1);
  });

  it("returns [] when the access token can't be obtained", async () => {
    mockGetValidAccessToken.mockRejectedValue(new Error("no connection"));

    const { poll } = await import("@/automations/meeting_prep/index");
    const items = await poll(makeClient(), {});

    expect(items).toHaveLength(0);
    expect(mockListUpcomingEvents).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processItem() — cap-before-call
// ---------------------------------------------------------------------------

describe("meeting_prep processItem — cap-before-call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunCreate.mockResolvedValue({ id: "run-1" });
    mockRunUpdate.mockResolvedValue({ id: "run-1" });
    mockPatchEventPrep.mockResolvedValue(undefined);
    mockRecordUsage.mockResolvedValue(undefined);
  });

  it("cap exceeded → runLLM NOT called, event NOT patched, Run failed", async () => {
    mockCheckCap.mockResolvedValue({
      allowed: false,
      counter: { callsUsed: 100, callsIncluded: 100, costUsd: 10, capUsd: 10 },
    });

    const { processItem } = await import("@/automations/meeting_prep/index");
    await processItem(makePrepItem(), { automationId: "auto-1" });

    expect(mockRunLLM).not.toHaveBeenCalled();
    expect(mockPatchEventPrep).not.toHaveBeenCalled();
    const updateArgs = mockRunUpdate.mock.calls[0][0];
    expect(updateArgs.data.status).toBe("failed");
    expect(updateArgs.data.error).toMatch(/cap exceeded/i);
  });

  it("checkCap runs BEFORE runLLM (order assertion)", async () => {
    const order: string[] = [];
    mockCheckCap.mockImplementation(async () => {
      order.push("checkCap");
      return {
        allowed: true,
        counter: { callsUsed: 1, callsIncluded: 100, costUsd: 0.01, capUsd: 10 },
      };
    });
    mockRunLLM.mockImplementation(async () => {
      order.push("runLLM");
      return {
        data: { summary: "s", agenda: ["a"], talkingPoints: ["t"], questions: ["q"] },
        raw: "{}",
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        tokensUsed: 100,
        costUsd: 0.0001,
      };
    });

    const { processItem } = await import("@/automations/meeting_prep/index");
    await processItem(makePrepItem(), { automationId: "auto-1" });

    expect(order.indexOf("checkCap")).toBeLessThan(order.indexOf("runLLM"));
  });

  it("allowed=true → runLLM called, event patched, usage recorded, Run succeeded", async () => {
    mockCheckCap.mockResolvedValue({
      allowed: true,
      counter: { callsUsed: 1, callsIncluded: 100, costUsd: 0.01, capUsd: 10 },
    });
    mockRunLLM.mockResolvedValue({
      data: {
        summary: "Align on renewal.",
        agenda: ["Review Q2", "Discuss renewal"],
        talkingPoints: ["Upsell tier"],
        questions: ["What's their budget?"],
      },
      raw: "{}",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      tokensUsed: 220,
      costUsd: 0.0003,
    });

    const { processItem } = await import("@/automations/meeting_prep/index");
    await processItem(makePrepItem(), { automationId: "auto-1" });

    expect(mockRunLLM).toHaveBeenCalledOnce();
    expect(mockPatchEventPrep).toHaveBeenCalledOnce();
    expect(mockRecordUsage).toHaveBeenCalledOnce();

    // The patched description should carry the prep block and keep the original.
    const patchArgs = mockPatchEventPrep.mock.calls[0][1];
    expect(patchArgs.newDescription).toContain("Meeting prep");
    expect(patchArgs.newDescription).toContain("Discuss Q2 numbers"); // original kept

    const updateArgs = mockRunUpdate.mock.calls[0][0];
    expect(updateArgs.data.status).toBe("succeeded");
    expect(updateArgs.data.tokensUsed).toBe(220);
    expect(updateArgs.data.costUsd).toBe(0.0003);
  });

  it("rejects a malformed LLM result (missing arrays) → Run failed, no patch", async () => {
    mockCheckCap.mockResolvedValue({
      allowed: true,
      counter: { callsUsed: 1, callsIncluded: 100, costUsd: 0.01, capUsd: 10 },
    });
    mockRunLLM.mockResolvedValue({
      data: { summary: "only a summary, no lists" },
      raw: "{}",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      tokensUsed: 50,
      costUsd: 0.0001,
    });

    const { processItem } = await import("@/automations/meeting_prep/index");
    await processItem(makePrepItem(), { automationId: "auto-1" });

    expect(mockPatchEventPrep).not.toHaveBeenCalled();
    const updateArgs = mockRunUpdate.mock.calls[0][0];
    expect(updateArgs.data.status).toBe("failed");
  });
});
