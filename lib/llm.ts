/**
 * lib/llm.ts — LLM Router (§6.3)
 *
 * Single interface for all LLM calls across the platform.
 * - Default model: claude-haiku-4-5-20251001 (cheapest capable Anthropic model, §8.1)
 * - Failover: Anthropic (primary) → retry once after 500ms → OpenAI (secondary)
 * - JSON-only responses; safe parsing with code-fence stripping
 * - Each provider carries its own defaultModel; cost is computed from the model actually used
 * - Pricing table for cost accounting logged to Run rows (§6.3)
 * TODO(M4): externalise MODEL_PRICING into config/env so it can be updated without a deploy.
 *
 * Security:
 * - API keys read at CALL time, never at module load (§7.3, §7.4)
 * - Prompt content is never logged
 * - API keys are never logged
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LLMInput {
  /** User/human turn content (the email body, task description, etc.) */
  prompt: string;
  /** Optional system instruction override. Defaults to JSON-only instruction. */
  system?: string;
  /**
   * Model override — applies to the PRIMARY (Anthropic) provider only.
   * On failover to OpenAI the secondary provider uses its own defaultModel.
   * Defaults to DEFAULT_MODEL (cheap Haiku).
   */
  model?: string;
  /** Max output tokens. Defaults to 1024. */
  maxTokens?: number;
}

export interface LLMResult {
  /** Parsed JSON output from the model */
  data: unknown;
  /** Raw string response before parsing (for debugging — no PII logged) */
  raw: string;
  /** Provider used, e.g. "anthropic" or "openai" */
  provider: string;
  /** Model ID actually used (may differ from input.model on failover) */
  model: string;
  /** Total tokens consumed (input + output) */
  tokensUsed: number;
  /** Computed cost in USD based on pricing table */
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Model config & pricing
// ---------------------------------------------------------------------------

/**
 * Default to claude-haiku-4-5-20251001 — the cheapest capable Anthropic model
 * for classification/extraction tasks (§8.1). Override per-automation for
 * prompts that genuinely need stronger reasoning (e.g. complex multi-step).
 */
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * OpenAI cheap fallback model for M3 failover.
 * gpt-4o-mini is the cheapest capable OpenAI chat model that supports
 * response_format: json_object (released 2024-07; $0.15 input / $0.60 output per 1M tokens).
 * Source: OpenAI pricing page (as of 2026-06).
 */
export const OPENAI_FALLBACK_MODEL = "gpt-4o-mini";

/**
 * Per-model pricing table (USD per million tokens).
 * Sources documented per entry below.
 * TODO(M4): externalise into config/env so rates can be updated without a deploy.
 */
const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  // Anthropic — source: https://www.anthropic.com/pricing (2026-06)
  "claude-haiku-4-5-20251001": { inputPerM: 0.8, outputPerM: 4.0 },
  "claude-sonnet-4-5-20251001": { inputPerM: 3.0, outputPerM: 15.0 },
  // OpenAI — source: https://openai.com/api/pricing/ (2026-06)
  // gpt-4o-mini: $0.15 / $0.60 per 1M tokens — cheapest OpenAI tier with json_object
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.60 },
  // Fallback for unknown models — use Haiku rates to avoid under-charging
  _default: { inputPerM: 0.8, outputPerM: 4.0 },
};

function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const rates = MODEL_PRICING[model] ?? MODEL_PRICING["_default"]!;
  return (inputTokens * rates.inputPerM + outputTokens * rates.outputPerM) / 1_000_000;
}

// ---------------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------------

/**
 * Strips markdown code fences (```json ... ``` or ``` ... ```) from a string
 * and extracts the first JSON object or array.
 * Returns the cleaned string ready for JSON.parse.
 */
function extractJson(raw: string): string {
  // Remove code fences
  const cleaned = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim();

  // Find the first { or [ and last matching bracket
  const start = cleaned.search(/[{[]/);
  if (start === -1) {
    return cleaned; // let JSON.parse fail with a clear message
  }
  const openChar = cleaned[start];
  const closeChar = openChar === "{" ? "}" : "]";
  const end = cleaned.lastIndexOf(closeChar);
  if (end === -1) {
    return cleaned;
  }
  return cleaned.slice(start, end + 1);
}

function safeParseJson(raw: string): unknown {
  const extracted = extractJson(raw);
  try {
    return JSON.parse(extracted);
  } catch (err) {
    throw new Error(
      `LLM returned unparseable JSON. Parse error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Error classification — retry/failover vs hard-fail
// ---------------------------------------------------------------------------

/**
 * Returns true for errors that are worth retrying or failing over (transient):
 *   - Network / connection errors (ECONNRESET, ENOTFOUND, ETIMEDOUT, etc.)
 *   - HTTP 429 (rate limit) — retry on same provider might clear after backoff
 *   - HTTP 5xx (server errors)
 *   - Timeout errors from the SDK
 *
 * Returns false for errors that should NOT trigger retry/failover:
 *   - JSON parse failures (the model produced a syntactically bad 200 response —
 *     retrying the same provider is unlikely to help and would waste tokens).
 *   - Missing API key (configuration error — no point retrying).
 *   - HTTP 4xx other than 429 (bad request, auth error — retrying won't fix it).
 *
 * This prevents infinite provider cycling on logic/config errors (§6.3).
 */
function isTransientError(err: Error): boolean {
  const msg = err.message.toLowerCase();

  // JSON parse failure — structural issue with a valid 200; do not retry
  if (msg.includes("unparseable json") || msg.includes("parse error")) {
    return false;
  }

  // Missing API key — configuration error; do not retry
  if (msg.includes("api_key") || msg.includes("is not set")) {
    return false;
  }

  // HTTP 401/403 — auth error; do not retry
  if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") || msg.includes("forbidden")) {
    return false;
  }

  // HTTP 400 — bad request; do not retry
  if (msg.includes("400") || msg.includes("bad request") || msg.includes("invalid_request")) {
    return false;
  }

  // Transient: rate limit, server error, network issues, timeout.
  // Match HTTP 5xx precisely with a word-boundary regex — a bare `includes("5")`
  // would match the digit 5 anywhere (token counts, model names like
  // "claude-haiku-4-5", timestamps) and misclassify almost everything.
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    /\b5\d{2}\b/.test(msg) || // HTTP 500–599 (incl. 529 Anthropic overloaded)
    msg.includes("overloaded") ||
    msg.includes("server error") ||
    msg.includes("service unavailable") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("etimedout") ||
    msg.includes("network") ||
    msg.includes("socket") ||
    msg.includes("connection")
  );
}

/** Sleep for the given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

/**
 * Run a single LLM call against Anthropic.
 * Returns raw text + usage + the model actually used; caller handles JSON/cost.
 */
async function callAnthropic(
  prompt: string,
  system: string,
  model: string,
  maxTokens: number
): Promise<{ raw: string; inputTokens: number; outputTokens: number; modelUsed: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. This key is operator-held and must be in the server environment."
    );
  }

  // Instantiate per-call so the key is never captured at module load time (§7.3)
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  });

  // Extract text from the first text block
  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock?.type === "text" ? textBlock.text : "";

  return {
    raw,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    modelUsed: model,
  };
}

/**
 * Run a single LLM call against OpenAI (secondary/fallback provider).
 *
 * Always uses OPENAI_FALLBACK_MODEL (gpt-4o-mini) — the cheapest capable OpenAI
 * model with response_format: json_object support (§8.1). The input.model override
 * does NOT apply here because Anthropic model IDs are meaningless to OpenAI.
 *
 * OPENAI_API_KEY is read at CALL time, never at module load (§7.3).
 */
async function callOpenAI(
  prompt: string,
  system: string,
  _model: string, // ignored — OpenAI uses its own defaultModel (see OPENAI_FALLBACK_MODEL)
  maxTokens: number
): Promise<{ raw: string; inputTokens: number; outputTokens: number; modelUsed: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. This key is operator-held and must be in the server environment."
    );
  }

  // Instantiate per-call so the key is never captured at module load time (§7.3)
  const client = new OpenAI({ apiKey });
  const modelUsed = OPENAI_FALLBACK_MODEL;

  const response = await client.chat.completions.create({
    model: modelUsed,
    max_tokens: maxTokens,
    // response_format: json_object enforces JSON output from the model
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "";
  const usage = response.usage;

  return {
    raw,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    modelUsed,
  };
}

// ---------------------------------------------------------------------------
// Provider list (ordered; first = primary)
// Each entry carries its own defaultModel so per-provider cost is accurate.
// ---------------------------------------------------------------------------

type ProviderCallFn = (
  prompt: string,
  system: string,
  model: string,
  maxTokens: number
) => Promise<{ raw: string; inputTokens: number; outputTokens: number; modelUsed: string }>;

interface ProviderEntry {
  name: string;
  defaultModel: string;
  call: ProviderCallFn;
}

const PROVIDERS: ProviderEntry[] = [
  { name: "anthropic", defaultModel: DEFAULT_MODEL, call: callAnthropic },
  { name: "openai", defaultModel: OPENAI_FALLBACK_MODEL, call: callOpenAI },
];

// ---------------------------------------------------------------------------
// Retry config
// ---------------------------------------------------------------------------

/** Backoff (ms) before the single retry attempt on the same provider (§6.3) */
const RETRY_BACKOFF_MS = 500;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * runLLM — the single interface for all LLM calls in the platform.
 *
 * Instructs the model to respond with JSON ONLY; parses the response safely.
 * Computes cost from the pricing table using the model *actually* used.
 * Logs provider/model/tokens/cost to the console (no prompt content or keys
 * logged, per §7.2 / §7.3).
 *
 * Retry / failover strategy (§6.3):
 *   1. Try primary provider (Anthropic).
 *   2. On a TRANSIENT error (network, 429, 5xx): wait RETRY_BACKOFF_MS, retry once.
 *   3. If the retry also fails transiently: move to the secondary provider (OpenAI).
 *   4. On a NON-TRANSIENT error (JSON parse failure, auth, bad request):
 *      do NOT retry/failover — fail immediately with a clear error. Cycling
 *      providers on a parse failure would just waste tokens on the same bad output.
 *   5. If all providers are exhausted: throw the last error.
 *
 * Return shape is backward-compatible with M2 callers.
 */
export async function runLLM(input: LLMInput): Promise<LLMResult> {
  // The caller-supplied model applies only to the primary (Anthropic) provider.
  // Secondary providers use their own defaultModel.
  const primaryModel = input.model ?? DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? 1024;

  // Default system: JSON only — override only when the automation has a
  // specific system prompt that already enforces JSON.
  const system =
    input.system ??
    "You are a precise classification assistant. Respond with valid JSON only. No prose, no code fences, no explanation — just the JSON object.";

  let lastError: Error | undefined;

  for (let providerIdx = 0; providerIdx < PROVIDERS.length; providerIdx++) {
    const provider = PROVIDERS[providerIdx]!;
    // Primary provider uses the caller-supplied model; secondaries use their own default.
    const modelForProvider =
      providerIdx === 0 ? primaryModel : provider.defaultModel;

    // Attempt 1, then retry-once on transient errors before moving to next provider
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { raw, inputTokens, outputTokens, modelUsed } =
          await provider.call(input.prompt, system, modelForProvider, maxTokens);

        const tokensUsed = inputTokens + outputTokens;
        // Cost is keyed on the model *actually used* (accurate even on failover)
        const costUsd = computeCost(modelUsed, inputTokens, outputTokens);
        const data = safeParseJson(raw);

        console.log(
          `[llm] provider=${provider.name} model=${modelUsed} attempt=${attempt} ` +
            `tokens=${tokensUsed} cost=$${costUsd.toFixed(6)}`
        );

        return {
          data,
          raw,
          provider: provider.name,
          model: modelUsed,
          tokensUsed,
          costUsd,
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;

        // Never log the prompt or API key; log only non-sensitive failure info
        console.error(
          `[llm] provider=${provider.name} model=${modelForProvider} attempt=${attempt} failed: ${error.message}`
        );

        if (!isTransientError(error)) {
          // Non-transient (parse error, auth, bad request): do not retry or failover.
          // Cycling providers on a parse failure wastes tokens and won't help.
          throw error;
        }

        if (attempt === 1) {
          // First attempt failed transiently — wait, then retry the same provider once
          console.warn(
            `[llm] provider=${provider.name} transient error; retrying in ${RETRY_BACKOFF_MS}ms…`
          );
          await sleep(RETRY_BACKOFF_MS);
          // Loop continues to attempt 2
        } else {
          // Second attempt (the single retry) also failed — break out to try next provider
          console.warn(
            `[llm] provider=${provider.name} retry also failed; falling back to next provider`
          );
          break;
        }
      }
    }
  }

  throw lastError ?? new Error("All LLM providers failed.");
}
