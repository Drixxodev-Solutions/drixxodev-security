/**
 * tests/llm.test.ts — Priority 5: LLM router failover
 *
 * Tests runLLM:
 *   - Primary (Anthropic) success path → returns provider="anthropic", correct cost
 *   - Primary transient failure → retry once → still failing → fallback to OpenAI
 *   - OpenAI fallback success → provider="openai", model="gpt-4o-mini", correct cost
 *   - Non-transient error (JSON parse failure) → throws immediately, OpenAI NOT called
 *   - Non-transient error (auth/401) → throws immediately, no failover
 *   - Transient classifier: model name "claude-haiku-4-5" alone is NOT transient
 *   - Both providers fail → throws last error
 *
 * All Anthropic and OpenAI SDKs are mocked — no real API calls (§7.3).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the Anthropic and OpenAI SDKs before importing runLLM
// The mocks must export proper constructors (class-like) because the source
// calls `new Anthropic({ apiKey })` and `new OpenAI({ apiKey })`.
// ---------------------------------------------------------------------------

const mockAnthropicCreate = vi.fn();
const mockOpenAICreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages: { create: typeof mockAnthropicCreate };
    constructor(_opts: unknown) {
      this.messages = { create: mockAnthropicCreate };
    }
  }
  return { default: MockAnthropic };
});

vi.mock("openai", () => {
  class MockOpenAI {
    chat: { completions: { create: typeof mockOpenAICreate } };
    constructor(_opts: unknown) {
      this.chat = { completions: { create: mockOpenAICreate } };
    }
  }
  return { default: MockOpenAI };
});

// ---------------------------------------------------------------------------
// Helpers to build mock responses
// ---------------------------------------------------------------------------

function anthropicSuccess(json: object, model = "claude-haiku-4-5-20251001") {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
    usage: { input_tokens: 100, output_tokens: 50 },
    model,
  };
}

function openaiSuccess(json: object) {
  return {
    choices: [{ message: { content: JSON.stringify(json) } }],
    usage: { prompt_tokens: 80, completion_tokens: 40 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LLM router — runLLM (Priority 5)", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-key-for-testing";
    process.env.OPENAI_API_KEY = "sk-openai-fake-key-for-testing";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it("returns result from Anthropic (primary) on success with correct provider + cost", async () => {
    const responseJson = { category: "sales", urgency: "high", summary: "Test" };
    mockAnthropicCreate.mockResolvedValue(anthropicSuccess(responseJson));

    const { runLLM } = await import("@/lib/llm");
    const result = await runLLM({ prompt: "test prompt" });

    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.data).toEqual(responseJson);
    expect(result.tokensUsed).toBe(150); // 100 + 50
    // Cost: (100 * 0.8 + 50 * 4.0) / 1_000_000 = (80 + 200) / 1_000_000 = 0.00028
    expect(result.costUsd).toBeCloseTo(0.00028, 8);
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  it("falls back to OpenAI after primary transient failure (retry-once pattern)", async () => {
    // Both Anthropic attempts fail with 529 (transient)
    const transientError = new Error("API error 529: overloaded");
    mockAnthropicCreate.mockRejectedValue(transientError);

    const openaiJson = { category: "support", urgency: "low", summary: "Fallback" };
    mockOpenAICreate.mockResolvedValue(openaiSuccess(openaiJson));

    const { runLLM } = await import("@/lib/llm");
    const result = await runLLM({ prompt: "test prompt" });

    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.data).toEqual(openaiJson);
    // Anthropic must have been called twice (attempt 1 + retry)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    expect(mockOpenAICreate).toHaveBeenCalledOnce();
  });

  it("computes cost from gpt-4o-mini pricing when OpenAI fallback is used", async () => {
    mockAnthropicCreate.mockRejectedValue(new Error("500 internal server error"));
    mockOpenAICreate.mockResolvedValue(openaiSuccess({ result: "ok" }));

    const { runLLM } = await import("@/lib/llm");
    const result = await runLLM({ prompt: "cost test" });

    expect(result.provider).toBe("openai");
    // Cost: (80 * 0.15 + 40 * 0.60) / 1_000_000 = (12 + 24) / 1_000_000 = 0.000036
    expect(result.costUsd).toBeCloseTo(0.000036, 8);
    expect(result.tokensUsed).toBe(120); // 80 + 40
  });

  it("does NOT retry or failover on non-transient JSON parse failure (OpenAI NOT called)", async () => {
    // Model returns valid 200 but unparseable JSON (non-transient)
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "this is not json at all !!!" }],
      usage: { input_tokens: 50, output_tokens: 20 },
    });

    const { runLLM } = await import("@/lib/llm");
    await expect(runLLM({ prompt: "bad json test" })).rejects.toThrow(
      /unparseable json|parse error/i
    );

    // Anthropic called only once (no retry on non-transient)
    expect(mockAnthropicCreate).toHaveBeenCalledOnce();
    // OpenAI must NEVER be called for non-transient errors
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  it("does NOT retry or failover on auth error (401 / unauthorized)", async () => {
    mockAnthropicCreate.mockRejectedValue(
      new Error("401 Unauthorized: invalid api_key")
    );

    const { runLLM } = await import("@/lib/llm");
    await expect(runLLM({ prompt: "auth error test" })).rejects.toThrow(
      /401|unauthorized/i
    );

    expect(mockAnthropicCreate).toHaveBeenCalledOnce();
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  it("does NOT treat model name 'claude-haiku-4-5' digit alone as transient (regression guard)", async () => {
    // The bug this prevents: if isTransientError used includes("5") or includes("4-5")
    // it would classify "claude-haiku-4-5" model name errors as transient by accident.
    // Test: an error message containing a 400 bad_request that also mentions the model name
    // must be classified non-transient (400 check comes before any digit check).
    mockAnthropicCreate.mockRejectedValue(
      new Error("400 bad request: model claude-haiku-4-5 not available in your region")
    );

    const { runLLM } = await import("@/lib/llm");
    await expect(runLLM({ prompt: "regression guard test" })).rejects.toThrow(/400|bad request/i);

    // Non-transient (400): must not retry and must not call OpenAI
    expect(mockAnthropicCreate).toHaveBeenCalledOnce();
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  it("throws last error when both providers exhausted on transient failures", async () => {
    const transientError = new Error("503 service unavailable");
    mockAnthropicCreate.mockRejectedValue(transientError);
    mockOpenAICreate.mockRejectedValue(new Error("529 openai overloaded"));

    const { runLLM } = await import("@/lib/llm");
    await expect(runLLM({ prompt: "all fail" })).rejects.toThrow(/529|overloaded/i);

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2); // attempt + retry
    expect(mockOpenAICreate).toHaveBeenCalledTimes(2); // attempt + retry
  });

  it("supports model override for primary provider", async () => {
    const overrideModel = "claude-sonnet-4-5-20251001";
    mockAnthropicCreate.mockResolvedValue(anthropicSuccess({ answer: 42 }, overrideModel));

    const { runLLM } = await import("@/lib/llm");
    const result = await runLLM({ prompt: "expensive model test", model: overrideModel });

    expect(result.model).toBe(overrideModel);
    const callArgs = mockAnthropicCreate.mock.calls[0][0];
    expect(callArgs.model).toBe(overrideModel);
  });

  it("throws when ANTHROPIC_API_KEY is missing (config error, not transient, no failover)", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const { runLLM } = await import("@/lib/llm");
    await expect(runLLM({ prompt: "missing key test" })).rejects.toThrow(
      /ANTHROPIC_API_KEY.*not set/i
    );

    // Key error is non-transient — OpenAI must NOT be called
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  it("strips markdown code fences and parses the inner JSON", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: '```json\n{"ok": true}\n```' }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });

    const { runLLM } = await import("@/lib/llm");
    const result = await runLLM({ prompt: "code fence test" });

    expect(result.data).toEqual({ ok: true });
  });
});
