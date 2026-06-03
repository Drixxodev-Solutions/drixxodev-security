/**
 * scripts/load-env.ts — minimal .env loader for standalone `tsx` scripts.
 *
 * Next.js auto-loads .env for the web app, and the Prisma CLI loads it for
 * migrations, but running a plain `tsx scripts/foo.ts` does NOT load .env. So
 * any script that reads process.env (ANTHROPIC_API_KEY, DATABASE_URL, …) must
 * load it itself.
 *
 * Import this FIRST, before any module that reads process.env:
 *   import "./load-env";
 *
 * Zero-dependency and intentionally simple: `KEY=VALUE` lines, `#` comments,
 * and optional surrounding quotes. Does NOT override a variable that is already
 * set to a non-empty value in the real environment, so CI / production / shell
 * env always win over the file.
 */

import * as fs from "fs";
import * as path from "path";

const envPath = path.join(process.cwd(), ".env");

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    // A non-empty existing value (real env var) takes precedence over the file.
    if (process.env[key]) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
