/**
 * providers/registry.ts — Multi-provider registry (§6.1, M4).
 *
 * A single place to look up provider configuration and dispatch to the right
 * OAuth module. The OAuth routes and lib/connections.ts both import from here
 * so new providers only need to be registered once.
 *
 * Each registered provider exposes:
 *   - name:        canonical lowercase name (matches the URL segment).
 *   - enum:        the Prisma ConnectionProvider enum value.
 *   - usesPKCE:    true for providers that support/require PKCE (e.g. Google).
 *                  false for providers that don't (e.g. Slack). The OAuth
 *                  callback uses this to decide whether to validate/pass a
 *                  code verifier cookie.
 *   - scopes:      the minimum OAuth scopes we request (§7.5).
 *   - createAuthorizationURL: generates the consent URL + state (+ verifier
 *                  for PKCE providers).
 *   - exchangeCode: exchanges the authorization code for tokens. codeVerifier
 *                  is only passed for PKCE providers.
 *   - refreshAccessToken: optional. Absent for providers whose tokens don't
 *                  expire (Slack bot tokens). Present for providers that
 *                  issue short-lived access tokens (Gmail/Google).
 *
 * Design: we wrap the provider modules rather than re-exporting them so the
 * registry types can stay clean and independent of per-provider quirks.
 * The underlying provider modules keep their existing exports intact so other
 * importers (tests, lib/connections.ts) are not broken.
 */

import { ConnectionProvider } from "@prisma/client";
import {
  createAuthorizationURL as gmailCreateAuthURL,
  exchangeCode as gmailExchangeCode,
  refreshAccessToken as gmailRefreshToken,
  GMAIL_SCOPES,
} from "@/providers/gmail";
import {
  createAuthorizationURL as slackCreateAuthURL,
  exchangeCode as slackExchangeCode,
  SLACK_SCOPES,
} from "@/providers/slack";

// ---------------------------------------------------------------------------
// Shared token result type
// ---------------------------------------------------------------------------

/**
 * Normalised token result returned by every provider's exchangeCode and
 * refreshAccessToken functions.
 *
 *   accessToken   — plaintext credential; never log (§7.2).
 *   refreshToken  — undefined for providers that don't issue one (Slack).
 *   expiresAt     — null for providers with non-expiring tokens (Slack).
 *   scopes        — list of granted OAuth scopes.
 */
export interface TokenResult {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: Date | null;
  scopes: string[];
}

// ---------------------------------------------------------------------------
// Provider entry type
// ---------------------------------------------------------------------------

export interface ProviderEntry {
  /** Canonical lowercase name — matches the `[provider]` URL segment. */
  name: string;
  /** Prisma enum value for Connection.provider. */
  enum: ConnectionProvider;
  /**
   * True for providers that support/require PKCE (Google).
   * False for providers without PKCE (Slack).
   * The OAuth routes use this flag to conditionally set/read the verifier cookie.
   */
  usesPKCE: boolean;
  /** Minimum OAuth scopes requested (§7.5). */
  scopes: string[];
  /**
   * Generates the provider consent URL plus a fresh random state value.
   * For PKCE providers, also generates and returns a code verifier.
   * Non-PKCE providers: codeVerifier will be undefined in the returned object.
   */
  createAuthorizationURL(
    state?: string
  ): { url: URL; state: string; codeVerifier?: string };
  /**
   * Exchanges an authorization code for tokens.
   * For PKCE providers, codeVerifier must be provided.
   * For non-PKCE providers, codeVerifier is ignored (pass undefined).
   */
  exchangeCode(
    code: string,
    codeVerifier?: string
  ): Promise<TokenResult>;
  /**
   * Refreshes an expired access token using the stored refresh token.
   * Optional: absent for providers with non-expiring tokens (Slack).
   * Present for Gmail/Google.
   */
  refreshAccessToken?: (
    refreshToken: string
  ) => Promise<Pick<TokenResult, "accessToken" | "refreshToken" | "expiresAt">>;
}

// ---------------------------------------------------------------------------
// Gmail entry
// ---------------------------------------------------------------------------

const gmailEntry: ProviderEntry = {
  name: "gmail",
  enum: ConnectionProvider.gmail,
  usesPKCE: true,
  scopes: GMAIL_SCOPES,

  createAuthorizationURL() {
    // Gmail's module generates its own state + verifier internally.
    const { url, state, codeVerifier } = gmailCreateAuthURL();
    return { url, state, codeVerifier };
  },

  async exchangeCode(code: string, codeVerifier?: string): Promise<TokenResult> {
    if (!codeVerifier) {
      throw new Error("[registry/gmail] codeVerifier is required for Gmail (PKCE).");
    }
    const result = await gmailExchangeCode(code, codeVerifier);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
      scopes: result.scopes,
    };
  },

  async refreshAccessToken(refreshToken: string) {
    return gmailRefreshToken(refreshToken);
  },
};

// ---------------------------------------------------------------------------
// Slack entry
// ---------------------------------------------------------------------------

const slackEntry: ProviderEntry = {
  name: "slack",
  enum: ConnectionProvider.slack,
  usesPKCE: false,
  scopes: SLACK_SCOPES,

  createAuthorizationURL() {
    // Slack has no PKCE: only state is returned, codeVerifier is absent.
    const { url, state } = slackCreateAuthURL();
    return { url, state };
  },

  async exchangeCode(code: string): Promise<TokenResult> {
    // codeVerifier is intentionally ignored for Slack (no PKCE).
    const result = await slackExchangeCode(code);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
      scopes: result.scopes,
    };
  },

  // refreshAccessToken is intentionally absent: Slack bot tokens do not expire
  // and are not rotated. getValidAccessToken in lib/connections.ts checks for
  // null expiresAt and skips refresh for Slack connections.
};

// ---------------------------------------------------------------------------
// Registry map
// ---------------------------------------------------------------------------

const REGISTRY: ReadonlyMap<string, ProviderEntry> = new Map([
  ["gmail", gmailEntry],
  ["slack", slackEntry],
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the ProviderEntry for the given provider name, or undefined if the
 * provider is not registered.
 *
 * @param name  Lowercase provider name (e.g. "gmail", "slack").
 */
export function getProvider(name: string): ProviderEntry | undefined {
  return REGISTRY.get(name);
}
