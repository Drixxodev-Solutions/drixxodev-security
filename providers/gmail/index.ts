/**
 * providers/gmail/index.ts — Gmail OAuth provider module (§6.1, M1).
 *
 * Uses the `arctic` library (v3) Google provider, which implements PKCE
 * (code_verifier / code_challenge) as required by Google's OAuth2 spec.
 *
 * -----------------------------------------------------------------------
 * SCOPE JUSTIFICATION (§7.5 — minimum scopes only):
 *
 *   "https://www.googleapis.com/auth/gmail.modify"
 *     Grants: read messages, modify labels, create drafts.
 *     Needed because email triage must: read new emails (poll), apply
 *     labels (categorise), and write draft replies (output). This is the
 *     narrowest Google scope that covers all three M2 operations without
 *     granting send-as or admin capabilities.
 *
 *   "openid"
 *     Needed to get an id_token so we can verify the Google account identity
 *     at connect time (used to detect mis-matched accounts on re-connect).
 *
 *   "email"
 *     Returns the Google account's email address in the id_token / userinfo,
 *     so the operator can display which Gmail account is connected.
 *
 *   NOT requested:
 *     - "https://mail.google.com/" — full mail access including delete and
 *       permanent purge; not needed for triage.
 *     - Any Drive, Calendar, or Admin scopes.
 * -----------------------------------------------------------------------
 *
 * FLAG (§11): google.modify is classified as a "sensitive" scope by Google.
 * The OAuth app will show an unverified-app warning screen until Google's
 * security review is passed. For production with >100 clients, budget time
 * for that review process.
 */

import { Google, generateState, generateCodeVerifier } from "arctic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GmailTokens {
  accessToken: string;
  /** undefined if Google doesn't return a new refresh token (rotation rare) */
  refreshToken: string | undefined;
  expiresAt: Date;
  scopes: string[];
}

// ---------------------------------------------------------------------------
// Scopes (§7.5 — minimum for email triage)
// ---------------------------------------------------------------------------

export const GMAIL_SCOPES: string[] = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
];

// ---------------------------------------------------------------------------
// Provider factory — instantiated per-request so redirect URI is resolved
// at runtime (APP_BASE_URL may not be set at module evaluation time).
// ---------------------------------------------------------------------------

function getRedirectURI(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) {
    throw new Error("APP_BASE_URL env var is not set.");
  }
  return `${base}/oauth/callback/gmail`;
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
 * Google consent URL.
 *
 * The caller MUST persist `state` and `codeVerifier` server-side (e.g. in
 * httpOnly cookies) and validate them in the callback.
 *
 * Google requires `access_type=offline` and `prompt=consent` to reliably
 * issue a refresh_token. arctic's Google provider sets these automatically
 * when you call createAuthorizationURL with a codeVerifier.
 */
export function createAuthorizationURL(): {
  url: URL;
  state: string;
  codeVerifier: string;
} {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const provider = getGoogleProvider();

  const url = provider.createAuthorizationURL(state, codeVerifier, GMAIL_SCOPES);

  // Request offline access so Google returns a refresh_token.
  // arctic sets access_type=offline but does NOT force prompt=consent by
  // default. We add prompt=consent so we always get a refresh_token even
  // on re-authorisation.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return { url, state, codeVerifier };
}

/**
 * Exchanges an authorization code + PKCE verifier for tokens.
 * Returns structured token data ready to encrypt and store.
 *
 * NEVER log the returned values — they contain plaintext credentials (§7.2).
 */
export async function exchangeCode(
  code: string,
  codeVerifier: string
): Promise<GmailTokens> {
  const provider = getGoogleProvider();
  // May throw OAuth2RequestError or ArcticFetchError — caller must catch.
  const tokens = await provider.validateAuthorizationCode(code, codeVerifier);

  return {
    accessToken: tokens.accessToken(),
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
    expiresAt: tokens.accessTokenExpiresAt(),
    scopes: tokens.hasScopes() ? tokens.scopes() : GMAIL_SCOPES,
  };
}

/**
 * Uses a refresh token to obtain a new access token.
 * Google does not rotate the refresh token on each use, so `refreshToken`
 * is returned as-is (undefined) unless Google unusually returns a new one.
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
    // Google rarely rotates refresh tokens; if it does, capture the new one.
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
    expiresAt: tokens.accessTokenExpiresAt(),
  };
}
