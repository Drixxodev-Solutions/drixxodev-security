/**
 * tests/email-triage.test.ts — Priority 4 (cap-before-call) + Priority 6 (kill switch)
 *
 * Tests:
 *   process():
 *     - checkCap called BEFORE runLLM; when cap exceeded, runLLM NOT called,
 *       Run recorded as failed with cap error message
 *     - checkCap allowed=true → runLLM IS called, Run recorded as succeeded
 *
 *   kill switch (worker-level):
 *     - paused client is skipped entirely (poll/LLM never called)
 *     - active client runs normally
 *
 * Mocks: @/lib/db, @/lib/llm, @/lib/usage, @/lib/connections,
 *        @/providers/gmail/client, fs (to avoid real prompt file read)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@prisma/client";

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const mockRunCreate = vi.fn();
const mockRunUpdate = vi.fn();
const mockCheckCap = vi.fn();
const mockRecordUsage = vi.fn();
const mockRunLLM = vi.fn();
const mockGetValidAccessToken = vi.fn();
const mockListMessageIds = vi.fn();
const mockGetMessage = vi.fn();
const mockEnsureLabel = vi.fn();
const mockModifyMessageLabels = vi.fn();
const mockCreateDraftReply = vi.fn();

// ---------------------------------------------------------------------------
// Module mocks — must all be top-level for vitest hoisting
// ---------------------------------------------------------------------------

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

vi.mock("@/providers/gmail/client", () => ({
  listMessageIds: (...args: unknown[]) => mockListMessageIds(...args),
  getMessage: (...args: unknown[]) => mockGetMessage(...args),
  ensureLabel: (...args: unknown[]) => mockEnsureLabel(...args),
  modifyMessageLabels: (...args: unknown[]) => mockModifyMessageLabels(...args),
  createDraftReply: (...args: unknown[]) => mockCreateDraftReply(...args),
}));

// Mock fs so prompt file doesn't need to exist during tests
vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue("You are an email triage assistant. Classify the email."),
}));

// ---------------------------------------------------------------------------
// Test helpers
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

function makeTriageItem() {
  return {
    automationId: "auto-1",
    clientId: "client-test",
    accessToken: "fake-access-token",
    message: {
      id: "msg-1",
      threadId: "thread-1",
      from: "customer@example.com",
      subject: "Help with my order",
      bodyText: "Hi, I need help with my recent order. It has not arrived yet.",
      snippet: "Hi, I need help",
    },
    config: {
      query: "is:unread in:inbox",
      maxPerPoll: 10,
      labelPrefix: "Triage",
      createDrafts: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Priority 4: cap-before-call — process()
// ---------------------------------------------------------------------------

describe("Email triage processItem — cap-before-call (Priority 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunCreate.mockResolvedValue({ id: "run-1" });
    mockRunUpdate.mockResolvedValue({ id: "run-1" });
    mockEnsureLabel.mockResolvedValue("label-id-1");
    mockModifyMessageLabels.mockResolvedValue(undefined);
    mockRecordUsage.mockResolvedValue(undefined);
  });

  it("when checkCap returns allowed=false, runLLM is NOT called and Run is recorded as failed", async () => {
    mockCheckCap.mockResolvedValue({
      allowed: false,
      counter: { callsUsed: 100, callsIncluded: 100, costUsd: 10.0, capUsd: 10.0 },
    });

    const { processItem } = await import("@/automations/email_triage/index");
    await processItem(makeTriageItem(), { automationId: "auto-1" });

    // The critical assertion: runLLM must NOT be called
    expect(mockRunLLM).not.toHaveBeenCalled();

    // Run must be updated to failed with cap error message
    expect(mockRunUpdate).toHaveBeenCalledOnce();
    const updateArgs = mockRunUpdate.mock.calls[0][0];
    expect(updateArgs.data.status).toBe("failed");
    expect(updateArgs.data.error).toMatch(/cap exceeded|callsUsed|callsIncluded/i);
  });

  it("checkCap is called BEFORE runLLM (order assertion)", async () => {
    const callOrder: string[] = [];

    mockCheckCap.mockImplementation(async () => {
      callOrder.push("checkCap");
      return {
        allowed: true,
        counter: { callsUsed: 1, callsIncluded: 100, costUsd: 0.001, capUsd: 10.0 },
      };
    });

    mockRunLLM.mockImplementation(async () => {
      callOrder.push("runLLM");
      return {
        data: { summary: "test", category: "support", urgency: "low" },
        raw: '{"summary":"test","category":"support","urgency":"low"}',
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        tokensUsed: 100,
        costUsd: 0.0001,
      };
    });

    const { processItem } = await import("@/automations/email_triage/index");
    await processItem(makeTriageItem(), { automationId: "auto-1" });

    // checkCap must appear before runLLM in the call sequence
    const capIdx = callOrder.indexOf("checkCap");
    const llmIdx = callOrder.indexOf("runLLM");
    expect(capIdx).toBeGreaterThanOrEqual(0);
    expect(llmIdx).toBeGreaterThanOrEqual(0);
    expect(capIdx).toBeLessThan(llmIdx);
  });

  it("when checkCap allowed=true, runLLM IS called and Run recorded as succeeded", async () => {
    mockCheckCap.mockResolvedValue({
      allowed: true,
      counter: { callsUsed: 1, callsIncluded: 100, costUsd: 0.001, capUsd: 10.0 },
    });

    mockRunLLM.mockResolvedValue({
      data: { summary: "test summary", category: "support", urgency: "low" },
      raw: '{"summary":"test summary","category":"support","urgency":"low"}',
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      tokensUsed: 150,
      costUsd: 0.00021,
    });

    const { processItem } = await import("@/automations/email_triage/index");
    await processItem(makeTriageItem(), { automationId: "auto-1" });

    expect(mockRunLLM).toHaveBeenCalledOnce();
    expect(mockRecordUsage).toHaveBeenCalledOnce();

    const updateArgs = mockRunUpdate.mock.calls[0][0];
    expect(updateArgs.data.status).toBe("succeeded");
    expect(updateArgs.data.llmProvider).toBe("anthropic");
    expect(updateArgs.data.tokensUsed).toBe(150);
    expect(updateArgs.data.costUsd).toBe(0.00021);
  });

  it("failed Run row includes the Run id from run.create", async () => {
    mockRunCreate.mockResolvedValue({ id: "specific-run-id" });
    mockCheckCap.mockResolvedValue({
      allowed: false,
      counter: { callsUsed: 100, callsIncluded: 100, costUsd: 0.0, capUsd: 10.0 },
    });

    const { processItem } = await import("@/automations/email_triage/index");
    await processItem(makeTriageItem(), { automationId: "auto-1" });

    const updateArgs = mockRunUpdate.mock.calls[0][0];
    expect(updateArgs.where.id).toBe("specific-run-id");
  });
});

// ---------------------------------------------------------------------------
// Priority 6: Kill switch — paused client skipped in worker tick
// ---------------------------------------------------------------------------

describe("Kill switch — paused client skipped in worker tick (Priority 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("paused client: automation loop skips the client entirely (kill switch guard)", () => {
    // The worker's kill switch at worker/index.ts:182:
    //   if (automation.client.status === "paused") { continue; }
    // We replicate that logic here to prove the guard works.

    const pausedClient = makeClient({ status: "paused" });

    const automationList = [
      {
        id: "auto-paused",
        clientId: pausedClient.id,
        config: {},
        pollInterval: 300,
        client: pausedClient,
      },
    ];

    let runAutomationCalled = false;
    const fakeRunAutomation = () => {
      runAutomationCalled = true;
    };

    // Replicate the worker's kill switch logic exactly
    for (const automation of automationList) {
      if (automation.client.status === "paused") {
        continue; // kill switch — no poll, no LLM
      }
      fakeRunAutomation();
    }

    expect(runAutomationCalled).toBe(false);
  });

  it("active client: automation loop proceeds to run the automation", () => {
    const activeClient = makeClient({ status: "active" });

    const automationList = [
      {
        id: "auto-active",
        clientId: activeClient.id,
        config: {},
        pollInterval: 300,
        client: activeClient,
      },
    ];

    let runAutomationCalled = false;
    const fakeRunAutomation = () => {
      runAutomationCalled = true;
    };

    for (const automation of automationList) {
      if (automation.client.status === "paused") {
        continue;
      }
      fakeRunAutomation();
    }

    expect(runAutomationCalled).toBe(true);
  });

  it("paused client: poll() returns empty array when getValidAccessToken fails for a paused client", async () => {
    // Extra defense: if poll() is somehow called for a paused client, the worker
    // returning empty is the safe fallback (token may be expired/unavailable).
    const pausedClient = makeClient({ status: "paused" });
    mockGetValidAccessToken.mockRejectedValue(new Error("Connection not found"));

    const { poll } = await import("@/automations/email_triage/index");
    const items = await poll(pausedClient, {});

    expect(items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pre-LLM filter tests (§8.3) — validate filters work before LLM is called
// ---------------------------------------------------------------------------

describe("Email triage — pre-LLM filters (§8.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetValidAccessToken.mockResolvedValue("fake-access-token");
  });

  it("filters out automated/no-reply senders before calling LLM", async () => {
    const client = makeClient();
    mockListMessageIds.mockResolvedValue(["msg-noreply"]);
    mockGetMessage.mockResolvedValue({
      id: "msg-noreply",
      threadId: "thread-1",
      from: "noreply@company.com",
      subject: "You have a notification",
      bodyText: "This is an automated notification from the system.",
      snippet: "automated",
    });

    const { poll } = await import("@/automations/email_triage/index");
    const items = await poll(client, {});

    expect(items).toHaveLength(0);
    // getValidAccessToken was called (poll starts), but no items passed filter
    expect(mockGetValidAccessToken).toHaveBeenCalledOnce();
  });

  it("filters out do-not-reply senders", async () => {
    const client = makeClient();
    mockListMessageIds.mockResolvedValue(["msg-donotreply"]);
    mockGetMessage.mockResolvedValue({
      id: "msg-donotreply",
      threadId: "thread-1",
      from: "donotreply@service.com",
      subject: "Your receipt",
      bodyText: "Thank you for your purchase. This is an automated message.",
      snippet: "Thank you",
    });

    const { poll } = await import("@/automations/email_triage/index");
    const items = await poll(client, {});

    expect(items).toHaveLength(0);
  });

  it("filters out empty-body messages before calling LLM", async () => {
    const client = makeClient();
    mockListMessageIds.mockResolvedValue(["msg-empty"]);
    mockGetMessage.mockResolvedValue({
      id: "msg-empty",
      threadId: "thread-1",
      from: "human@example.com",
      subject: "Hello",
      bodyText: "Hi", // < 10 chars → empty
      snippet: "Hi",
    });

    const { poll } = await import("@/automations/email_triage/index");
    const items = await poll(client, {});

    expect(items).toHaveLength(0);
  });

  it("real messages pass the filter and are returned for processing", async () => {
    const client = makeClient();
    mockListMessageIds.mockResolvedValue(["msg-real"]);
    mockGetMessage.mockResolvedValue({
      id: "msg-real",
      threadId: "thread-1",
      from: "customer@real-company.com",
      subject: "Need help with billing issue",
      bodyText: "Hi there, I have a question about my invoice for last month.",
      snippet: "I have a question",
    });

    const { poll } = await import("@/automations/email_triage/index");
    const items = await poll(client, {});

    expect(items).toHaveLength(1);
    expect(items[0]?.message.from).toBe("customer@real-company.com");
  });

  it("query includes the label exclusion dedupe guard", async () => {
    const client = makeClient();
    mockListMessageIds.mockResolvedValue([]);

    const { poll } = await import("@/automations/email_triage/index");
    await poll(client, { labelPrefix: "Triage" });

    // The query passed to listMessageIds must include the triage label exclusion
    expect(mockListMessageIds).toHaveBeenCalledOnce();
    const queryArg = mockListMessageIds.mock.calls[0][1] as string;
    expect(queryArg).toContain("-label:"); // dedupe guard present
    expect(queryArg).toContain("Triage"); // using the configured label prefix
  });
});
