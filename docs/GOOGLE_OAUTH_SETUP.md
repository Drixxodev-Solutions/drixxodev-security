# Google / Gmail OAuth setup

A hands-on **local** walkthrough to get a real Gmail connected so the
**email_triage** automation can run end to end. This matches how
`providers/gmail/index.ts` is wired — don't change those values unless you also
change the code. For the production go-live version (HTTPS domain, full
checklist) see [`DEPLOYMENT.md`](../DEPLOYMENT.md) §4.

> **Heads-up (CLAUDE.md §11):** `gmail.modify` is a Google **"sensitive" scope**.
> Until your app passes Google's verification review it shows an
> "unverified app" warning and is capped at ~100 users. For testing you bypass
> this by adding yourself as a **Test user** (step 3) — no review needed.

---

## What the code expects

| Thing | Value |
|---|---|
| Redirect URI | `${APP_BASE_URL}/oauth/callback/gmail` — locally `http://localhost:3000/oauth/callback/gmail` |
| Scopes | `openid`, `email`, `https://www.googleapis.com/auth/gmail.modify` |
| Env vars | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `APP_BASE_URL` |

`access_type=offline` + `prompt=consent` (needed to get a refresh token) are
set automatically by the code — you don't configure them in the console.

---

## 1. Create / pick a Google Cloud project
1. Go to <https://console.cloud.google.com/>.
2. Top bar → project picker → **New Project** (or select an existing one).

## 2. Enable the Gmail API
1. **APIs & Services → Library**.
2. Search **Gmail API** → open it → **Enable**.
   (Without this, token exchange succeeds but every Gmail call 403s.)

## 3. Configure the OAuth consent screen
1. **APIs & Services → OAuth consent screen**.
2. **User type: External** → Create.
3. Fill **App name**, **User support email**, **Developer contact email**. Save.
4. **Scopes** step: you can leave it empty for testing (the app requests scopes
   at runtime). Optionally add `.../auth/gmail.modify`, `openid`, `email`.
5. **Test users** step → **Add users** → add the Gmail address(es) you'll
   connect. *This is what lets you click past the "unverified app" screen.*
6. Leave **Publishing status: Testing**.

## 4. Create the OAuth client ID
1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. **Application type: Web application**.
3. **Authorized redirect URIs → Add URI:**
   ```
   http://localhost:3000/oauth/callback/gmail
   ```
   (Add your production URL too when you deploy, e.g.
   `https://app.yourdomain.com/oauth/callback/gmail`.)
4. **Create** → copy the **Client ID** and **Client secret**.

## 5. Put the values in `.env`
```
GOOGLE_OAUTH_CLIENT_ID=<client id>
GOOGLE_OAUTH_CLIENT_SECRET=<client secret>
APP_BASE_URL=http://localhost:3000
```
Restart `npm run dev` (and the worker) so they pick up the new env.

---

## 6. Connect a client's Gmail
1. Create a client (dashboard → **+ New client**, or `POST /api/clients`).
2. Add an **email_triage** automation to that client (dashboard → client →
   **Automations → + Add automation**, or `npm run add-automation -- --client <email>`).
3. Open the client's onboarding page: `http://localhost:3000/onboarding/<clientId>`.
4. Click **Connect Gmail** → Google consent.
   - On the "Google hasn't verified this app" screen (expected while in
     Testing): **Advanced → Go to <app> (unsafe)**. This only appears for
     accounts you added as Test users.
5. You're redirected back to onboarding with `?connected=...`. The tokens are
   stored **encrypted** (`Connection` row) — the page only shows status, never
   the token.

## 7. Run the worker and watch it work
```
npm run worker
```
Every poll interval the worker triages unread inbox mail for connected,
enabled, non-paused clients. You should then see:
- **Dashboard → client → Recent runs** filling with rows (provider/tokens/cost).
- In the connected Gmail: `Triage/<category>` labels, `Triage/urgent` on
  high-urgency mail, and **draft replies** for high-urgency support/sales
  (drafts only — never auto-sent).

---

## Troubleshooting
- **"OAuth is not configured" on Connect Gmail** → `GOOGLE_OAUTH_CLIENT_ID/SECRET`
  or `APP_BASE_URL` not set / app not restarted.
- **`redirect_uri_mismatch`** → the URI in step 4 must match
  `${APP_BASE_URL}/oauth/callback/gmail` exactly (scheme, host, port, path).
- **403 on Gmail calls** → Gmail API not enabled (step 2).
- **No refresh token / connection expires** → make sure you reached the consent
  screen fresh; the code already forces `prompt=consent` to get one.
- **Runs never appear** → worker not running, client is paused, automation is
  disabled, or the monthly usage cap is hit (check the client's Usage panel).

## Quick LLM-only check (no Gmail needed)
```
npm run triage:demo
```
Runs the real triage prompt against a sample email and prints
`summary/category/urgency` + cost — confirms your LLM key works before you
bother with OAuth.
