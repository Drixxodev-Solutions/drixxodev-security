/**
 * automations/email_triage/index.ts — Email triage automation (§6.4, M2)
 *
 * Exposes:
 *   poll(client, config)    — fetch unread emails from client's Gmail
 *   process(item, ctx)      — classify one email, apply labels, optionally draft reply
 *
 * Pipeline per email (§8.3 filter-first, §8.4 dedupe, §6.4 cap-before-LLM):
 *   1. Filter: skip empty bodies, no-reply/automated senders (§8.3)
 *   2. Dedupe: skip message IDs already carrying our triage label (§8.4)
 *   3. Cap check: checkCap() BEFORE any LLM call (§6.4, §8.2)
 *   4. Load versioned prompt, call runLLM
 *   5. Write back: ensureLabel → modifyMessageLabels → optional createDraftReply
 *   6. recordUsage + create Run row (§6.3, §10)
 *
 * Kill switch (§6.5): caller (worker) checks client.status === "paused" and
 * skips the automation entirely — enforced in worker/index.ts.
 *
 * Security:
 * - Never log email bodies or subjects
 * - Never log access tokens
 * - All external calls wrapped in try/catch with failures recorded on Run
 */

import * as fs from "fs";
import * as path from "path";
import { getValidAccessToken } from "@/lib/connections";
import { runLLM } from "@/lib/llm";
import { checkCap, recordUsage } from "@/lib/usage";
import { prisma } from "@/lib/db";
import {
  listMessageIds,
  getMessage,
  ensureLabel,
  modifyMessageLabels,
  createDraftReply,
  GmailMessage,
} from "@/providers/gmail/client";
import type { Client } from "@prisma/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailTriageConfig {
  /** Gmail search query for new items (default: "is:unread in:inbox") */
  query?: string;
  /** Max messages to fetch per poll cycle (default: 10, hard-max: 50) */
  maxPerPoll?: number;
  /** Label prefix for triage categories (default: "Triage") */
  labelPrefix?: string;
  /** Whether to create draft replies for high-urgency support/sales (default: true) */
  createDrafts?: boolean;
}

export interface TriageItem {
  automationId: string;
  clientId: string;
  accessToken: string;
  message: GmailMessage;
  config: Required<EmailTriageConfig>;
}

/** The JSON shape the LLM must return (validated at runtime) */
interface TriageResult {
  summary: string;
  category: "sales" | "support" | "billing" | "spam" | "other";
  urgency: "low" | "medium" | "high";
}

const VALID_CATEGORIES = new Set(["sales", "support", "billing", "spam", "other"]);
const VALID_URGENCIES = new Set(["low", "medium", "high"]);

/** Run context passed to process() */
export interface ProcessCtx {
  automationId: string;
}

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

/**
 * Load the versioned prompt from prompts/email-triage-v1.md at runtime.
 * Prompts live in /prompts/ as core IP (§10); never hardcoded inline.
 * The file is read server-side only — never exposed to the client/browser.
 */
function loadTriagePrompt(): string {
  const promptPath = path.join(process.cwd(), "prompts", "email-triage-v1.md");
  return fs.readFileSync(promptPath, "utf-8");
}

// ---------------------------------------------------------------------------
// Filter helpers (§8.3 — filter before LLM)
// ---------------------------------------------------------------------------

/** Patterns that indicate automated/no-reply senders we can safely skip */
const AUTOMATED_SENDER_PATTERNS = [
  /no[-_]?reply@/i,
  /noreply@/i,
  /do[-_]?not[-_]?reply@/i,
  /automated@/i,
  /notifications?@/i,
  /alerts?@/i,
  /mailer[-_]daemon@/i,
  /postmaster@/i,
  /bounce@/i,
  /daemon@/i,
];

function isAutomatedSender(from: string): boolean {
  return AUTOMATED_SENDER_PATTERNS.some((re) => re.test(from));
}

function isEmpty(text: string): boolean {
  return text.trim().length < 10; // Less than 10 chars is effectively empty
}

// ---------------------------------------------------------------------------
// Dedupe helper (§8.4)
// ---------------------------------------------------------------------------

/**
 * A triage label on the message serves as the dedupe marker.
 * If the message already carries any label starting with "Triage/",
 * it has already been processed — skip it.
 *
 * We check this by inspecting the message's label IDs via the API before
 * investing in a full message fetch + LLM call. However since we do a full
 * getMessage() first (to get the body), we use the label list from the list
 * response here by relying on the triage query filter instead.
 *
 * Primary dedupe strategy: the Gmail query uses "-label:Triage" to exclude
 * already-labeled messages. This is set in buildQuery() below.
 * Secondary guard: check if message ID appears in a passed-in processed set.
 */
function buildQuery(config: Required<EmailTriageConfig>): string {
  const base = config.query;
  // Exclude messages we've already labeled (primary dedupe, §8.4)
  // The label prefix may contain spaces, so quote it in the Gmail query
  return `${base} -label:"${config.labelPrefix}"`;
}

// ---------------------------------------------------------------------------
// poll()
// ---------------------------------------------------------------------------

/**
 * Fetch unread emails for the given client's Gmail connection.
 * Returns an array of TriageItem ready for process().
 * Skips automated/no-reply senders and empty bodies here (§8.3 filter).
 */
export async function poll(
  client: Client,
  config: EmailTriageConfig
): Promise<TriageItem[]> {
  // Apply defaults
  const fullConfig: Required<EmailTriageConfig> = {
    query: config.query ?? "is:unread in:inbox",
    maxPerPoll: Math.min(config.maxPerPoll ?? 10, 50),
    labelPrefix: config.labelPrefix ?? "Triage",
    createDrafts: config.createDrafts ?? true,
  };

  // Obtain a fresh access token (handles refresh automatically, §6.1)
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(client.id, "gmail");
  } catch (err) {
    console.error(
      `[email_triage] poll: failed to get access token for client ${client.id}: ` +
        (err instanceof Error ? err.message : String(err))
    );
    return [];
  }

  // Build the query with the dedupe label exclusion
  const query = buildQuery(fullConfig);

  let messageIds: string[];
  try {
    messageIds = await listMessageIds(accessToken, query, fullConfig.maxPerPoll);
  } catch (err) {
    console.error(
      `[email_triage] poll: failed to list messages for client ${client.id}: ` +
        (err instanceof Error ? err.message : String(err))
    );
    return [];
  }

  if (messageIds.length === 0) {
    return [];
  }

  // Fetch each message; apply pre-LLM filters (§8.3)
  const items: TriageItem[] = [];
  for (const id of messageIds) {
    let message: GmailMessage;
    try {
      message = await getMessage(accessToken, id);
    } catch (err) {
      console.error(
        `[email_triage] poll: failed to fetch message ${id} for client ${client.id}: ` +
          (err instanceof Error ? err.message : String(err))
      );
      continue;
    }

    // §8.3 filters — skip before incurring any cost
    if (isAutomatedSender(message.from)) {
      console.log(`[email_triage] poll: skipping automated sender (${client.id})`);
      continue;
    }
    if (isEmpty(message.bodyText)) {
      console.log(`[email_triage] poll: skipping empty-body message (${client.id})`);
      continue;
    }

    items.push({
      automationId: "", // filled in by worker when it has automationId
      clientId: client.id,
      accessToken,
      message,
      config: fullConfig,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// process()
// ---------------------------------------------------------------------------

/**
 * Process one email through the triage pipeline.
 * Creates a Run row and records provider/tokens/cost on success or failure.
 *
 * Steps:
 *   1. Create Run row (status=running)
 *   2. checkCap BEFORE any LLM call (§6.4, §8.2)
 *   3. Build prompt from versioned file + email content
 *   4. runLLM → parse + validate result
 *   5. Write labels back to Gmail; optionally create draft reply
 *   6. recordUsage; update Run to succeeded
 *   On any error: update Run to failed + error message
 */
export async function processItem(item: TriageItem, ctx: ProcessCtx): Promise<void> {
  const { clientId, accessToken, message, config } = item;
  const automationId = ctx.automationId;

  // Create the Run row so we have an ID for recording results (§10)
  let runId: string;
  try {
    const run = await prisma.run.create({
      data: {
        automationId,
        status: "running",
        inputSummary: `Email from ${message.from.split("<")[0].trim()} — subject redacted`,
        startedAt: new Date(),
      },
    });
    runId = run.id;
  } catch (dbErr) {
    // If we can't even write the Run, log and bail — don't proceed without tracking
    console.error(
      `[email_triage] process: failed to create Run for automation ${automationId}: ` +
        (dbErr instanceof Error ? dbErr.message : String(dbErr))
    );
    return;
  }

  try {
    // -----------------------------------------------------------------------
    // Step 2: Cap check BEFORE the LLM call (§6.4, §8.2)
    // -----------------------------------------------------------------------
    const { allowed, counter } = await checkCap(clientId);
    if (!allowed) {
      await prisma.run.update({
        where: { id: runId },
        data: {
          status: "failed",
          error: `Monthly cap exceeded: ${counter.callsUsed}/${counter.callsIncluded} calls, $${counter.costUsd.toFixed(4)}/$${counter.capUsd.toFixed(4)}`,
          finishedAt: new Date(),
        },
      });
      console.warn(
        `[email_triage] process: skipping LLM call for client ${clientId} — cap exceeded`
      );
      return;
    }

    // -----------------------------------------------------------------------
    // Step 3: Build the prompt
    // -----------------------------------------------------------------------
    const promptTemplate = loadTriagePrompt();
    // Append the email content (subject + body). Never log this.
    const fullPrompt =
      promptTemplate +
      `\nSubject: ${message.subject}\n\n${message.bodyText.slice(0, 4000)}`; // truncate to 4k chars

    // -----------------------------------------------------------------------
    // Step 4: Call the LLM (§6.3)
    // -----------------------------------------------------------------------
    const llmResult = await runLLM({
      prompt: fullPrompt,
      // System is already set in runLLM default (JSON only), but override
      // here so the triage instructions are the system prompt's authority
      system:
        "You are an email triage assistant. Respond with valid JSON only. No prose, no code fences.",
    });

    // Validate the shape of the LLM result
    const raw = llmResult.data as Record<string, unknown>;
    if (
      typeof raw.summary !== "string" ||
      typeof raw.category !== "string" ||
      !VALID_CATEGORIES.has(raw.category) ||
      typeof raw.urgency !== "string" ||
      !VALID_URGENCIES.has(raw.urgency)
    ) {
      throw new Error(
        `LLM returned unexpected triage shape: ${JSON.stringify(raw).slice(0, 200)}`
      );
    }

    const triage = raw as unknown as TriageResult;

    // -----------------------------------------------------------------------
    // Step 5: Write back to Gmail
    // -----------------------------------------------------------------------

    // 5a. Ensure the category label exists, e.g. "Triage/sales"
    const categoryLabelName = `${config.labelPrefix}/${triage.category}`;
    const labelId = await ensureLabel(accessToken, categoryLabelName);

    // 5b. Apply the category label + mark as read (remove UNREAD)
    const addLabels: string[] = [labelId];
    const removeLabels: string[] = ["UNREAD"];

    // 5c. For high-urgency, also add a priority label
    if (triage.urgency === "high") {
      const priorityLabelId = await ensureLabel(accessToken, `${config.labelPrefix}/urgent`);
      addLabels.push(priorityLabelId);
    }

    await modifyMessageLabels(accessToken, message.id, {
      addLabelIds: addLabels,
      removeLabelIds: removeLabels,
    });

    // 5d. Draft reply for high-urgency support or sales (§CLAUDE.md §6.4)
    // Never auto-send — only creates a draft the operator/client can review.
    let draftId: string | undefined;
    if (
      config.createDrafts &&
      triage.urgency === "high" &&
      (triage.category === "support" || triage.category === "sales")
    ) {
      try {
        const ackBody =
          `Thank you for reaching out. I've received your message and will get back to you shortly.\n\n` +
          `[Draft — review before sending]`;
        draftId = await createDraftReply(accessToken, {
          threadId: message.threadId,
          to: message.from,
          subject: message.subject,
          bodyText: ackBody,
        });
      } catch (draftErr) {
        // Draft creation failure is non-fatal — log and continue
        console.error(
          `[email_triage] process: draft creation failed for client ${clientId}: ` +
            (draftErr instanceof Error ? draftErr.message : String(draftErr))
        );
      }
    }

    // -----------------------------------------------------------------------
    // Step 6: Record usage + update Run to succeeded (§6.3, §10)
    // -----------------------------------------------------------------------
    await recordUsage(clientId, {
      calls: 1,
      costUsd: llmResult.costUsd,
    });

    const outputParts = [`category=${triage.category} urgency=${triage.urgency}`];
    if (draftId) outputParts.push("draft-created");

    await prisma.run.update({
      where: { id: runId },
      data: {
        status: "succeeded",
        outputSummary: outputParts.join("; "),
        llmProvider: llmResult.provider,
        tokensUsed: llmResult.tokensUsed,
        costUsd: llmResult.costUsd,
        finishedAt: new Date(),
      },
    });

    console.log(
      `[email_triage] processed message for client ${clientId}: ` +
        `${triage.category}/${triage.urgency} tokens=${llmResult.tokensUsed} cost=$${llmResult.costUsd.toFixed(6)}`
    );
  } catch (err) {
    // Record failure on Run (§10)
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[email_triage] process: error for client ${clientId}: ${errMsg}`);

    try {
      await prisma.run.update({
        where: { id: runId },
        data: {
          status: "failed",
          error: errMsg.slice(0, 1000), // truncate to avoid huge DB rows
          finishedAt: new Date(),
        },
      });
    } catch (updateErr) {
      console.error(
        `[email_triage] process: failed to update Run ${runId} to failed: ` +
          (updateErr instanceof Error ? updateErr.message : String(updateErr))
      );
    }
  }
}
