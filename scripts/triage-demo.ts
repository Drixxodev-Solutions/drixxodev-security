/**
 * scripts/triage-demo.ts — run the REAL email-triage prompt against a sample
 * email, with no Gmail, OAuth, database, or worker required.
 *
 * Purpose: prove your LLM key + the versioned prompt + the router/failover all
 * work, and let you *see* the structured triage output immediately — the
 * fastest end-to-end check before wiring up Gmail OAuth.
 *
 * Usage:
 *   npm run triage:demo
 *   npm run triage:demo -- --subject "Invoice #842 overdue" --body "We still..."
 *
 * It uses the same prompt file (prompts/email-triage-v1.md) and the same
 * runLLM call + system prompt as automations/email_triage/index.ts, so a green
 * result here means the AI half of the automation is correctly configured.
 *
 * Requires ANTHROPIC_API_KEY (and optionally OPENAI_API_KEY for failover) in
 * your environment / .env. No tokens, keys, or email content are logged by the
 * platform's LLM layer (§7).
 */

import * as fs from "fs";
import * as path from "path";
import { runLLM } from "@/lib/llm";

// --- tiny arg parser (no dependency) ---------------------------------------
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

// A realistic high-urgency support email as the default sample.
const SAMPLE = {
  subject: "URGENT: checkout is down, customers can't pay",
  body:
    "Hi — since about 30 minutes ago our checkout page returns a 500 error and " +
    "no orders are going through. This is costing us sales right now. We're on " +
    "the Pro plan. Please help ASAP, this is blocking our whole storefront.",
};

function loadTriagePrompt(): string {
  // Same source of truth as the automation (§10: prompts are versioned IP).
  return fs.readFileSync(
    path.join(process.cwd(), "prompts", "email-triage-v1.md"),
    "utf-8"
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const subject = args.subject ?? SAMPLE.subject;
  const body = args.body ?? SAMPLE.body;

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error(
      "\n✖ No LLM key found. Set ANTHROPIC_API_KEY (and optionally " +
        "OPENAI_API_KEY) in your .env, then re-run.\n"
    );
    process.exit(1);
  }

  // Build the prompt exactly like automations/email_triage/index.ts step 3.
  const fullPrompt =
    loadTriagePrompt() + `\nSubject: ${subject}\n\n${body.slice(0, 4000)}`;

  console.log(`\n→ Classifying sample email:\n   Subject: ${subject}\n`);

  const t0 = Date.now();
  const result = await runLLM({
    prompt: fullPrompt,
    system:
      "You are an email triage assistant. Respond with valid JSON only. No prose, no code fences.",
  });
  const ms = Date.now() - t0;

  console.log("✔ Triage result:");
  console.log(JSON.stringify(result.data, null, 2));
  console.log(
    `\n  provider: ${result.provider}\n` +
      `  model:    ${result.model}\n` +
      `  tokens:   ${result.tokensUsed}\n` +
      `  cost:     $${result.costUsd.toFixed(6)}\n` +
      `  latency:  ${ms} ms\n\n` +
      "This confirms your LLM key, the versioned prompt, and the router work.\n" +
      "Next: set GOOGLE_OAUTH_CLIENT_ID/SECRET, connect a client's Gmail via\n" +
      "/onboarding/:clientId, add an automation, then run `npm run worker`.\n"
  );
}

main().catch((err) => {
  console.error("\n✖ Triage demo failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
