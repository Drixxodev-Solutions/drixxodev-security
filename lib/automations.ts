/**
 * lib/automations.ts — automation type metadata, config defaults & validation.
 *
 * Single source of truth shared by the create API route
 * (app/api/dashboard/clients/[id]/automations/route.ts), the CLI seed script
 * (scripts/add-automation.ts), and anywhere else that needs to know the safe
 * default config for an automation type.
 *
 * The `config` JSON is NON-SENSITIVE automation settings only — never tokens,
 * keys, or prompt text (those live elsewhere per §7).
 *
 * `requiredProviders` is read by the onboarding page
 * (app/onboarding/[clientId]/page.tsx) to decide which "Connect X" buttons to
 * show the client, so it MUST be present in every automation's config.
 */

import { AutomationType, Prisma } from "@prisma/client";

/** Lowest poll interval we allow operators to set, in seconds (§8 cost / be a good API citizen). */
export const MIN_POLL_INTERVAL_SECONDS = 60;
/** Default poll interval if the operator doesn't specify one. Matches the schema default. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 300;

/** Human-facing metadata for each automation type (used by the dashboard UI). */
export const AUTOMATION_TYPE_META: Record<
  AutomationType,
  { label: string; description: string; requiredProviders: string[] }
> = {
  [AutomationType.email_triage]: {
    label: "Email triage",
    description:
      "Polls the client's Gmail, classifies each new email (category + urgency), applies labels, and drafts replies for high-urgency messages.",
    requiredProviders: ["gmail"],
  },
};

/**
 * Default config per automation type. Mirrors the field defaults documented in
 * automations/email_triage/index.ts (EmailTriageConfig) so a freshly created
 * automation behaves the same as the in-code defaults.
 */
function defaultConfigFor(type: AutomationType): Prisma.JsonObject {
  switch (type) {
    case AutomationType.email_triage:
      return {
        requiredProviders: AUTOMATION_TYPE_META[type].requiredProviders,
        query: "is:unread in:inbox",
        maxPerPoll: 10,
        labelPrefix: "Triage",
        createDrafts: true,
      };
    default:
      // Exhaustiveness guard — adding a new AutomationType forces a default here.
      return { requiredProviders: [] };
  }
}

/** Type guard: is `value` a supported AutomationType string? */
export function isValidAutomationType(value: unknown): value is AutomationType {
  return (
    typeof value === "string" &&
    (Object.values(AutomationType) as string[]).includes(value)
  );
}

/**
 * Validate & normalize a poll interval.
 * - undefined/null → schema default (300s)
 * - a finite number >= MIN → floored integer
 * - anything else (incl. < MIN) → null, signalling a 400 to the caller
 */
export function normalizePollInterval(value: unknown): number | null {
  if (value === undefined || value === null) {
    return DEFAULT_POLL_INTERVAL_SECONDS;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < MIN_POLL_INTERVAL_SECONDS) return null;
  return Math.floor(value);
}

/**
 * Build the stored config for a new automation: the type's safe defaults with
 * any caller-supplied overrides shallow-merged on top. `requiredProviders` is
 * always forced back to the type's canonical list so onboarding stays correct
 * even if a caller passes something odd.
 *
 * Throws if `override` is provided but is not a plain object.
 */
export function buildAutomationConfig(
  type: AutomationType,
  override: unknown
): Prisma.JsonObject {
  const base = defaultConfigFor(type);

  if (override === undefined || override === null) {
    return base;
  }
  if (typeof override !== "object" || Array.isArray(override)) {
    throw new Error("config must be a JSON object.");
  }

  return {
    ...base,
    ...(override as Prisma.JsonObject),
    // Onboarding depends on this — never let a caller override it.
    requiredProviders: AUTOMATION_TYPE_META[type].requiredProviders,
  };
}
