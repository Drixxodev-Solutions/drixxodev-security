# CLAUDE.md

> Shared constitution for every agent on this project. Read this fully before writing any code.
> Owner: [Your Company, LLC]. Replace bracketed placeholders before building.
> Role-specific instructions live in `.claude/agents/` (Claude Code) and `.cursor/rules/` (Cursor). This file holds only the rules that apply to *everyone*.

---

## 1. What we're building

A backend platform that lets **one operator (me)** run AI-powered automations on behalf of **multiple small-business clients**.

The model is "**managed middleman**":

- I own all the automation logic, prompts, and LLM API keys.
- Clients connect their own tools (Gmail, Slack, etc.) **once** during onboarding, via OAuth.
- Automations run on **my** backend. The LLM calls happen with **my** keys.
- Clients only ever see the *results* in their own tools (a draft email, a Slack message, a created task). They never see Zapier, my prompts, my keys, or how it works.

This protects the IP (prompts/logic), centralizes cost control, and gives clients a zero-effort experience.

### Why this instead of "just use Zapier"
Zapier is great for prototyping a single automation, but if clients run it inside *their* Zapier they can see the prompts and logic. This project is the custom version: I hold the OAuth tokens and run the logic myself. (Zapier can still be used later as a *trigger source* via webhooks — see §11.)

---

## 2. Core principle (do not violate)

**The operator owns everything; the client connects and forgets.**

Every architectural decision should preserve: client never needs a login to my systems beyond a one-time OAuth consent, never sees prompts/keys, and can be turned on/off by me.

---

## Agents

Work on this project is split across five role agents. Each has its own file with focused instructions; this `CLAUDE.md` is the shared base they all inherit. **Every agent must obey §2 (core principle) and §7 (security rules) — no exceptions.**

| Agent | Owns | Definition |
|---|---|---|
| `frontend` | Onboarding UI (§6.6) + Operator Dashboard (§6.7). The only surfaces a human sees. | [.claude/agents/frontend.md](.claude/agents/frontend.md) |
| `backend` | OAuth service, token vault, LLM router, automation engine, usage metering (§6.1–6.5). | [.claude/agents/backend.md](.claude/agents/backend.md) |
| `qa` | Read-only gatekeeper: reviews diffs against §7 security + §8 cost rules before they ship. | [.claude/agents/qa.md](.claude/agents/qa.md) |
| `testing` | Writes and runs tests; mocks providers and LLM calls; covers refresh + cap paths. | [.claude/agents/testing.md](.claude/agents/testing.md) |
| `github` | Git/PR/CI workflow — branches, commits, pull requests, checks ("processing to github"). | [.claude/agents/github.md](.claude/agents/github.md) |

In Cursor, the same role guidance is wired up as auto-activating rules under `.cursor/rules/` (scoped by which files you're editing).

---

## 3. Architecture overview

```
 ┌─────────────────────────────────────────┐
 │ OPERATOR (me) │
 │ │
 Client tools │ ┌──────────────┐ ┌───────────────┐ │
 (Gmail, Slack) │ │ Automation │ │ LLM Router │ │
 ▲ │ │ Engine │───▶│ (Anthropic / │ │
 │ │ │ (poll/trigger│ │ OpenAI + │ │
 │ writes │ │ → process) │ │ failover) │ │
 │ results│ └──────┬───────┘ └───────────────┘ │
 │ │ │ │
 │ │ ┌──────▼───────┐ ┌───────────────┐ │
 └────────┼───│ Token Vault │ │ Usage Metering│ │
 OAuth tokens │ │ (encrypted) │ │ + Cost Caps │ │
 │ └──────────────┘ └───────────────┘ │
 │ ▲ │
 │ ┌──────┴───────┐ │
 │ │ Onboarding │ ◀── client clicks │
 │ │ + OAuth flow│ "Connect Gmail" │
 │ └──────────────┘ │
 └─────────────────────────────────────────┘
```

**Flow of one automation run (example: support-email triage):**
1. Automation Engine polls the client's Gmail (using their stored token) for new messages.
2. New email found → sent to the LLM Router with my prompt ("summarize + categorize urgency").
3. LLM returns structured JSON (summary, category, urgency).
4. Engine writes the result back to the client's tools (creates a Gmail draft reply / adds a label / posts to Slack).
5. Usage is metered against that client's monthly cap.

---

## 4. Tech stack (committed defaults)

Use these unless there's a strong reason not to. Keep it boring and reliable.

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | One language across frontend + backend |
| Framework | Next.js (App Router) | Onboarding UI + API routes in one app |
| Background work | Separate Node worker process | Automations need long-running/scheduled jobs; serverless is a bad fit |
| DB | PostgreSQL | Relational, multi-tenant friendly |
| ORM | Prisma | Type-safe, easy migrations |
| OAuth | `arctic` library (or provider SDKs) | Clean OAuth2 flows for many providers |
| LLM SDKs | `@anthropic-ai/sdk`, `openai` | Primary + fallback |
| Hosting | Railway | Runs long-lived worker + managed Postgres easily |
| Secrets | Env vars (move to a KMS later) | Simple to start |

> If I'd rather use Python: FastAPI + SQLAlchemy + Authlib is the equivalent stack. Pick one and stay consistent.

---

## 5. Data model

Start with these tables (Prisma schema). Keep tokens **encrypted at rest**.

- **Operator** — just me for now; supports multiple operators later.
- **Client** — a business I serve. Fields: name, contactEmail, status (active/paused), plan, createdAt.
- **Connection** — one per (client × provider). Fields: clientId, provider (`gmail`|`slack`|...), encryptedAccessToken, encryptedRefreshToken, tokenExpiresAt, scopes, status.
- **Automation** — a configured automation for a client. Fields: clientId, type (`email_triage`|...), config (JSON), enabled, schedule/pollInterval.
- **Run** — one execution. Fields: automationId, status, inputSummary, outputSummary, llmProvider, tokensUsed, costUsd, startedAt, finishedAt, error.
- **UsageCounter** — per client per month: callsUsed, callsIncluded, costUsd, capUsd.

---

## 6. Core modules (build these)

The detailed build spec for each module now lives with its owning agent, so instructions sit next to the code that implements them. This section is the index; follow the links for the actual requirements.

| Module | Spec | Owner |
|---|---|---|
| 6.1 OAuth Connection Service | [.claude/agents/backend.md](.claude/agents/backend.md) | `backend` |
| 6.2 Token Vault | [.claude/agents/backend.md](.claude/agents/backend.md) | `backend` |
| 6.3 LLM Router (with failover) | [.claude/agents/backend.md](.claude/agents/backend.md) | `backend` |
| 6.4 Automation Engine | [.claude/agents/backend.md](.claude/agents/backend.md) | `backend` |
| 6.5 Usage Metering + Cost Controls | [.claude/agents/backend.md](.claude/agents/backend.md) | `backend` |
| 6.6 Onboarding Frontend | [.claude/agents/frontend.md](.claude/agents/frontend.md) | `frontend` |
| 6.7 Operator Dashboard | [.claude/agents/frontend.md](.claude/agents/frontend.md) | `frontend` |

---

## 7. Security rules (non-negotiable)

1. Never store client passwords — OAuth only.
2. All tokens encrypted at rest; never logged in plaintext.
3. One set of LLM API keys, held by me, never exposed to clients or the frontend.
4. Secrets only in env vars / secret manager — never committed.
5. Request the **minimum OAuth scopes** each automation actually needs.
6. Validate the OAuth `state` parameter on every callback (CSRF protection).

---

## 8. Cost control rules

1. Use the cheapest capable model by default; escalate only when needed.
2. Cap calls per client per month; overage pauses or bills.
3. Filter before calling the LLM — not every item needs a model call.
4. Cache/dedupe repeated inputs.
5. Pricing must cover API cost + margin; revisit if costs climb.

---

## 9. Build order (do it incrementally — prove value before building the platform)

- **M0 — Skeleton:** Next.js app + Postgres + Prisma. I can create a `Client` record.
- **M1 — One OAuth integration:** Gmail connect flow end-to-end; token stored encrypted; auto-refresh works.
- **M2 — One automation:** "Email triage" — poll Gmail, call one LLM, write a draft/label back. One real client, one automation. **Prove it works and saves time.**
- **M3 — Guardrails:** LLM failover + usage metering + caps + alerts.
- **M4 — Scale:** Operator dashboard, more providers (Slack, etc.), onboarding polish, more automation types.

Do **not** try to build the whole multi-provider platform before M2 works for one client.

---

## 10. Conventions

- TypeScript strict mode on.
- Each automation type is its own module under `/automations/[type]/`.
- Each OAuth provider is its own module under `/providers/[provider]/`.
- All LLM prompts live in `/prompts/` as versioned files — this is the core IP, keep it organized.
- Every external call wrapped in try/catch with logging; failures recorded on the `Run`.

---

## 11. Open decisions / real-world gotchas (flag these to me, don't silently assume)

- **Provider app verification:** Gmail/Google OAuth with sensitive scopes requires Google's security review for production (unverified apps are capped at ~100 users and show a warning screen). Slack, Microsoft Graph, etc. have their own app-review processes. Budget time for this before onboarding many clients.
- **Single LLM key = shared fate:** if the provider is down or rate-limited, all clients are affected. The failover in §6.3 mitigates this; consider per-provider rate-limit handling too.
- **Polling vs webhooks:** start with polling (simple, universal). Move high-volume automations to webhooks/push later for cost and latency.
- **Zapier as a trigger source:** if I want to lean on Zapier for hard-to-build triggers, expose a secured webhook endpoint here and have Zapier POST to it — the logic and prompts still live in this backend.

---

## 12. Environment variables

```
DATABASE_URL=
TOKEN_ENCRYPTION_KEY= # 32-byte key for AES-256-GCM
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
SLACK_OAUTH_CLIENT_ID=
SLACK_OAUTH_CLIENT_SECRET=
APP_BASE_URL= # e.g. https://app.mycompany.com
```
