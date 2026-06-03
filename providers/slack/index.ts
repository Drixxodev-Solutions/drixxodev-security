/**
 * providers/slack/index.ts — Slack OAuth provider module (§6.1, M4).
 *
 * Uses the `arctic` library (v3) Slack provider (OpenID Connect flow) to obtain
 * a Slack access token scoped for bot operations.
 *
 * -----------------------------------------------------------------------
 * SCOPE JUSTIFICATION (§7.5 — minimum scopes only):
 *
 *   "chat:write"
 *     Grants: post messages to channels the bot is a member of.
 *     This is the narrowest Slack scope needed for the automation use-case
 *     (posting triage results or notifications to a client's Slack channel).
 *
 *   NOT requested:
 *     - "channels:read" / "channels:write" — not needed for basic posting.
 *     - "chat:write.public" — would allow posting without joining; not needed.
 *     - Any admin or identity scopes beyond what the flow provides.
 *
 * FLAG (§11 / CLAUDE.md §11): Slack app distribution (publishing to the App
 * Directory or installing in workspaces beyond development) requires Slack's
 * App Review. For internal / invited-client use, a private Slack app is
 * sufficient without review, but OAuth must be scoped correctly and the app
 * settings must have the correct redirect URI configured.
 *
 * TOKEN NATURE: Slack bot tokens issued via the OAuth 2.0 flow do NOT expire
 * and are not rotated (unlike Google access tokens). We store them as
 * encryptedAccessToken with tokenExpiresAt = null and no refresh token.
 * -----------------------------------------------------------------------
 *
 * Never log tokens or secrets. Credentials are read from env at call time so
 * the module is safe to import without env vars present (they're validated on
 * first use).
 */

import { Slack, generateState } from "arctic";

// ---------------------------------------------------------------------------
// Types — re-use the shared shape from the registry
// ---------------------------------------------------------------------------

export interface SlackTokenResult {
  accessToken: string;
  refreshToken: undefined;
  expiresAt: null;
  scopes: string[];
}

// ---------------------------------------------------------------------------
// Scopes (§7.5 — minimum for Slack message posting)
// ---------------------------------------------------------------------------

/**
 * Minimum OAuth scopes this platform requests from Slack.
 * "chat:write" is the only scope needed to post messages on behalf of the bot.
 */
export const SLACK_SCOPES: string[] = ["chat:write"];

// ---------------------------------------------------------------------------
// Provider factory — instantiated per-request so env vars are resolved
// at runtime, not at module load time.
// ---------------------------------------------------------------------------

function getRedirectURI(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) {
    throw new Error("APP_BASE_URL env var is not set.");
  }
  return `${base}/oauth/callback/slack`;
}

function getSlackProvider(): Slack {
  const clientId = process.env.SLACK_OAUTH_CLIENT_ID;
  const clientSecret = process.env.SLACK_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "SLACK_OAUTH_CLIENT_ID and SLACK_OAUTH_CLIENT_SECRET env vars are required."
    );
  }
  return new Slack(clientId, clientSecret, getRedirectURI());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a random state token and returns the Slack consent URL.
 *
 * Slack does NOT support PKCE, so no code verifier is generated or required.
 * The caller MUST persist `state` server-side (e.g. in an httpOnly cookie)
 * and validate it in the callback (§7.6 CSRF guard).
 */
export function createAuthorizationURL(): {
  url: URL;
  state: string;
} {
  const state = generateState();
  const provider = getSlackProvider();
  const url = provider.createAuthorizationURL(state, SLACK_SCOPES);
  return { url, state };
}

/**
 * Exchanges an authorization code for a Slack access token.
 *
 * Slack bot tokens do NOT expire and are not rotated. We therefore return
 * refreshToken = undefined and expiresAt = null. The token is stored encrypted
 * in the Connection table and returned directly by getValidAccessToken without
 * any refresh logic (§6.1).
 *
 * Token extraction strategy: arctic wraps the raw OAuth JSON response in
 * OAuth2Tokens. We call tokens.accessToken() which reads the standard
 * "access_token" field. Slack's OAuth v2 response puts the bot access token
 * in the top-level "access_token" field; the OpenID Connect variant also
 * has it there. If accessToken() throws (missing field), we surface a clear
 * error rather than storing an unusable token.
 *
 * NEVER log the returned accessToken — it is a live plaintext credential (§7.2).
 */
export async function exchangeCode(code: string): Promise<SlackTokenResult> {
  const provider = getSlackProvider();
  // May throw OAuth2RequestError or ArcticFetchError — caller must catch.
  const tokens = await provider.validateAuthorizationCode(code);

  // tokens.accessToken() reads the "access_token" field in the raw JSON
  // response. Throws if absent — that is the correct behaviour (we must not
  // store an empty/undefined token).
  const accessToken = tokens.accessToken();

  return {
    accessToken,
    refreshToken: undefined,
    expiresAt: null,
    scopes: SLACK_SCOPES,
  };
}
