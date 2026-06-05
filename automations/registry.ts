/**
 * automations/registry.ts — Automation type dispatch registry (§6.4).
 *
 * A single place to look up the runtime implementation for an automation type
 * and dispatch to the right module. The worker (worker/index.ts) imports from
 * here so adding a new automation type is a one-line registration, not a worker
 * edit. This mirrors the provider registry (providers/registry.ts).
 *
 * Each automation module exposes the same shape:
 *   - poll(client, config)      → an array of opaque "items" to process
 *   - processItem(item, ctx)    → process one item; records its own Run row
 *
 * The registry erases each module's concrete item/config types behind a
 * uniform runner interface. This is safe because the worker only ever pipes a
 * module's own poll() output into the SAME module's processItem(); items never
 * cross between types. Each runner casts back to its module's real types at the
 * boundary, so type-safety inside the modules is preserved.
 */

import type { Client, AutomationType as AutomationTypeT } from "@prisma/client";
import { AutomationType } from "@prisma/client";

import {
  poll as emailTriagePoll,
  processItem as emailTriageProcess,
  type EmailTriageConfig,
  type TriageItem,
} from "@/automations/email_triage/index";
import {
  poll as meetingPrepPoll,
  processItem as meetingPrepProcess,
  type MeetingPrepConfig,
  type MeetingPrepItem,
} from "@/automations/meeting_prep/index";

/** Context every processItem receives. */
export interface ProcessCtx {
  automationId: string;
}

/**
 * Uniform runner shape the worker drives. `config` and `item` are opaque
 * (`unknown`) at the worker boundary; each runner narrows them internally.
 */
export interface AutomationRunner {
  poll(client: Client, config: unknown): Promise<unknown[]>;
  processItem(item: unknown, ctx: ProcessCtx): Promise<void>;
}

const REGISTRY: Record<AutomationTypeT, AutomationRunner> = {
  [AutomationType.email_triage]: {
    poll: (client, config) =>
      emailTriagePoll(client, (config ?? {}) as EmailTriageConfig),
    processItem: (item, ctx) => emailTriageProcess(item as TriageItem, ctx),
  },
  [AutomationType.meeting_prep]: {
    poll: (client, config) =>
      meetingPrepPoll(client, (config ?? {}) as MeetingPrepConfig),
    processItem: (item, ctx) => meetingPrepProcess(item as MeetingPrepItem, ctx),
  },
};

/**
 * Returns the runner for an automation type, or undefined if the type has no
 * registered implementation (e.g. an enum value added to the DB before its
 * module is wired up — the worker logs and skips rather than crashing).
 */
export function getAutomationRunner(
  type: AutomationTypeT
): AutomationRunner | undefined {
  return REGISTRY[type];
}
