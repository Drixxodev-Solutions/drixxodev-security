# Drixxodev — Managed Automation Platform

A backend platform that lets **one operator** run AI-powered automations on behalf of
**multiple small-business clients**. Clients connect their tools once via OAuth and forget;
the operator owns all the logic, prompts, and LLM keys, and the automations run server-side.

> **Model: "managed middleman."** The operator owns everything; the client connects and
> forgets. Clients only ever see results in their own tools (a Gmail draft, a label, a Slack
> message) — never the prompts, keys, or how it works.

The full constitution is in [`CLAUDE.md`](./CLAUDE.md); the milestone build plan is in
[`ROADMAP.md`](./ROADMAP.md); going live is covered by [`DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## How it works

1. The operator creates a **client** and configures an **automation** (e.g. email triage).
2. The client clicks **"Connect Gmail"** once on their onboarding page — OAuth only, no login
   to our systems. Tokens are encrypted at rest and auto-refreshed.
3. A background **worker** polls the client's inbox, filters, and sends new items to the
   **LLM router** (cheapest capable model, with failover).
4. Results are written **back into the client's tools** (a draft, a `Triage/<category>` label,
   an optional Slack alert) and every run is metered against the client's monthly cap.
5. The operator watches everything — connection health, runs, usage vs cap — on a dashboard,
   and can pause any client (kill switch).

```
 Client tools          OPERATOR (me)
 (Gmail, Slack)   ┌──────────────────────────────────────────┐
      ▲           │  Automation Engine ──▶ LLM Router         │
      │ writes    │  (worker: poll →       (Anthropic primary │
      │ results   │   filter → process)     + OpenAI failover)│
      │           │        │                                  │
      │           │   Token Vault          Usage Metering     │
      └───────────│   (encrypted)          + Cost Caps        │
   OAuth tokens   │        ▲                                  │
                  │   Onboarding + OAuth  ◀── client connects │
                  │   Operator Dashboard  ◀── operator only   │
                  └──────────────────────────────────────────┘
```

---

## Status

All roadmap milestones (M0–M4) are merged and CI-gated.

| Milestone | What |
|---|---|
| **M0** | Next.js + Prisma + Postgres skeleton, AES-256-GCM token vault, CI |
| **M1** | Gmail OAuth — encrypted token storage, refresh rotation, onboarding page |
| **M2** | Email-triage automation — LLM router, worker poll loop, write-back |
| **M3** | Guardrails — LLM failover, usage alerts, overage auto-pause |
| **M4** | Operator dashboard, Clerk auth, Slack provider |
| **Tests** | 68 critical-path tests (token vault, OAuth state, refresh, caps, failover, kill switch) |

---

## Tech stack

TypeScript · Next.js (App Router) · PostgreSQL + Prisma · `arctic` (OAuth) ·
`@anthropic-ai/sdk` + `openai` (LLM router with failover) · Clerk (operator auth) ·
a separate Node worker process · Vitest · hosted on Railway.

---

## Quick start (local dev)

```bash
npm ci
cp .env.example .env            # fill in real values (see DEPLOYMENT.md §3)
npx prisma generate
npx prisma migrate dev --name init   # create + apply the schema to your dev DB
npm run dev                     # web app (onboarding, OAuth, dashboard) on :3000
npm run worker                  # in a second terminal: the automation poll loop
```

You'll need at minimum a Postgres `DATABASE_URL`, a `TOKEN_ENCRYPTION_KEY`, an
`ANTHROPIC_API_KEY`, Google OAuth credentials, and Clerk keys. For connecting a
real Gmail locally step by step, see
[`docs/GOOGLE_OAUTH_SETUP.md`](./docs/GOOGLE_OAUTH_SETUP.md); see
[`DEPLOYMENT.md`](./DEPLOYMENT.md) for the complete production setup, OAuth app
registration, and a go-live checklist.

Quickest sanity check (no Gmail/OAuth needed): `npm run triage:demo` runs the
real triage prompt against a sample email and prints the result + cost.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run worker` | Run the automation poll worker |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run lint` | ESLint |
| `npm run db:migrate` / `npm run db:generate` | Prisma migrate (dev) / generate client |

---

## Project structure

```
app/              Next.js routes
  (operator)/     Operator dashboard + sign-in (Clerk-protected)
  onboarding/     Client-facing connect page (public)
  oauth/          OAuth connect + callback (public, state-validated)
  api/            Client + dashboard API routes
automations/      One module per automation type (e.g. email_triage/)
providers/        One module per OAuth provider (gmail/, slack/) + registry
prompts/          Versioned LLM prompts — core IP, server-side only
lib/              crypto (token vault), db, connections, llm router, usage, alerts
worker/           Long-running poll/process loop
prisma/           schema.prisma (data model)
tests/            Vitest critical-path coverage
```

---

## Security & cost principles (non-negotiable)

- OAuth only — **no client passwords** ever stored.
- All tokens **encrypted at rest** (AES-256-GCM) and never logged in plaintext.
- LLM/provider keys are **operator-held, server-side only** — never shipped to the browser.
- OAuth `state` validated on every callback (CSRF); **minimum scopes** per integration.
- Usage **cap checked before every LLM call**; overage auto-pauses the client.
- Cheapest capable model by default; failover only on transient errors.

See [`CLAUDE.md`](./CLAUDE.md) §7–§8 for the full rules.
