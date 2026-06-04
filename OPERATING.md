# OPERATING.md — How to run the platform day to day

> Plain-language guide for the operator. If you just want to onboard a client and
> see automations working, this is the file. (For architecture and the rules every
> agent follows, see [CLAUDE.md](CLAUDE.md).)
>
> This describes what the app does **today**: one automation type (**Email triage**),
> Gmail connections, a login-protected dashboard, a public per-client onboarding
> link, and a worker that does the actual work.

---

## 1. The mental model

There are three pieces. Keep them straight and everything else makes sense.

| Piece | What it is | Who uses it |
|---|---|---|
| **Dashboard** | A website you log into (`/dashboard`). You create clients, add automations, and watch results. | **You** (the operator) |
| **Onboarding link** | A public page (`/onboarding/<clientId>`) with a "Connect Gmail" button. No login. | **Your client**, once |
| **Worker** | A program that runs in a terminal window and keeps running. It checks Gmail and does the triage. | Runs in the background |

Nothing happens unless the **worker is running**. The dashboard and onboarding link
just set things up — the worker is the engine.

---

## 2. Each work session: start the app

You need **two terminal tabs open at the same time**, each running one thing. Leave
both open the whole time you're working.

**Tab 1 — the website:**
```
npm run dev
```
This serves the dashboard and onboarding pages at `http://localhost:3000`.

**Tab 2 — the worker (the engine):**
```
npm run worker
```
This checks every connected client's Gmail on a loop. You'll see it print lines as
it works. If you close this tab or press `Ctrl+C`, automations stop.

**Before you trust it, run the preflight check** (any spare tab):
```
npm run doctor
```
It tells you, in plain ✓ / ⚠ / ✗ terms, whether your settings, database, client
connections, and automations are ready. Fix any ✗ items first.

---

## 3. Onboard a client — step by step

### Step 1 — Create the client
1. Open `http://localhost:3000/dashboard` and sign in.
2. Click **"+ New client"** (top right).
3. Enter their **name** and **contact email** (optionally a plan), then **Create client**.
4. You land on the client's page. Its URL ends in the **client ID**, e.g.
   `/dashboard/clients/clxyz123` — that `clxyz123` part is the ID you'll need next.

### Step 2 — Add an automation to them
On the client's page, scroll to **Automations** → **"+ Add automation"**:
- **Type:** Email triage (the only type right now)
- **Poll every:** how often to check, in minutes (default 5; minimum 1)
- Save.

*(Prefer the terminal? Same thing: `npm run add-automation -- --client their@email.com`)*

### Step 3 — Send the client their connect link
Copy this link (swap in the real client ID from Step 1) and send it to them:
```
http://localhost:3000/onboarding/clxyz123
```
They open it → click **Connect Gmail** → sign into Google → click **Allow** → they
see a green ✓ ("You're all set"). **They never log into your system** — that one
click is all they do. Their Gmail token is encrypted and stored for you.

### Step 4 — Confirm it's wired up
```
npm run doctor
```
For that client you want to see: **gmail connection — active** ✓ and
**email_triage — enabled** ✓. Then make sure the worker (Tab 2) is running.

---

## 4. What the Email triage automation actually does

Every time it polls, for each new **unread** email in the client's inbox it:
- classifies the email (a **category** and an **urgency**),
- applies a Gmail label like **`Triage/support`**, and
- drafts a reply for high-urgency messages (the draft sits in their Gmail, ready
  for a human to review and send).

Results show up in **two places**: the client's **Gmail** (labels + drafts) and your
**dashboard** under the client's **Recent runs** (with status, tokens, and cost).

> Note: if the inbox has no new unread mail, the worker prints nothing and does
> nothing — that silence is normal, not a bug.

---

## 5. Day to day

On the **dashboard** you can:
- see every client's **connection health** (active / expired / revoked),
- see this month's **usage vs. their cap** (calls and dollars),
- read each client's **recent runs**, and
- hit **Pause / Resume** on a client — the kill switch that instantly stops their
  automations.

One worker serves **all** clients at once. To add more clients, repeat Section 3.

---

## 6. Quick test without a real client

To confirm your LLM key and the triage logic work — no Gmail, no client needed:
```
npm run triage:demo
```
It runs the triage prompt against a sample email and prints the result plus the
model, tokens, and cost. Good first thing to run if you're not sure the LLM side
is set up.

---

## 7. Reality check — what's not done yet

- **It's all on `localhost` right now.** The onboarding link only works on your own
  machine, so you can't send it to a real client yet. Putting the app on a real web
  address (deployment) is a later milestone — see §9 (M3/M4) in `CLAUDE.md`.
- **One automation type so far:** Email triage. More types come later (M4).
- **One shared LLM key:** if the AI provider is down or rate-limited, every client
  is affected at once. Failover/limits are part of the guardrails milestone.

---

## 8. Cheat sheet

| Command | What it does |
|---|---|
| `npm run dev` | Start the website (dashboard + onboarding) on `:3000` |
| `npm run worker` | Start the engine — must stay running for automations to happen |
| `npm run doctor` | Preflight check: settings, database, connections, automations, recent runs |
| `npm run add-automation -- --client <email>` | Add an Email triage automation to a client from the terminal |
| `npm run triage:demo` | Test the LLM/triage logic against a sample email (no Gmail needed) |

| Page | URL | Who |
|---|---|---|
| Dashboard | `http://localhost:3000/dashboard` | You (login) |
| New client | Dashboard → "+ New client" | You |
| Client detail | `http://localhost:3000/dashboard/clients/<clientId>` | You |
| Client onboarding | `http://localhost:3000/onboarding/<clientId>` | Your client (no login) |
