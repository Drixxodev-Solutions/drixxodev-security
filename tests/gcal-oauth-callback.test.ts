/**
 * tests/gcal-oauth-callback.test.ts — Google Calendar OAuth callback (PKCE)
 *
 * Verifies that the generalised OAuth callback route handles the gcal provider
 * (PKCE, like Gmail) correctly:
 *   1. Rejects bad/missing `state` WITHOUT calling exchangeCode (§7.6 CSRF guard).
 *   2. A missing verifier cookie MUST fail the flow (gcal uses PKCE) — exchange
 *      is NOT called.
 *   3. A valid state + verifier → exchangeCode called with (code, verifier),
 *      tokens encrypted, Connection upserted with an expiry + refresh token.
 *
 * Mocks: @/providers/registry, @/lib/crypto, @/lib/db. No real Google creds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockGcalExchangeCode = vi.fn();
const mockEncrypt = vi.fn((v: string) => `encrypted:${v}`);
const mockConnectionUpsert = vi.fn();

vi.mock("@/providers/registry", () => {
  const { ConnectionProvider } = require("@prisma/client");

  const gcalEntry = {
    name: "gcal",
    enum: ConnectionProvider.gcal,
    usesPKCE: true,
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    createAuthorizationURL: () => ({
      url: new URL("https://accounts.google.com/"),
      state: "test",
      codeVerifier: "verifier",
    }),
    exchangeCode: (...args: unknown[]) => mockGcalExchangeCode(...args),
    refreshAccessToken: vi.fn(),
  };

  return {
    getProvider: (name: string) => (name === "gcal" ? gcalEntry : undefined),
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

const VALID_STATE = "gcal-state-abc123";
const VALID_CLIENT_ID = "client-gcal-1";
const VALID_CODE = "gcal-auth-code-xyz";
const VALID_VERIFIER = "gcal-verifier-123";

function validGcalCookies() {
  return {
    oauth_state_gcal: VALID_STATE,
    oauth_verifier_gcal: VALID_VERIFIER,
    oauth_client_gcal: VALID_CLIENT_ID,
  };
}

function validGcalTokens() {
  return {
    accessToken: "ya29.gcal-access-token",
    refreshToken: "1//gcal-refresh-token",
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
  };
}

describe("OAuth callback — Google Calendar (PKCE)", () => {
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

  it("mismatched state → NO exchangeCode called", async () => {
    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/gcal?code=${VALID_CODE}&state=WRONG`,
      cookies: validGcalCookies(),
    });

    const res = await GET(req, { params: { provider: "gcal" } });

    expect(mockGcalExchangeCode).not.toHaveBeenCalled();
    const location = res.headers.get("location") ?? "";
    expect(location.includes("invalid_state") || res.status === 400).toBe(true);
  });

  it("missing verifier cookie → fails for gcal (PKCE) without exchange", async () => {
    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/gcal?code=${VALID_CODE}&state=${VALID_STATE}`,
      cookies: {
        oauth_state_gcal: VALID_STATE,
        oauth_client_gcal: VALID_CLIENT_ID,
        // oauth_verifier_gcal intentionally absent — PKCE requires it
      },
    });

    const res = await GET(req, { params: { provider: "gcal" } });

    expect(mockGcalExchangeCode).not.toHaveBeenCalled();
    const location = res.headers.get("location") ?? "";
    expect(location.includes("invalid_state") || res.status === 400).toBe(true);
  });

  it("valid state + verifier → exchange(code, verifier), encrypt, upsert with expiry", async () => {
    const tokens = validGcalTokens();
    mockGcalExchangeCode.mockResolvedValue(tokens);
    mockConnectionUpsert.mockResolvedValue({ id: "conn-gcal-1" });

    const { GET } = await import("@/app/oauth/callback/[provider]/route");

    const req = makeRequest({
      url: `${BASE_URL}/oauth/callback/gcal?code=${VALID_CODE}&state=${VALID_STATE}`,
      cookies: validGcalCookies(),
    });

    const res = await GET(req, { params: { provider: "gcal" } });

    // Exchange called with the code AND the PKCE verifier.
    expect(mockGcalExchangeCode).toHaveBeenCalledOnce();
    expect(mockGcalExchangeCode).toHaveBeenCalledWith(VALID_CODE, VALID_VERIFIER);

    // Both tokens encrypted before storage.
    expect(mockEncrypt).toHaveBeenCalledWith(tokens.accessToken);
    expect(mockEncrypt).toHaveBeenCalledWith(tokens.refreshToken);

    // Connection upserted with a non-null expiry (gcal tokens expire).
    expect(mockConnectionUpsert).toHaveBeenCalledOnce();
    const upsertCall = mockConnectionUpsert.mock.calls[0][0];
    expect(upsertCall.create.tokenExpiresAt).toEqual(tokens.expiresAt);
    expect(upsertCall.create.encryptedRefreshToken).toBe(
      `encrypted:${tokens.refreshToken}`
    );

    const location = res.headers.get("location") ?? "";
    expect(location).toContain("connected=gcal");
  });
});
