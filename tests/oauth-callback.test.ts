/**
 * tests/oauth-callback.test.ts — Priority 2: OAuth state validation (CSRF guard §7.6)
 *
 * Tests the GET handler in app/oauth/callback/[provider]/route.ts:
 *   - missing state query param → NO token exchange, error response
 *   - missing state cookie → NO token exchange, error response
 *   - mismatched state → NO token exchange, error response
 *   - valid state → token exchange proceeds, tokens encrypted, Connection upserted
 *   - unsupported provider → 400 immediately
 *   - provider error param → no exchange, error redirect
 *
 * Mocks: @/providers/gmail (exchangeCode), @/lib/crypto (encrypt), @/lib/db (prisma).
 * We assert that exchangeCode is NOT called on bad-state cases — this is the key
 * security assertion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockExchangeCode = vi.fn();
const mockEncrypt = vi.fn((v: string) => `encrypted:${v}`);
const mockConnectionUpsert = vi.fn();

vi.mock("@/providers/gmail", () => ({
  exchangeCode: (...args: unknown[]) => mockExchangeCode(...args),
  // GMAIL_SCOPES is imported by providers/registry.ts — must be present in the mock.
  GMAIL_SCOPES: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"],
  // createAuthorizationURL is imported by providers/registry.ts for the connect route.
  createAuthorizationURL: () => ({
    url: new URL("https://accounts.google.com/"),
    state: "test-state",
    codeVerifier: "test-verifier",
  }),
  refreshAccessToken: vi.fn(),
}));

// providers/slack is imported transitively via providers/registry.ts.
// We stub it here to prevent it from requiring real env vars at import time.
vi.mock("@/providers/slack", () => ({
  SLACK_SCOPES: ["chat:write"],
  createAuthorizationURL: () => ({
    url: new URL("https://slack.com/"),
    state: "test-slack-state",
  }),
  exchangeCode: vi.fn(),
}));

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
  // Set cookies on the request
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

const VALID_STATE = "abc123state";
const VALID_VERIFIER = "pkce-verifier-xyz";
const VALID_CLIENT_ID = "client-1";
const VALID_CODE = "auth-code-from-google";

function validCookies() {
  return {
    oauth_state_gmail: VALID_STATE,
    oauth_verifier_gmail: VALID_VERIFIER,
    oauth_client_gmail: VALID_CLIENT_ID,
  };
}

function validTokens() {
  return {
    accessToken: "ya29.access",
    refreshToken: "1//refresh",
    expiresAt: new Date(Date.now() + 3600 * 1000),
    scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuth callback — CSRF state validation (Priority 2)", () => {
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

  it("valid state → proceeds to token exchange and upserts connection", async () => {
    mockExchangeCode.mockResolvedValue(validTokens());
    mockConnectionUpsert.mockResolvedValue({ id: "conn-1" });

    const { GET } = await import(
      "@/app/oauth/callback/[provider]/route"
    );

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/gmail?code=${VALID_CODE}&state=${VALID_STATE}`,
      cookies: validCookies(),
    });

    const res = await GET(req, { params: { provider: "gmail" } });

    // Must have called exchange
    expect(mockExchangeCode).toHaveBeenCalledOnce();
    expect(mockExchangeCode).toHaveBeenCalledWith(VALID_CODE, VALID_VERIFIER);

    // Tokens must be encrypted before storage
    expect(mockEncrypt).toHaveBeenCalledWith("ya29.access");
    expect(mockEncrypt).toHaveBeenCalledWith("1//refresh");

    // Must upsert connection
    expect(mockConnectionUpsert).toHaveBeenCalledOnce();

    // Must redirect to onboarding (3xx)
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("connected=gmail");
  });

  it("missing state query param → NO token exchange, returns error", async () => {
    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    // No `state` in the URL query
    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/gmail?code=${VALID_CODE}`,
      cookies: validCookies(),
    });

    const res = await GET(req, { params: { provider: "gmail" } });

    expect(mockExchangeCode).not.toHaveBeenCalled();
    // Should be a redirect with error=invalid_state or a 400
    const location = res.headers.get("location") ?? "";
    const isErrorRedirect = location.includes("invalid_state");
    const isErrorJson = res.status === 400;
    expect(isErrorRedirect || isErrorJson).toBe(true);
  });

  it("missing state cookie → NO token exchange, returns error", async () => {
    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const cookiesWithoutState = {
      // oauth_state_gmail intentionally omitted
      oauth_verifier_gmail: VALID_VERIFIER,
      oauth_client_gmail: VALID_CLIENT_ID,
    };

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/gmail?code=${VALID_CODE}&state=${VALID_STATE}`,
      cookies: cookiesWithoutState,
    });

    const res = await GET(req, { params: { provider: "gmail" } });

    expect(mockExchangeCode).not.toHaveBeenCalled();
    const location = res.headers.get("location") ?? "";
    const isErrorRedirect = location.includes("invalid_state");
    const isErrorJson = res.status === 400;
    expect(isErrorRedirect || isErrorJson).toBe(true);
  });

  it("mismatched state (query != cookie) → NO token exchange, returns error", async () => {
    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/gmail?code=${VALID_CODE}&state=WRONG_STATE`,
      cookies: validCookies(), // cookie has VALID_STATE, query has WRONG_STATE
    });

    const res = await GET(req, { params: { provider: "gmail" } });

    expect(mockExchangeCode).not.toHaveBeenCalled();
    const location = res.headers.get("location") ?? "";
    const isErrorRedirect = location.includes("invalid_state");
    const isErrorJson = res.status === 400;
    expect(isErrorRedirect || isErrorJson).toBe(true);
  });

  it("missing code verifier cookie → NO token exchange (state check fails)", async () => {
    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const cookiesWithoutVerifier = {
      oauth_state_gmail: VALID_STATE,
      // oauth_verifier_gmail intentionally omitted
      oauth_client_gmail: VALID_CLIENT_ID,
    };

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/gmail?code=${VALID_CODE}&state=${VALID_STATE}`,
      cookies: cookiesWithoutVerifier,
    });

    const res = await GET(req, { params: { provider: "gmail" } });

    expect(mockExchangeCode).not.toHaveBeenCalled();
  });

  it("unsupported provider → 400 without any exchange", async () => {
    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/slack?code=x&state=y`,
      cookies: {},
    });

    const res = await GET(req, { params: { provider: "slack" } });

    expect(res.status).toBe(400);
    expect(mockExchangeCode).not.toHaveBeenCalled();
  });

  it("provider returns error param → no token exchange, redirects with error", async () => {
    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/gmail?error=access_denied&state=${VALID_STATE}`,
      cookies: validCookies(),
    });

    const res = await GET(req, { params: { provider: "gmail" } });

    expect(mockExchangeCode).not.toHaveBeenCalled();
    // Should redirect with oauth_denied
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=oauth_denied");
  });

  it("plaintext tokens are NOT stored — encrypted values go into upsert", async () => {
    const tokens = validTokens();
    mockExchangeCode.mockResolvedValue(tokens);
    mockConnectionUpsert.mockResolvedValue({ id: "conn-2" });

    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/gmail?code=${VALID_CODE}&state=${VALID_STATE}`,
      cookies: validCookies(),
    });

    await GET(req, { params: { provider: "gmail" } });

    const upsertCall = mockConnectionUpsert.mock.calls[0][0];
    // Stored tokens must be the encrypted versions, not plaintext
    expect(upsertCall.create.encryptedAccessToken).toBe(`encrypted:${tokens.accessToken}`);
    expect(upsertCall.create.encryptedRefreshToken).toBe(`encrypted:${tokens.refreshToken}`);
    expect(upsertCall.create.encryptedAccessToken).not.toBe(tokens.accessToken);
    expect(upsertCall.create.encryptedRefreshToken).not.toBe(tokens.refreshToken);
  });
});
