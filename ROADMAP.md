# ROADMAP — Managed-Middleman Platform

> Phased implementation roadmap. This document expands the milestones in
> [`CLAUDE.md`](./CLAUDE.md) §9 (M0→M4) into concrete, ordered, agent-assignable work
> with acceptance criteria and the security/cost guardrails baked into every phase.
> It is the build plan; `CLAUDE.md` remains the constitution. Where they ever
> disagree, `CLAUDE.md` wins.

---

## How to use this document

- **Core principle (never violate):** *The operator owns everything; the client
  connects and forgets* (§2). Every phase below preserves this.
- **One phase = one PR.** Each phase ships on its own branch and is gated by the
  `qa` agent (§7 security + §8 cost) **and** the `testing` agent before the next
  phase starts. Follow the `github` agent's branch/commit/PR workflow.
- **Ownership** is called out per phase. Hand-offs follow the agent specs in
  `.claude/agents/`.
- **Do not skip ahead.** §9 is explicit: do not build the full multi-provider
  platform before M2 works end-to-end for one client. Prove value first.

---

## Current state snapshot

| Area | Status |
|---|---|
| Constitution (`CLAUDE.md`), `AGENTS.md` | ✅ Done |
| Role-agent specs (`.claude/agents/*`) + Cursor rules (`.cursor/rules/*`) | ✅ Done |
| `package.json`, `tsconfig`, Next.js app | ❌ Missing |
| Prisma schema, migrations, Postgres | ❌ Missing |
| `app/`, `lib/`, `worker/`, `automations/`, `providers/`, `prompts/` | ❌ Missing |
| `.env.example`, `.gitignore` | ❌ Missing |
| Any source code | ❌ Missing |

**Starting line:** the project is fully *specified* but entirely *unbuilt*. Phase
M0 lays the foundation everything else depends on.

---

## Phase M0 — Skeleton

**Owner:** `backend` (scaffold) + `github` (PR). **Goal:** *I can create a `Client`
record.*

**Tasks**
- Initialize **Next.js (App Router) + TypeScript strict mode** (§4, §10);
  `package.json`, `tsconfig.json`, lint config.
- Add **Prisma + PostgreSQL**. Author `prisma/schema.prisma` with the six §5 models:
  `Operator`, `Client`, `Connection`, `Automation`, `Run`, `UsageCounter`.
  - `Connection` stores `encryptedAccessToken` / `encryptedRefreshToken` /
    `tokenExpiresAt` / `scopes` / `status` — **never** plaintext tokens (§7.2).
- Add **`.env.example`** mirroring §12 (placeholders only — real secrets never
  committed, §7.4). Add `.gitignore` covering `.env*`, `node_modules`, build output.
- Create the directory scaffold per §10: `app/`, `lib/`, `worker/`, `automations/`,
  `providers/`, `prompts/`.
- Build the **Token Vault** crypto helpers in `lib/crypto`: `encrypt(plaintext)` /
  `decrypt(ciphertext)` using **AES-256-GCM** keyed from `TOKEN_ENCRYPTION_KEY`
  (§6.2). Tokens decrypted in-memory only; never logged. Leave a `TODO: migrate to
  managed KMS` (§6.2).
- A minimal "create a `Client`" path (server action or API route) to prove the DB
  wiring works.

**Acceptance**
- `npm run build` + typecheck pass; the first migration applies cleanly.
- A `Client` row can be created and read back.
- `testing`: crypto `encrypt`/`decrypt` round-trip; assert a token value never
  appears in logs/error output (§ testing priority #1).

---

## Phase M1 — First OAuth integration (Gmail)

**Owner:** `backend` (flow + vault), `frontend` (connect button). **Goal:** Gmail
connect works end-to-end; tokens stored encrypted; auto-refresh works.

**Tasks**
- `providers/gmail/` module. Register the Google OAuth app, set redirect URI to
  `/oauth/callback/[provider]`. Use `arctic` or the provider SDK (§4).
- Callback route at `/oauth/callback/[provider]` that **validates the OAuth `state`
  parameter on every callback** (CSRF — §7.6) before doing anything else.
- Exchange `code` → `access_token` + `refresh_token`; **encrypt and store** in
  `Connection` tied to client + provider (§6.1).
- Implement **refresh-token rotation** so access tokens stay valid without
  re-prompting the client (§6.1).
- **Minimum scopes only** — request exactly what email triage needs, nothing more
  (§7.5).
- Onboarding UI (`frontend`): a "Connect Gmail" button that links to the backend
  OAuth route; show a ✅ on success. The browser **never** handles tokens or the
  `code` exchange (frontend agent rules).

**Flag to operator (§11):** Google sensitive-scope OAuth needs Google's security
review for production; unverified apps are capped (~100 users) and show a warning
screen. Budget time before onboarding many clients.

**Acceptance**
- Full connect flow stores encrypted tokens in `Connection`.
- An expired access token triggers a successful refresh.
- `testing`: bad/missing `state` is rejected; `code`→token exchange; encrypted
  storage; refresh path handled and recorded (testing priorities #2, #3).

---

## Phase M2 — First automation: email triage

**Owner:** `backend`. **Goal:** one real client, one automation, visible result in
their Gmail. *Prove it works and saves time* (§9).

**Tasks**
- **LLM Router** (§6.3): single interface `runLLM({ prompt, model, schema })`.
  - Default to a **cheap model** (e.g. Claude Haiku) for classification (§8.1).
  - Prompt for **JSON only**; parse safely.
  - Log provider, tokens, and computed cost to `Run` on every call (§6.3, §10).
  - (Full failover is hardened in M3; a single-provider path is acceptable here.)
- `automations/email_triage/` exposing `poll(client, config)` and `process(item)`
  (§6.4).
  - **Filter before the LLM** — not every email needs a model call; cache/dedupe
    repeated inputs (§8.3, §8.4).
  - Write the result back to the client's Gmail: create a draft reply / add a label.
- **Worker process** (`worker/`) runs the poll loop on an interval (§6.4). Serverless
  is explicitly the wrong fit (§4).
- Store the triage prompt as a **versioned file under `prompts/`** — this is the core
  IP, keep it organized (§10).
- Every external call wrapped in try/catch; failures recorded on `Run` (§10).

**Acceptance**
- For one real client, a new email is polled, classified, and a draft/label appears
  in *their* Gmail.
- The `Run` row records provider, tokens, cost, and status.

---

## Phase M3 — Guardrails

**Owner:** `backend`. **Goal:** the platform is safe to leave running.

**Tasks**
- **LLM failover** (§6.3): try primary → retry once → fall back to secondary
  provider automatically on error/timeout.
- **Usage metering** in `UsageCounter` (calls + $ per client per month).
- **Cap enforcement before every LLM call** (§8.2): over-cap clients are
  skipped/flagged and **no LLM call is made**.
- **Per-client kill switch**: `Client.status = paused` runs no automations (§6.5).
- **Alerts** to the operator at 80% of cap or when daily spend exceeds a threshold
  (§6.5).

**Acceptance**
- `testing`: cap is checked *before* the call (testing priority #4); failover
  primary→secondary with cost/tokens logged (#5); a `paused` client runs nothing
  (#6).

---

## Phase M4 — Scale

**Owner:** `frontend` (dashboard) + `backend` (providers/automations).

**Tasks**
- **Operator Dashboard** (§6.7): list clients, connection health, recent runs,
  usage vs cap, and a pause toggle. Operator-only.
- More providers — start with **Slack** (`providers/slack/`), then Microsoft Graph,
  etc. Each its own module (§10).
- More automation types, each under `automations/[type]/`.
- Onboarding polish.
- Consider **webhooks/push** for high-volume automations to cut cost/latency (§11).

---

## Cross-cutting guardrails (every PR, enforced by `qa`)

**Security non-negotiables (§7) — any violation is a Blocker:**
1. No client passwords stored anywhere — OAuth only.
2. All tokens encrypted at rest (AES-256-GCM); never logged in plaintext.
3. One set of LLM API keys, operator-held, never shipped to client/browser.
4. Secrets only in env vars / secret manager — never committed.
5. Minimum OAuth scopes per automation.
6. OAuth `state` validated on every callback.

**Cost rules (§8):**
1. Cheapest capable model by default; escalation justified.
2. Per-client monthly cap enforced **before** any LLM call.
3. Pre-LLM filtering — not every item triggers a model call.
4. Repeated inputs cached/deduped.

**Open decisions to flag, not silently assume (§11):**
- Google/provider app verification timelines before onboarding many clients.
- Single LLM key = shared fate; failover mitigates, consider per-provider
  rate-limit handling.
- Polling first (universal), move hot paths to webhooks later.
- Zapier usable as a *trigger source* via a secured webhook — logic/prompts stay here.

---

## Suggested PR sequence & agent assignments

| Phase | Driving agent(s) | Required `testing` coverage | `qa` gate |
|---|---|---|---|
| M0 Skeleton | `backend` + `github` | Crypto round-trip; token-never-logged | §7.2, §7.4 |
| M1 Gmail OAuth | `backend` + `frontend` | `state` rejection, exchange, encrypted store, refresh | §7.2, §7.5, §7.6 |
| M2 Email triage | `backend` | Run logging; pre-LLM filter behavior | §8.1, §8.3, §8.4 |
| M3 Guardrails | `backend` | Cap-before-call, failover, kill switch | §8.2, §6.3, §6.5 |
| M4 Scale | `frontend` + `backend` | Dashboard data; new-provider OAuth | §2, §7 (per provider) |

Each PR: branch → implement → `testing` green → `qa` pass → merge. Then start the
next phase. Never run more than one phase's scope in a single PR.
