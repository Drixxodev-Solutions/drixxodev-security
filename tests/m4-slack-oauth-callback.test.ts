/**
 * tests/m4-slack-oauth-callback.test.ts — M4: Slack OAuth callback (non-PKCE)
 *
 * Verifies that the generalised OAuth callback route:
 *   1. Rejects bad/missing `state` for Slack (non-PKCE) without calling
 *      the Slack exchangeCode function (§7.6 CSRF guard — non-negotiable).
 *   2. A missing verifier cookie does NOT fail the Slack flow (Slack has no PKCE).
 *   3. A valid Slack state → exchangeCode called, tokens encrypted, Connection upserted.
 *
 * The key security assertion: exchangeCode is NOT called when state is invalid,
 * regardless of whether the provider uses PKCE.
 *
 * Mocks: @/providers/registry, @/lib/crypto, @/lib/db.
 * No real Slack credentials are used; all external calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockSlackExchangeCode = vi.fn();
const mockGmailExchangeCode = vi.fn();
const mockEncrypt = vi.fn((v: string) => `encrypted:${v}`);
const mockConnectionUpsert = vi.fn();

// Mock the provider registry so the route dispatches to our mock functions.
vi.mock("@/providers/registry", () => {
  const { ConnectionProvider } = require("@prisma/client");

  const slackEntry = {
    name: "slack",
    enum: ConnectionProvider.slack,
    usesPKCE: false,
    scopes: ["chat:write"],
    createAuthorizationURL: () => ({ url: new URL("https://slack.com/"), state: "test" }),
    exchangeCode: (...args: unknown[]) => mockSlackExchangeCode(...args),
  };

  const gmailEntry = {
    name: "gmail",
    enum: ConnectionProvider.gmail,
    usesPKCE: true,
    scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"],
    createAuthorizationURL: () => ({
      url: new URL("https://accounts.google.com/"),
      state: "test",
      codeVerifier: "verifier",
    }),
    exchangeCode: (...args: unknown[]) => mockGmailExchangeCode(...args),
  };

  return {
    getProvider: (name: string) => {
      if (name === "slack") return slackEntry;
      if (name === "gmail") return gmailEntry;
      return undefined;
    },
  };
});

vi.mock("@/lib/crypto", () => ({
  encrypt: (v: string) => mockEncrypt(v),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    connection: {
      upsert: (...args: unknown[]) => mockConnectionUpsert(...args),
    },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://app.example.com";

function makeRequest({
  url,
  cookies = {},
}: {
  url: string;
  cookies?: Record<string, string>;
}): NextRequest {
  const req = new NextRequest(url, { method: "GET" });
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

const VALID_STATE = "slack-state-abc123";
const VALID_CLIENT_ID = "client-slack-1";
const VALID_CODE = "slack-auth-code-xyz";

function validSlackCookies() {
  // No oauth_verifier_slack — Slack does not use PKCE
  return {
    oauth_state_slack: VALID_STATE,
    oauth_client_slack: VALID_CLIENT_ID,
  };
}

function validSlackTokens() {
  return {
    accessToken: "xoxb-slack-bot-token",
    refreshToken: undefined,
    expiresAt: null,
    scopes: ["chat:write"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuth callback — Slack (non-PKCE) state validation (M4)", () => {
  beforeEach(() => {
    process.env.APP_BASE_URL = BASE_URL;
    process.env.TOKEN_ENCRYPTION_KEY =
      "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.APP_BASE_URL;
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  // ---- SECURITY: state must be validated regardless of PKCE ----

  it("missing state query param → NO exchangeCode called for Slack", async () => {
    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/slack?code=${VALID_CODE}`,
      // No state param in URL
      cookies: validSlackCookies(),
    });

    const res = await GET(req, { params: { provider: "slack" } });

    // Exchange must NOT have been called
    expect(mockSlackExchangeCode).not.toHaveBeenCalled();

    // Should be a redirect with invalid_state or a 400
    const location = res.headers.get("location") ?? "";
    const isErrorRedirect = location.includes("invalid_state");
    const isErrorJson = res.status === 400;
    expect(isErrorRedirect || isErrorJson).toBe(true);
  });

  it("missing state cookie → NO exchangeCode called for Slack", async () => {
    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/slack?code=${VALID_CODE}&state=${VALID_STATE}`,
      cookies: {
        // oauth_state_slack intentionally omitted
        oauth_client_slack: VALID_CLIENT_ID,
      },
    });

    const res = await GET(req, { params: { provider: "slack" } });

    expect(mockSlackExchangeCode).not.toHaveBeenCalled();
    const location = res.headers.get("location") ?? "";
    const isErrorRedirect = location.includes("invalid_state");
    const isErrorJson = res.status === 400;
    expect(isErrorRedirect || isErrorJson).toBe(true);
  });

  it("mismatched state (query != cookie) → NO exchangeCode called for Slack", async () => {
    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/slack?code=${VALID_CODE}&state=WRONG_STATE`,
      cookies: validSlackCookies(), // cookie has VALID_STATE, URL has WRONG_STATE
    });

    const res = await GET(req, { params: { provider: "slack" } });

    expect(mockSlackExchangeCode).not.toHaveBeenCalled();
    const location = res.headers.get("location") ?? "";
    const isErrorRedirect = location.includes("invalid_state");
    const isErrorJson = res.status === 400;
    expect(isErrorRedirect || isErrorJson).toBe(true);
  });

  // ---- Non-PKCE: missing verifier cookie must NOT fail the flow ----

  it("missing verifier cookie is OK for Slack (no PKCE) — flow proceeds to exchange", async () => {
    mockSlackExchangeCode.mockResolvedValue(validSlackTokens());
    mockConnectionUpsert.mockResolvedValue({ id: "conn-slack-1" });

    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/slack?code=${VALID_CODE}&state=${VALID_STATE}`,
      cookies: {
        oauth_state_slack: VALID_STATE,
        oauth_client_slack: VALID_CLIENT_ID,
        // NOTE: oauth_verifier_slack is intentionally absent — Slack has no PKCE
      },
    });

    const res = await GET(req, { params: { provider: "slack" } });

    // Exchange MUST have been called (state is valid, no verifier needed)
    expect(mockSlackExchangeCode).toHaveBeenCalledOnce();

    // Must redirect successfully (not an error)
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("connected=slack");
  });

  // ---- Happy path: valid state → full flow completes ----

  it("valid Slack state → proceeds to exchange, tokens encrypted, connection upserted", async () => {
    const tokens = validSlackTokens();
    mockSlackExchangeCode.mockResolvedValue(tokens);
    mockConnectionUpsert.mockResolvedValue({ id: "conn-slack-2" });

    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/slack?code=${VALID_CODE}&state=${VALID_STATE}`,
      cookies: validSlackCookies(),
    });

    const res = await GET(req, { params: { provider: "slack" } });

    // Exchange must have been called with the code (no verifier for Slack)
    expect(mockSlackExchangeCode).toHaveBeenCalledOnce();
    expect(mockSlackExchangeCode).toHaveBeenCalledWith(VALID_CODE, undefined);

    // Access token must be encrypted before storage
    expect(mockEncrypt).toHaveBeenCalledWith(tokens.accessToken);

    // Connection must be upserted
    expect(mockConnectionUpsert).toHaveBeenCalledOnce();

    // refreshToken is undefined for Slack — encryptedRefreshToken should be null
    const upsertCall = mockConnectionUpsert.mock.calls[0][0];
    expect(upsertCall.create.encryptedRefreshToken).toBeNull();
    // expiresAt is null for Slack (non-expiring token)
    expect(upsertCall.create.tokenExpiresAt).toBeNull();

    // Redirect to onboarding success
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("connected=slack");
  });

  // ---- Unknown provider still returns 400 ----

  it("unknown provider → 400 without any exchange", async () => {
    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/unknown?code=x&state=y`,
      cookies: {},
    });

    const res = await GET(req, { params: { provider: "unknown" } });

    expect(res.status).toBe(400);
    expect(mockSlackExchangeCode).not.toHaveBeenCalled();
    expect(mockGmailExchangeCode).not.toHaveBeenCalled();
  });
});
