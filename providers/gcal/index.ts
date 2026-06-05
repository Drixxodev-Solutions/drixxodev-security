/**
 * providers/gcal/index.ts — Google Calendar OAuth provider module (§6.1).
 *
 * Uses the `arctic` library (v3) Google provider with PKCE, exactly like the
 * Gmail provider — Google Calendar is the same Google OAuth app, just a
 * different scope. It therefore reuses GOOGLE_OAUTH_CLIENT_ID/SECRET; only the
 * redirect URI segment (/oauth/callback/gcal) and the requested scope differ.
 *
 * -----------------------------------------------------------------------
 * SCOPE JUSTIFICATION (§7.5 — minimum scopes only):
 *
 *   "https://www.googleapis.com/auth/calendar.events"
 *     Grants: read and write events on the user's calendars.
 *     Needed because meeting-prep must: read upcoming events (poll) and write
 *     the generated prep notes back onto the event description (output). This
 *     is the narrowest Calendar scope covering both operations — it does NOT
 *     grant access to calendar settings, ACLs, or other Google services.
 *
 *   NOT requested:
 *     - "https://www.googleapis.com/auth/calendar" — full calendar management
 *       (create/delete calendars, change sharing); not needed.
 *     - Any Gmail, Drive, or Admin scopes.
 * -----------------------------------------------------------------------
 *
 * FLAG (§11): calendar.events is a "sensitive" Google scope, so the OAuth app
 * shows an unverified-app warning until Google's security review is passed.
 * Because Gmail already pulls the app into the sensitive-scope review, adding
 * Calendar to the same app's scope list is incremental, not a new review.
 *
 * Never log tokens or secrets. Credentials are read from env at call time so
 * the module is safe to import without env vars present.
 */

import { Google, generateState, generateCodeVerifier } from "arctic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GcalTokens {
  accessToken: string;
  /** undefined if Google doesn't return a new refresh token (rotation rare) */
  refreshToken: string | undefined;
  expiresAt: Date;
  scopes: string[];
}

// ---------------------------------------------------------------------------
// Scopes (§7.5 — minimum for meeting prep: read events + write descriptions)
// ---------------------------------------------------------------------------

export const GCAL_SCOPES: string[] = [
  "https://www.googleapis.com/auth/calendar.events",
];

// ---------------------------------------------------------------------------
// Provider factory — instantiated per-request so redirect URI is resolved at
// runtime (APP_BASE_URL may not be set at module evaluation time).
// ---------------------------------------------------------------------------

function getRedirectURI(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) {
    throw new Error("APP_BASE_URL env var is not set.");
  }
  return `${base}/oauth/callback/gcal`;
}

function getGoogleProvider(): Google {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET env vars are required."
    );
  }
  return new Google(clientId, clientSecret, getRedirectURI());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a random state token and PKCE code verifier, then returns the
 * Google consent URL for the Calendar scope.
 *
 * The caller MUST persist `state` and `codeVerifier` server-side (httpOnly
 * cookies) and validate them in the callback (§7.6 CSRF guard).
 *
 * `access_type=offline` + `prompt=consent` ensure Google reliably issues a
 * refresh_token so the worker can keep polling without re-consent.
 */
export function createAuthorizationURL(): {
  url: URL;
  state: string;
  codeVerifier: string;
} {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const provider = getGoogleProvider();

  const url = provider.createAuthorizationURL(state, codeVerifier, GCAL_SCOPES);

  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return { url, state, codeVerifier };
}

/**
 * Exchanges an authorization code + PKCE verifier for tokens.
 * NEVER log the returned values — they contain plaintext credentials (§7.2).
 */
export async function exchangeCode(
  code: string,
  codeVerifier: string
): Promise<GcalTokens> {
  const provider = getGoogleProvider();
  // May throw OAuth2RequestError or ArcticFetchError — caller must catch.
  const tokens = await provider.validateAuthorizationCode(code, codeVerifier);

  return {
    accessToken: tokens.accessToken(),
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
    expiresAt: tokens.accessTokenExpiresAt(),
    scopes: tokens.hasScopes() ? tokens.scopes() : GCAL_SCOPES,
  };
}

/**
 * Uses a refresh token to obtain a new access token.
 * Google does not rotate the refresh token on each use, so `refreshToken` is
 * returned as-is (undefined) unless Google unusually returns a new one.
 *
 * NEVER log the input refreshToken or the returned accessToken (§7.2).
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string | undefined; expiresAt: Date }> {
  const provider = getGoogleProvider();
  // May throw OAuth2RequestError or ArcticFetchError — caller must catch.
  const tokens = await provider.refreshAccessToken(refreshToken);

  return {
    accessToken: tokens.accessToken(),
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
    expiresAt: tokens.accessTokenExpiresAt(),
  };
}
