/**
 * automations/meeting_prep/index.ts — Meeting prep automation (§6.4).
 *
 * Exposes the same shape every automation module does (see automations/registry.ts):
 *   poll(client, config)    — fetch upcoming, not-yet-prepped calendar events
 *   processItem(item, ctx)  — generate prep notes for one event, write them back
 *
 * Pipeline per event (mirrors email_triage; §8.3 filter-first, §8.4 dedupe,
 * §6.4 cap-before-LLM):
 *   1. Filter: skip events with no title and (effectively) no attendees/agenda
 *   2. Dedupe: skip events already carrying our prep marker (§8.4)
 *   3. Cap check: checkCap() BEFORE any LLM call (§6.4, §8.2)
 *   4. Load versioned prompt, call runLLM
 *   5. Write back: patch the event description with the prep notes + dedupe marker
 *   6. recordUsage + create Run row (§6.3, §10)
 *
 * Kill switch (§6.5): the worker checks client.status === "paused" and skips
 * the automation entirely — enforced in worker/index.ts.
 *
 * Security:
 * - Never log event titles, descriptions, or attendee lists (may be PII)
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
  listUpcomingEvents,
  patchEventPrep,
  CalendarEvent,
} from "@/providers/gcal/client";
import type { Client } from "@prisma/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MeetingPrepConfig {
  /** Calendar to read (default: "primary"). */
  calendarId?: string;
  /** How far ahead to look for events, in hours (default: 48, hard-max: 336/14d). */
  lookaheadHours?: number;
  /** Max events to prep per poll cycle (default: 10, hard-max: 50). */
  maxPerPoll?: number;
}

export interface MeetingPrepItem {
  clientId: string;
  accessToken: string;
  event: CalendarEvent;
  config: Required<MeetingPrepConfig>;
}

/** The JSON shape the LLM must return (validated at runtime). */
interface PrepResult {
  summary: string;
  agenda: string[];
  talkingPoints: string[];
  questions: string[];
}

/** Run context passed to processItem(). */
export interface ProcessCtx {
  automationId: string;
}

// ---------------------------------------------------------------------------
// Prompt loading (§10 — versioned prompt file, server-side only)
// ---------------------------------------------------------------------------

function loadPrepPrompt(): string {
  const promptPath = path.join(process.cwd(), "prompts", "meeting-prep-v1.md");
  return fs.readFileSync(promptPath, "utf-8");
}

// ---------------------------------------------------------------------------
// Filter helper (§8.3 — filter before LLM)
// ---------------------------------------------------------------------------

/**
 * An event is worth prepping if it has a real title OR at least one attendee.
 * A titled solo block ("Focus") with no attendees and no agenda isn't worth a
 * model call — skip it to save cost (§8.3).
 */
function isPrepWorthy(event: CalendarEvent): boolean {
  const hasTitle = event.summary.trim().length > 0;
  const hasAttendees = event.attendees.length > 0;
  const hasAgenda = event.description.trim().length >= 10;
  return hasTitle && (hasAttendees || hasAgenda);
}

// ---------------------------------------------------------------------------
// poll()
// ---------------------------------------------------------------------------

/**
 * Fetch upcoming, not-yet-prepped events for the client's Calendar connection.
 * Returns an array of MeetingPrepItem ready for processItem().
 * Skips already-prepped events (dedupe marker) and low-value events here (§8.3).
 */
export async function poll(
  client: Client,
  config: MeetingPrepConfig
): Promise<MeetingPrepItem[]> {
  const fullConfig: Required<MeetingPrepConfig> = {
    calendarId: config.calendarId ?? "primary",
    lookaheadHours: Math.min(config.lookaheadHours ?? 48, 336),
    maxPerPoll: Math.min(config.maxPerPoll ?? 10, 50),
  };

  // Obtain a fresh access token (handles refresh automatically, §6.1).
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(client.id, "gcal");
  } catch (err) {
    console.error(
      `[meeting_prep] poll: failed to get access token for client ${client.id}: ` +
        (err instanceof Error ? err.message : String(err))
    );
    return [];
  }

  const now = new Date();
  const timeMinISO = now.toISOString();
  const timeMaxISO = new Date(
    now.getTime() + fullConfig.lookaheadHours * 3600_000
  ).toISOString();

  let events: CalendarEvent[];
  try {
    events = await listUpcomingEvents(accessToken, {
      calendarId: fullConfig.calendarId,
      timeMinISO,
      timeMaxISO,
      maxResults: fullConfig.maxPerPoll,
    });
  } catch (err) {
    console.error(
      `[meeting_prep] poll: failed to list events for client ${client.id}: ` +
        (err instanceof Error ? err.message : String(err))
    );
    return [];
  }

  const items: MeetingPrepItem[] = [];
  for (const event of events) {
    // §8.4 dedupe — already prepped
    if (event.hasPrep) continue;
    // §8.3 filter — skip low-value events before incurring any cost
    if (!isPrepWorthy(event)) {
      console.log(`[meeting_prep] poll: skipping low-value event (${client.id})`);
      continue;
    }
    items.push({
      clientId: client.id,
      accessToken,
      event,
      config: fullConfig,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// processItem()
// ---------------------------------------------------------------------------

/** Render the validated prep result into a plain-text block for the event. */
function formatPrepNotes(prep: PrepResult): string {
  const bullets = (items: string[]) =>
    items.map((i) => `• ${i}`).join("\n");

  return [
    "──────────",
    "🧠 Meeting prep (AI-generated — review before the meeting)",
    "",
    prep.summary,
    "",
    "Agenda:",
    bullets(prep.agenda),
    "",
    "Talking points:",
    bullets(prep.talkingPoints),
    "",
    "Questions to ask:",
    bullets(prep.questions),
  ].join("\n");
}

/**
 * Process one event through the prep pipeline.
 * Creates a Run row and records provider/tokens/cost on success or failure.
 */
export async function processItem(item: MeetingPrepItem, ctx: ProcessCtx): Promise<void> {
  const { clientId, accessToken, event, config } = item;
  const automationId = ctx.automationId;

  // Create the Run row first so we have an ID for recording results (§10).
  // inputSummary keeps a short title only — never the full description/attendees.
  let runId: string;
  try {
    const run = await prisma.run.create({
      data: {
        automationId,
        status: "running",
        inputSummary: `Meeting prep: "${event.summary.slice(0, 60)}"`,
        startedAt: new Date(),
      },
    });
    runId = run.id;
  } catch (dbErr) {
    console.error(
      `[meeting_prep] process: failed to create Run for automation ${automationId}: ` +
        (dbErr instanceof Error ? dbErr.message : String(dbErr))
    );
    return;
  }

  try {
    // Step 2: Cap check BEFORE the LLM call (§6.4, §8.2)
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
        `[meeting_prep] process: skipping LLM call for client ${clientId} — cap exceeded`
      );
      return;
    }

    // Step 3: Build the prompt. Provide the model only the fields it needs;
    // truncate the description to bound token cost. Never log this content.
    const attendeeLine =
      event.attendees.length > 0 ? event.attendees.join(", ") : "(none listed)";
    const fullPrompt =
      loadPrepPrompt() +
      `\nTitle: ${event.summary}\n` +
      `Starts: ${event.startISO}\n` +
      `Attendees: ${attendeeLine}\n\n` +
      `Existing description / agenda:\n${event.description.slice(0, 3000) || "(none)"}`;

    // Step 4: Call the LLM (§6.3)
    const llmResult = await runLLM({
      prompt: fullPrompt,
      system:
        "You are a meeting preparation assistant. Respond with valid JSON only. No prose, no code fences.",
    });

    // Validate the shape of the LLM result.
    const raw = llmResult.data as Record<string, unknown>;
    const isStringArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === "string");
    if (
      typeof raw.summary !== "string" ||
      !isStringArray(raw.agenda) ||
      !isStringArray(raw.talkingPoints) ||
      !isStringArray(raw.questions)
    ) {
      throw new Error(
        `LLM returned unexpected prep shape: ${JSON.stringify(raw).slice(0, 200)}`
      );
    }
    const prep = raw as unknown as PrepResult;

    // Step 5: Write back — append prep notes to the event description and stamp
    // the dedupe marker. Keep any existing description above our block.
    const prepBlock = formatPrepNotes(prep);
    const newDescription = event.description.trim()
      ? `${event.description.trim()}\n\n${prepBlock}`
      : prepBlock;

    await patchEventPrep(accessToken, {
      calendarId: config.calendarId,
      eventId: event.id,
      newDescription,
    });

    // Step 6: Record usage + update Run to succeeded (§6.3, §10)
    await recordUsage(clientId, {
      calls: 1,
      costUsd: llmResult.costUsd,
    });

    await prisma.run.update({
      where: { id: runId },
      data: {
        status: "succeeded",
        outputSummary: `prep-added agenda=${prep.agenda.length} questions=${prep.questions.length}`,
        llmProvider: llmResult.provider,
        tokensUsed: llmResult.tokensUsed,
        costUsd: llmResult.costUsd,
        finishedAt: new Date(),
      },
    });

    console.log(
      `[meeting_prep] processed event for client ${clientId}: ` +
        `agenda=${prep.agenda.length} tokens=${llmResult.tokensUsed} cost=$${llmResult.costUsd.toFixed(6)}`
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[meeting_prep] process: error for client ${clientId}: ${errMsg}`);

    try {
      await prisma.run.update({
        where: { id: runId },
        data: {
          status: "failed",
          error: errMsg.slice(0, 1000),
          finishedAt: new Date(),
        },
      });
    } catch (updateErr) {
      console.error(
        `[meeting_prep] process: failed to update Run ${runId} to failed: ` +
          (updateErr instanceof Error ? updateErr.message : String(updateErr))
      );
    }
  }
}
