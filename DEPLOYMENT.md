# Deployment & Setup Runbook

> How to take this repo from a merged `main` to a running production instance.
> The platform is the "managed middleman" described in [`CLAUDE.md`](./CLAUDE.md): the
> operator owns all logic, prompts, and LLM keys; clients connect their tools once via OAuth
> and only ever see results. Build order and module specs live in [`ROADMAP.md`](./ROADMAP.md).

The code (M0–M4) is complete and CI-gated. Going live is an **operational** task: provision
infrastructure, register OAuth/auth apps, apply the database schema, and run two processes.

---

## 1. What you're deploying

Two long-lived processes that share one Postgres database:

| Process | Command | Role |
|---|---|---|
| **Web app** (Next.js) | `npm run build` then `npm run start` | Onboarding UI, OAuth connect/callback, operator dashboard, API routes |
| **Worker** (Node) | `npm run worker` | Polls connected inboxes on a schedule, runs automations, meters usage, fires alerts |

Both must run with the **same environment variables** and point at the **same `DATABASE_URL`**.
Hosting target is Railway (per `CLAUDE.md` §4): managed Postgres + two services (web + worker).

---

## 2. Prerequisites

- **Node 22** and **npm 10** (matches CI).
- A **PostgreSQL** database (Railway Postgres, Supabase, RDS, etc.).
- Accounts for: **Anthropic** (required), **OpenAI** (failover, recommended), **Google Cloud**
  (Gmail OAuth), **Clerk** (operator login), and optionally **Slack** (second provider).
- A public HTTPS domain for the web app → this is your `APP_BASE_URL`. OAuth redirect URIs are
  derived from it, so set it before registering the OAuth apps.

---

## 3. Environment variables

Copy `.env.example` → `.env` (local) or set these in your host's secret manager (prod). Never
commit real values (§7.4). `NEXT_PUBLIC_*` vars are exposed to the browser by design — only the
Clerk **publishable** key is `NEXT_PUBLIC`; everything else is server-only.

| Variable | Required | Secret? | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ | yes | Postgres connection string |
| `TOKEN_ENCRYPTION_KEY` | ✅ | yes | 64 hex chars (32 bytes) for AES-256-GCM token vault (§6.2). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. **If lost, all stored tokens become undecryptable** — back it up securely. |
| `ANTHROPIC_API_KEY` | ✅ | yes | Primary LLM (cheap Haiku default, §8.1) |
| `OPENAI_API_KEY` | ⬜ | yes | Failover provider (M3). Omit and failover simply has nothing to fall back to. |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | ✅ (for Gmail) | secret = yes | From Google Cloud Console (§4) |
| `SLACK_OAUTH_CLIENT_ID` / `_SECRET` | ⬜ (for Slack) | secret = yes | From Slack API dashboard (§5) |
| `APP_BASE_URL` | ✅ | no | Public HTTPS base, e.g. `https://app.yourcompany.com`. Drives OAuth redirect URIs. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✅ | no | Clerk `pk_…` (browser-safe) |
| `CLERK_SECRET_KEY` | ✅ | yes | Clerk `sk_…` (server-only) |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | ✅ | no | `/sign-in` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | ⬜ | no | `/sign-in` (single-operator; no separate sign-up) |
| `DAILY_SPEND_ALERT_USD` | ⬜ | no | Worker daily-spend alert threshold; default `25` |
| `OPERATOR_ALERT_EMAIL` | ⬜ | no | Alert recipient. **Note:** delivery is a `TODO(M4)` in `lib/alerts.ts` — alerts currently log to the worker console only; wire up email/Slack delivery before relying on them. |

---

## 4. Register the OAuth / auth apps

### Google (Gmail) — `GOOGLE_OAUTH_*`
1. Google Cloud Console → create a project → **APIs & Services → OAuth consent screen**.
2. Enable the **Gmail API**.
3. **Credentials → Create OAuth client ID → Web application**.
4. Authorized redirect URI: **`${APP_BASE_URL}/oauth/callback/gmail`**.
5. Scopes requested by the app (minimum, §7.5): `openid`, `email`,
   `https://www.googleapis.com/auth/gmail.modify` (read + label + create drafts).
6. ⚠️ **Verification (§11):** `gmail.modify` is a Google *sensitive* scope. Until the app passes
   Google's security review it shows an "unverified app" warning and is capped at ~100 users.
   Budget time before onboarding many clients.

### Slack (optional second provider) — `SLACK_OAUTH_*`
1. https://api.slack.com/apps → **Create New App** (from scratch).
2. **OAuth & Permissions → Redirect URLs:** `${APP_BASE_URL}/oauth/callback/slack`.
3. **Bot Token Scopes:** `chat:write` (minimum for posting, §7.5).
4. ⚠️ Distribution beyond your own/invited workspaces needs **Slack App Review** (§11). A
   private app can OAuth into invited workspaces without review.

### Clerk (operator login) — `CLERK_*`
1. https://dashboard.clerk.com → **Create application**.
2. Copy the **Publishable key** → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and **Secret key** →
   `CLERK_SECRET_KEY`.
3. Single-operator model: create exactly the operator user(s) you want; there's no public
   sign-up surface in the app. The dashboard (`/dashboard`, `/api/dashboard`, `/api/clients`)
   is gated by Clerk middleware; `/onboarding/*` and `/oauth/*` stay public for clients.

---

## 5. Database — apply the schema

This repo has **not yet created a Prisma migrations baseline** (`prisma/` contains only
`schema.prisma`; CI runs `prisma validate`/`generate` only). Create the baseline once, commit
it, then deploy migrations in prod going forward.

```bash
# One-time, against a dev/staging DATABASE_URL — creates prisma/migrations/<ts>_init/
npx prisma migrate dev --name init

# Commit the generated prisma/migrations/ directory, then in production:
npx prisma migrate deploy
```

Quick-start alternative (no migration history): `npx prisma db push`. Prefer `migrate` for any
real environment so schema changes are versioned. Run `npx prisma generate` after install (the
web build already does).

---

## 6. Run it

```bash
npm ci
npx prisma generate
npx prisma migrate deploy      # prod schema
npm run build                  # Next.js production build
npm run start                  # web service (port from $PORT / 3000)
npm run worker                 # SEPARATE process — the automation poll loop
```

On **Railway**: one service running `npm run start` (web) and a second running `npm run worker`,
both with the full env set, plus the managed Postgres plugin for `DATABASE_URL`.

---

## 7. First end-to-end run

1. **Sign in** to the operator dashboard at `${APP_BASE_URL}/sign-in` (Clerk).
2. **Create a client** — `POST /api/clients` `{ "name": "...", "contactEmail": "..." }`
   (Clerk-protected). Note the returned client `id`.
3. **Create an automation** for that client (no UI yet — insert directly or via a script):
   an `Automation` row with `type=email_triage`, `enabled=true`, and `config` JSON. Useful
   `config` keys: `maxPerPoll`, `createDrafts`, `requiredProviders` (e.g. `["gmail"]` or
   `["gmail","slack"]` — drives the onboarding page), and optionally `slackAlerts` +
   `slackChannel` to post high-urgency items to Slack.
4. **Send the client their onboarding link:** `${APP_BASE_URL}/onboarding/<clientId>`. They
   click "Connect Gmail" (and "Connect Slack" if required) — tokens are stored encrypted.
5. **Worker** picks it up on the next tick (default poll interval 300s), triages new unread
   mail, applies `Triage/<category>` labels / drafts, and records `Run` rows.
6. **Watch it** on `/dashboard` and `/dashboard/clients/<id>`: connection health, usage vs cap,
   recent runs with cost. Use the **pause toggle** to stop a client (kill switch, §6.5).

---

## 8. Go-live checklist

- [ ] All required env vars set in the host (web **and** worker services).
- [ ] `TOKEN_ENCRYPTION_KEY` generated and **backed up** (loss = unrecoverable tokens).
- [ ] `prisma migrate deploy` applied; `prisma generate` run.
- [ ] Google OAuth redirect URI matches `${APP_BASE_URL}/oauth/callback/gmail`; Gmail API enabled.
- [ ] (If used) Slack redirect URI + `chat:write` scope; Clerk keys set; operator user created.
- [ ] Web app and worker both running and pointing at the same DB.
- [ ] One real client connected end-to-end and a `Run` recorded (§9 M2 "prove it works").
- [ ] Monthly caps reviewed (`UsageCounter.callsIncluded` / `capUsd` defaults: 500 / $10) and
      `DAILY_SPEND_ALERT_USD` set to a sane value.
- [ ] Alert delivery wired up if you depend on it (currently console-only — `lib/alerts.ts`).
- [ ] `ecc-tools` GitHub App uninstalled (Settings → GitHub Apps) to stop unsolicited bot PRs.

---

## 9. Security & cost reminders (non-negotiable)

- Tokens are encrypted at rest (AES-256-GCM) and never logged in plaintext (§7.1–7.2).
- LLM keys are operator-held, server-side only — never shipped to the browser (§7.3).
- OAuth `state` is validated on every callback (CSRF, §7.6); minimum scopes only (§7.5).
- Usage caps are checked **before** every LLM call; overage auto-pauses the client (§6.4/§8.2).
- Cheapest capable model by default; failover only on transient errors (§6.3/§8.1).

## 10. Known follow-ups (not blockers)

- **Alert delivery** (`lib/alerts.ts`) logs only — add email/Slack delivery (`TODO(M4)`).
- **Webhooks/push** for high-volume automations are deferred (§11); polling is the default.
- **Provider verification** timelines: Google sensitive-scope review, Slack app review (§11).
- **Automation management UI**: automations are created via DB/script today; a UI is future work.
