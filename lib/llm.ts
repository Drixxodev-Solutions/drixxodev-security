/**
 * lib/llm.ts — LLM Router (§6.3)
 *
 * Single interface for all LLM calls across the platform.
 * - Default model: claude-haiku-4-5-20251001 (cheapest capable model, §8.1)
 * - JSON-only responses; safe parsing with code-fence stripping
 * - Pricing table for cost accounting logged to Run rows (§6.3)
 * - Structured for failover: Anthropic only in M2; see TODO(M3) below
 *
 * Security:
 * - ANTHROPIC_API_KEY read at CALL time, never at module load (§7.3, §7.4)
 * - Prompt content is never logged
 * - API keys are never logged
 */

import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LLMInput {
  /** User/human turn content (the email body, task description, etc.) */
  prompt: string;
  /** Optional system instruction override. Defaults to JSON-only instruction. */
  system?: string;
  /** Model override. Defaults to DEFAULT_MODEL (cheap Haiku). */
  model?: string;
  /** Max output tokens. Defaults to 1024. */
  maxTokens?: number;
}

export interface LLMResult {
  /** Parsed JSON output from the model */
  data: unknown;
  /** Raw string response before parsing (for debugging — no PII logged) */
  raw: string;
  /** Provider used, e.g. "anthropic" */
  provider: string;
  /** Model ID used */
  model: string;
  /** Total tokens consumed (input + output) */
  tokensUsed: number;
  /** Computed cost in USD based on pricing table */
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Model config
// ---------------------------------------------------------------------------

/**
 * Default to claude-haiku-4-5-20251001 — the cheapest capable Anthropic model
 * for classification/extraction tasks (§8.1). Override per-automation for
 * prompts that genuinely need stronger reasoning (e.g. complex multi-step).
 */
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Per-model pricing table (USD per million tokens).
 * Source: Anthropic pricing page (as of 2026-06).
 * TODO(M3): externalise into config/env so it can be updated without a deploy.
 *
 * claude-haiku-4-5-20251001: $0.80 input / $4.00 output per 1M tokens
 * claude-sonnet-4-5-20251001: $3.00 input / $15.00 output per 1M tokens
 * (Add more models as needed when escalating; always document the rate.)
 */
const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  "claude-haiku-4-5-20251001": { inputPerM: 0.8, outputPerM: 4.0 },
  "claude-sonnet-4-5-20251001": { inputPerM: 3.0, outputPerM: 15.0 },
  // Fallback for unknown models — use haiku rates to avoid under-charging
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
// Provider implementations
// ---------------------------------------------------------------------------

/**
 * Run a single LLM call against Anthropic.
 * Returns raw text + usage; the caller handles JSON parsing and cost calc.
 */
async function callAnthropic(
  prompt: string,
  system: string,
  model: string,
  maxTokens: number
): Promise<{ raw: string; inputTokens: number; outputTokens: number }> {
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
  };
}

// ---------------------------------------------------------------------------
// Provider list (ordered; first = primary)
// TODO(M3): add OpenAI as secondary fallback, wire retry-once + auto-failover
// ---------------------------------------------------------------------------

type ProviderCallFn = (
  prompt: string,
  system: string,
  model: string,
  maxTokens: number
) => Promise<{ raw: string; inputTokens: number; outputTokens: number }>;

const PROVIDERS: Array<{ name: string; call: ProviderCallFn }> = [
  { name: "anthropic", call: callAnthropic },
  // { name: "openai", call: callOpenAI }, // TODO(M3): add OpenAI fallback
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * runLLM — the single interface for all LLM calls in the platform.
 *
 * Instructs the model to respond with JSON ONLY; parses the response safely.
 * Computes cost from the pricing table. Logs provider/model/tokens/cost to the
 * console (no prompt content or keys logged, per §7.2 / §7.3).
 *
 * Failover (M2 stub): tries the single Anthropic provider; on failure throws.
 * Full retry-once + secondary-provider failover added in M3.
 */
export async function runLLM(input: LLMInput): Promise<LLMResult> {
  const model = input.model ?? DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? 1024;

  // Default system: JSON only — override only when the automation has a
  // specific system prompt that already enforces JSON.
  const system =
    input.system ??
    "You are a precise classification assistant. Respond with valid JSON only. No prose, no code fences, no explanation — just the JSON object.";

  let lastError: Error | undefined;

  for (const provider of PROVIDERS) {
    try {
      const { raw, inputTokens, outputTokens } = await provider.call(
        input.prompt,
        system,
        model,
        maxTokens
      );

      const tokensUsed = inputTokens + outputTokens;
      const costUsd = computeCost(model, inputTokens, outputTokens);
      const data = safeParseJson(raw);

      console.log(
        `[llm] provider=${provider.name} model=${model} ` +
          `tokens=${tokensUsed} cost=$${costUsd.toFixed(6)}`
      );

      return { data, raw, provider: provider.name, model, tokensUsed, costUsd };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Never log the prompt or API key; log only non-sensitive failure info
      console.error(
        `[llm] provider=${provider.name} model=${model} failed: ${lastError.message}`
      );
      // Continue to next provider (M3 will add delay + retry-once before fallback)
    }
  }

  throw lastError ?? new Error("All LLM providers failed.");
}
