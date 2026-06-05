/**
 * tests/automations-config.test.ts — pure config/validation logic for
 * automation creation (lib/automations.ts), shared by the create API route and
 * the add-automation CLI script.
 *
 * Tests:
 *   isValidAutomationType  — accepts known types, rejects junk
 *   normalizePollInterval  — default / floor / reject below MIN / reject non-numbers
 *   buildAutomationConfig  — applies defaults, merges overrides, always forces
 *                            requiredProviders back to the canonical list
 */

import { describe, it, expect } from "vitest";
import { AutomationType } from "@prisma/client";
import {
  isValidAutomationType,
  normalizePollInterval,
  buildAutomationConfig,
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
} from "@/lib/automations";

describe("isValidAutomationType", () => {
  it("accepts a supported type", () => {
    expect(isValidAutomationType("email_triage")).toBe(true);
    expect(isValidAutomationType(AutomationType.email_triage)).toBe(true);
    expect(isValidAutomationType("meeting_prep")).toBe(true);
    expect(isValidAutomationType(AutomationType.meeting_prep)).toBe(true);
  });

  it("rejects unknown or non-string values", () => {
    expect(isValidAutomationType("slack_blast")).toBe(false);
    expect(isValidAutomationType(123)).toBe(false);
    expect(isValidAutomationType(undefined)).toBe(false);
    expect(isValidAutomationType(null)).toBe(false);
  });
});

describe("normalizePollInterval", () => {
  it("defaults when unset", () => {
    expect(normalizePollInterval(undefined)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(normalizePollInterval(null)).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
  });

  it("floors a valid number", () => {
    expect(normalizePollInterval(120.9)).toBe(120);
  });

  it("accepts exactly the minimum", () => {
    expect(normalizePollInterval(MIN_POLL_INTERVAL_SECONDS)).toBe(
      MIN_POLL_INTERVAL_SECONDS
    );
  });

  it("rejects below the minimum", () => {
    expect(normalizePollInterval(MIN_POLL_INTERVAL_SECONDS - 1)).toBeNull();
    expect(normalizePollInterval(0)).toBeNull();
    expect(normalizePollInterval(-5)).toBeNull();
  });

  it("rejects non-finite / non-number values", () => {
    expect(normalizePollInterval(NaN)).toBeNull();
    expect(normalizePollInterval(Infinity)).toBeNull();
    expect(normalizePollInterval("300")).toBeNull();
  });
});

describe("buildAutomationConfig", () => {
  it("returns safe defaults when no override is given", () => {
    const cfg = buildAutomationConfig(AutomationType.email_triage, undefined);
    expect(cfg).toMatchObject({
      requiredProviders: ["gmail"],
      query: "is:unread in:inbox",
      maxPerPoll: 10,
      labelPrefix: "Triage",
      createDrafts: true,
    });
  });

  it("merges caller overrides over defaults", () => {
    const cfg = buildAutomationConfig(AutomationType.email_triage, {
      maxPerPoll: 25,
      createDrafts: false,
    });
    expect(cfg.maxPerPoll).toBe(25);
    expect(cfg.createDrafts).toBe(false);
    // untouched default preserved
    expect(cfg.query).toBe("is:unread in:inbox");
  });

  it("always forces requiredProviders back to the canonical list", () => {
    const cfg = buildAutomationConfig(AutomationType.email_triage, {
      requiredProviders: ["slack", "evil"],
    });
    expect(cfg.requiredProviders).toEqual(["gmail"]);
  });

  it("throws on a non-object override", () => {
    expect(() =>
      buildAutomationConfig(AutomationType.email_triage, [1, 2, 3])
    ).toThrow();
    expect(() =>
      buildAutomationConfig(AutomationType.email_triage, "nope")
    ).toThrow();
  });

  it("returns safe defaults for meeting_prep", () => {
    const cfg = buildAutomationConfig(AutomationType.meeting_prep, undefined);
    expect(cfg).toMatchObject({
      requiredProviders: ["gcal"],
      calendarId: "primary",
      lookaheadHours: 48,
      maxPerPoll: 10,
    });
  });

  it("merges overrides but forces meeting_prep requiredProviders to gcal", () => {
    const cfg = buildAutomationConfig(AutomationType.meeting_prep, {
      lookaheadHours: 24,
      requiredProviders: ["gmail", "evil"],
    });
    expect(cfg.lookaheadHours).toBe(24);
    expect(cfg.requiredProviders).toEqual(["gcal"]);
    // untouched default preserved
    expect(cfg.calendarId).toBe("primary");
  });
});
