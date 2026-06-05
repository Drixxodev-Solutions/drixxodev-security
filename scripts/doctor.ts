/**
 * scripts/doctor.ts — local preflight for the email-triage loop.
 *
 *   npm run doctor
 *
 * Read-only. Inspects env config + DB state and reports, with ✓/⚠/✗, exactly
 * what still blocks a triage run. Never prints secret values — only whether
 * they're set and well-formed.
 *
 * It cannot tell whether `npm run worker` is currently running (that's a
 * separate process), so it reminds you to start it when everything else is ready.
 */

import "./load-env"; // load .env before reading process.env / connecting to the DB
import { prisma } from "@/lib/db";

type Level = "ok" | "warn" | "fail";
const mark = { ok: "✓", warn: "⚠", fail: "✗" } as const;

const lines: string[] = [];
let fails = 0;
let warns = 0;

function check(level: Level, label: string, detail = ""): void {
  if (level === "fail") fails++;
  if (level === "warn") warns++;
  lines.push(`  ${mark[level]} ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(title: string): void {
  lines.push(`\n${title}`);
}

function isSet(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0;
}

function validKey(): Level {
  const raw = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  if (!raw) return "fail";
  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) return "ok";
  if (raw.length === 32) return "ok";
  return "fail";
}

async function main() {
  // ---- 1. Environment --------------------------------------------------
  section("Environment");
  check(isSet("DATABASE_URL") ? "ok" : "fail", "DATABASE_URL", isSet("DATABASE_URL") ? "set" : "missing");
  check(validKey(), "TOKEN_ENCRYPTION_KEY", validKey() === "ok" ? "valid 32-byte key" : "missing or wrong length (need 64-hex or 32-char)");

  const hasLLM = isSet("ANTHROPIC_API_KEY") || isSet("OPENAI_API_KEY");
  check(
    hasLLM ? "ok" : "fail",
    "LLM key",
    [isSet("ANTHROPIC_API_KEY") && "ANTHROPIC", isSet("OPENAI_API_KEY") && "OPENAI"].filter(Boolean).join(" + ") || "none set"
  );

  const hasGoogle = isSet("GOOGLE_OAUTH_CLIENT_ID") && isSet("GOOGLE_OAUTH_CLIENT_SECRET");
  check(hasGoogle ? "ok" : "fail", "GOOGLE_OAUTH_CLIENT_ID/SECRET", hasGoogle ? "set" : "missing (Connect Gmail will fail)");

  const base = process.env.APP_BASE_URL ?? "";
  if (!base) {
    check("fail", "APP_BASE_URL", "missing");
  } else {
    check("ok", "APP_BASE_URL", base);
    lines.push(`      Google redirect URIs must be: ${base}/oauth/callback/gmail`);
    lines.push(`                              and: ${base}/oauth/callback/gcal`);
  }

  // ---- 2. Database ------------------------------------------------------
  section("Database");
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    check("ok", "Postgres reachable");
    dbOk = true;
  } catch (err) {
    check("fail", "Postgres reachable", err instanceof Error ? err.message.split("\n")[0] : "connection failed");
  }

  // ---- 3. Loop readiness (only if DB is up) ----------------------------
  if (dbOk) {
    section("Clients & automations");
    const clients = await prisma.client.findMany({
      select: {
        id: true,
        name: true,
        status: true,
        connections: { select: { provider: true, status: true, tokenExpiresAt: true } },
        automations: { select: { type: true, enabled: true, pollInterval: true } },
        _count: { select: { automations: true } },
      },
    });

    if (clients.length === 0) {
      check("fail", "Clients", "none — create one (POST /api/clients or the dashboard)");
    } else {
      check("ok", "Clients", `${clients.length} found`);
      const now = Date.now();
      for (const c of clients) {
        lines.push(`\n  • ${c.name} (${c.id}) — status: ${c.status}`);
        if (c.status === "paused") {
          check("warn", "  client paused", "kill switch on → no automations run for this client");
        }

        // connections
        if (c.connections.length === 0) {
          check("fail", "  connections", "none — finish OAuth at /onboarding/" + c.id);
        } else {
          for (const conn of c.connections) {
            const expired = conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() < now;
            const lvl: Level = conn.status === "active" ? (expired ? "warn" : "ok") : "fail";
            const detail =
              conn.status !== "active"
                ? conn.status + " (re-connect needed)"
                : expired
                ? "active but access token expired (worker will auto-refresh)"
                : "active";
            check(lvl, `  ${conn.provider} connection`, detail);
          }
        }

        // automations
        if (c.automations.length === 0) {
          check("fail", "  automations", "none — `npm run add-automation -- --client <id|email>`");
        } else {
          for (const a of c.automations) {
            check(
              a.enabled ? "ok" : "warn",
              `  ${a.type}`,
              a.enabled ? `enabled, every ${Math.round(a.pollInterval / 60)} min` : "disabled (enable it in the dashboard)"
            );
          }
        }
      }
    }

    // ---- 4. Runs --------------------------------------------------------
    section("Runs");
    const runCount = await prisma.run.count();
    if (runCount === 0) {
      check("warn", "Runs", "none yet — start the worker and send a test email");
    } else {
      check("ok", "Runs", `${runCount} total`);
      const last = await prisma.run.findMany({
        orderBy: { startedAt: "desc" },
        take: 3,
        select: { status: true, outputSummary: true, error: true, startedAt: true },
      });
      for (const r of last) {
        const lvl: Level = r.status === "failed" ? "fail" : r.status === "succeeded" ? "ok" : "warn";
        check(lvl, `  ${r.startedAt.toISOString()} ${r.status}`, r.error ?? r.outputSummary ?? "");
      }
    }
  }

  // ---- Verdict ----------------------------------------------------------
  console.log(lines.join("\n"));
  console.log("\n" + "—".repeat(60));
  if (fails === 0 && warns === 0) {
    console.log("✓ All checks passed. If runs aren't appearing, make sure `npm run worker`");
    console.log("  is running and there's unread mail in the connected inbox.");
  } else {
    console.log(`${fails} blocker(s), ${warns} warning(s). Fix the ✗ items above, then re-run.`);
    console.log("Reminder: the worker (`npm run worker`) must be running for any triage to happen.");
  }
  process.exit(fails > 0 ? 1 : 0);
}

main()
  .catch((err) => {
    console.error("\n✖ doctor failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
