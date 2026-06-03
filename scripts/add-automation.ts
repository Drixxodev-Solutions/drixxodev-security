/**
 * scripts/add-automation.ts — attach an automation to a client from the terminal.
 *
 * The dashboard now has an "Add automation" button, but this script is handy
 * for seeding, local testing, or scripting onboarding without the UI.
 *
 * Usage:
 *   npm run add-automation -- --client <clientId|email> [--type email_triage]
 *                             [--poll <seconds>] [--disabled]
 *
 * Examples:
 *   npm run add-automation -- --client robert@acme.com
 *   npm run add-automation -- --client clxyz... --type email_triage --poll 120
 *
 * Reuses lib/automations.ts so the config defaults match the API route exactly.
 * Non-sensitive only — never touches tokens, keys, or prompts (§7).
 */

import "./load-env"; // load .env before Prisma reads DATABASE_URL
import { prisma } from "@/lib/db";
import { AutomationType } from "@prisma/client";
import {
  buildAutomationConfig,
  isValidAutomationType,
  normalizePollInterval,
  AUTOMATION_TYPE_META,
} from "@/lib/automations";

// --- tiny arg parser (no dependency) ---------------------------------------
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true; // boolean flag
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const clientRef = typeof args.client === "string" ? args.client : "";
  if (!clientRef) {
    fail(
      "Missing --client. Usage:\n" +
        "  npm run add-automation -- --client <clientId|email> [--type email_triage] [--poll <seconds>] [--disabled]"
    );
  }

  const type = typeof args.type === "string" ? args.type : AutomationType.email_triage;
  if (!isValidAutomationType(type)) {
    fail(
      `Invalid --type "${type}". Supported: ${Object.values(AutomationType).join(", ")}.`
    );
  }

  const pollInterval = normalizePollInterval(
    args.poll !== undefined ? Number(args.poll) : undefined
  );
  if (pollInterval === null) {
    fail("--poll must be a number of seconds (>= 60).");
  }

  const enabled = args.disabled !== true;

  // Resolve the client by id first, then by contactEmail.
  const client =
    (await prisma.client.findUnique({ where: { id: clientRef } })) ??
    (await prisma.client.findFirst({
      where: { contactEmail: clientRef.toLowerCase() },
    }));

  if (!client) {
    fail(`No client found matching "${clientRef}" (tried id then contactEmail).`);
  }

  const existing = await prisma.automation.findFirst({
    where: { clientId: client.id, type },
    select: { id: true },
  });
  if (existing) {
    fail(
      `Client "${client.name}" already has a '${type}' automation (${existing.id}). ` +
        "Edit or remove it in the dashboard first."
    );
  }

  const config = buildAutomationConfig(type, undefined);

  const automation = await prisma.automation.create({
    data: { clientId: client.id, type, config, pollInterval, enabled },
    select: { id: true, type: true, enabled: true, pollInterval: true },
  });

  console.log(
    `\n✔ Added "${AUTOMATION_TYPE_META[type].label}" to client "${client.name}" (${client.id})\n` +
      `  automation: ${automation.id}\n` +
      `  enabled:    ${automation.enabled}\n` +
      `  poll every: ${automation.pollInterval}s\n` +
      `  providers:  ${AUTOMATION_TYPE_META[type].requiredProviders.join(", ")}\n\n` +
      `Next: have the client connect those providers via /onboarding/${client.id}, ` +
      `then run the worker (npm run worker).\n`
  );
}

main()
  .catch((err) => {
    console.error("\n✖ Unexpected error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
