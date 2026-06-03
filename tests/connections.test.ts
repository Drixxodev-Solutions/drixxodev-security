/**
 * tests/connections.test.ts — Priority 3: Refresh-token rotation
 *
 * Tests getValidAccessToken:
 *   - still-valid token → returned without calling refresh
 *   - expired/near-expired token → refresh called, new token re-encrypted + persisted
 *   - refresh failure → connection marked "expired", throws
 *   - no refresh token → connection marked "expired", throws
 *   - no connection → throws
 *   - revoked connection → throws
 *
 * Mocks: @/lib/db (prisma), @/providers/gmail (refreshAccessToken)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Fake encryption key (throwaway — §7.4)
// ---------------------------------------------------------------------------
const FAKE_KEY = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encrypt a token using the real crypto module with the fake key */
async function encryptToken(value: string): Promise<string> {
  process.env.TOKEN_ENCRYPTION_KEY = FAKE_KEY;
  const { encrypt } = await import("@/lib/crypto");
  return encrypt(value);
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFindUnique = vi.fn();
const mockConnectionUpdate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    connection: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockConnectionUpdate(...args),
    },
  },
}));

const mockRefreshGmail = vi.fn();

vi.mock("@/providers/gmail", () => ({
  refreshAccessToken: (...args: unknown[]) => mockRefreshGmail(...args),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Refresh-token rotation — connections (Priority 3)", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = FAKE_KEY;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("returns decrypted access token when token is still valid (no refresh called)", async () => {
    const plainAccessToken = "valid-access-token-abc";
    const encryptedAccess = await encryptToken(plainAccessToken);
    const futureExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 min in future

    mockFindUnique.mockResolvedValue({
      id: "conn-1",
      clientId: "client-1",
      provider: "gmail",
      status: "active",
      encryptedAccessToken: encryptedAccess,
      encryptedRefreshToken: await encryptToken("refresh-token"),
      tokenExpiresAt: futureExpiry,
    });

    const { getValidAccessToken } = await import("@/lib/connections");
    const result = await getValidAccessToken("client-1", "gmail");

    expect(result).toBe(plainAccessToken);
    expect(mockRefreshGmail).not.toHaveBeenCalled();
    expect(mockConnectionUpdate).not.toHaveBeenCalled();
  });

  it("refreshes an expired token, persists new encrypted token, returns fresh value", async () => {
    const oldAccessToken = "expired-access-token";
    const newAccessToken = "fresh-access-token-xyz";
    const newRefreshToken = "new-refresh-token-xyz";
    const newExpiry = new Date(Date.now() + 60 * 60 * 1000);
    const encryptedOldAccess = await encryptToken(oldAccessToken);
    const encryptedRefresh = await encryptToken("old-refresh-token");
    const pastExpiry = new Date(Date.now() - 60 * 1000); // already expired

    mockFindUnique.mockResolvedValue({
      id: "conn-2",
      clientId: "client-2",
      provider: "gmail",
      status: "active",
      encryptedAccessToken: encryptedOldAccess,
      encryptedRefreshToken: encryptedRefresh,
      tokenExpiresAt: pastExpiry,
    });

    mockRefreshGmail.mockResolvedValue({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: newExpiry,
    });

    mockConnectionUpdate.mockResolvedValue({ id: "conn-2" });

    const { getValidAccessToken } = await import("@/lib/connections");
    const result = await getValidAccessToken("client-2", "gmail");

    expect(result).toBe(newAccessToken);
    expect(mockRefreshGmail).toHaveBeenCalledOnce();
    // The new access token must be stored encrypted (not plaintext)
    const updateCall = mockConnectionUpdate.mock.calls[0][0];
    expect(updateCall.data.encryptedAccessToken).not.toBe(newAccessToken);
    expect(updateCall.data.encryptedAccessToken).toBeDefined();
    expect(updateCall.data.status).toBe("active");
    expect(updateCall.data.tokenExpiresAt).toBe(newExpiry);
  });

  it("refreshes token that is within 60s skew window (near-expired)", async () => {
    const newAccessToken = "near-expiry-new-token";
    const encryptedAccess = await encryptToken("near-expired-token");
    const encryptedRefresh = await encryptToken("refresh-tok");
    // Expires in 30 seconds — within 60s skew
    const nearExpiry = new Date(Date.now() + 30 * 1000);

    mockFindUnique.mockResolvedValue({
      id: "conn-3",
      clientId: "client-3",
      provider: "gmail",
      status: "active",
      encryptedAccessToken: encryptedAccess,
      encryptedRefreshToken: encryptedRefresh,
      tokenExpiresAt: nearExpiry,
    });

    mockRefreshGmail.mockResolvedValue({
      accessToken: newAccessToken,
      refreshToken: undefined,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });

    mockConnectionUpdate.mockResolvedValue({ id: "conn-3" });

    const { getValidAccessToken } = await import("@/lib/connections");
    const result = await getValidAccessToken("client-3", "gmail");

    expect(result).toBe(newAccessToken);
    expect(mockRefreshGmail).toHaveBeenCalledOnce();
  });

  it("marks connection as expired and throws when refresh fails", async () => {
    const encryptedAccess = await encryptToken("old-access");
    const encryptedRefresh = await encryptToken("old-refresh");
    const pastExpiry = new Date(Date.now() - 1000);

    mockFindUnique.mockResolvedValue({
      id: "conn-4",
      clientId: "client-4",
      provider: "gmail",
      status: "active",
      encryptedAccessToken: encryptedAccess,
      encryptedRefreshToken: encryptedRefresh,
      tokenExpiresAt: pastExpiry,
    });

    mockRefreshGmail.mockRejectedValue(new Error("Token has been revoked"));
    mockConnectionUpdate.mockResolvedValue({ id: "conn-4" });

    const { getValidAccessToken } = await import("@/lib/connections");
    await expect(getValidAccessToken("client-4", "gmail")).rejects.toThrow(
      /Failed to refresh.*gmail.*client-4/i
    );

    // Must mark connection as expired
    const updateCall = mockConnectionUpdate.mock.calls[0][0];
    expect(updateCall.data.status).toBe("expired");
  });

  it("marks connection as expired and throws when no refresh token is available", async () => {
    const encryptedAccess = await encryptToken("old-access-no-refresh");
    const pastExpiry = new Date(Date.now() - 1000);

    mockFindUnique.mockResolvedValue({
      id: "conn-5",
      clientId: "client-5",
      provider: "gmail",
      status: "active",
      encryptedAccessToken: encryptedAccess,
      encryptedRefreshToken: null, // no refresh token stored
      tokenExpiresAt: pastExpiry,
    });

    mockConnectionUpdate.mockResolvedValue({ id: "conn-5" });

    const { getValidAccessToken } = await import("@/lib/connections");
    await expect(getValidAccessToken("client-5", "gmail")).rejects.toThrow(
      /expired.*no refresh token|re-connect required/i
    );

    // Must mark connection as expired
    const updateCall = mockConnectionUpdate.mock.calls[0][0];
    expect(updateCall.data.status).toBe("expired");
    // Refresh was not called (no token to use)
    expect(mockRefreshGmail).not.toHaveBeenCalled();
  });

  it("throws when no connection found for the client", async () => {
    mockFindUnique.mockResolvedValue(null);

    const { getValidAccessToken } = await import("@/lib/connections");
    await expect(getValidAccessToken("client-no-conn", "gmail")).rejects.toThrow(
      /No gmail connection found/i
    );
    expect(mockRefreshGmail).not.toHaveBeenCalled();
  });

  it("throws when connection status is revoked", async () => {
    mockFindUnique.mockResolvedValue({
      id: "conn-6",
      clientId: "client-6",
      provider: "gmail",
      status: "revoked",
      encryptedAccessToken: "anything",
      encryptedRefreshToken: null,
      tokenExpiresAt: new Date(Date.now() + 3600 * 1000),
    });

    const { getValidAccessToken } = await import("@/lib/connections");
    await expect(getValidAccessToken("client-6", "gmail")).rejects.toThrow(
      /revoked/i
    );
    expect(mockRefreshGmail).not.toHaveBeenCalled();
  });

  it("does not store the new refresh token when provider returns undefined", async () => {
    const newAccessToken = "fresh-no-refresh-token";
    const encryptedAccess = await encryptToken("old-access");
    const encryptedRefresh = await encryptToken("old-refresh");
    const pastExpiry = new Date(Date.now() - 1000);

    mockFindUnique.mockResolvedValue({
      id: "conn-7",
      clientId: "client-7",
      provider: "gmail",
      status: "active",
      encryptedAccessToken: encryptedAccess,
      encryptedRefreshToken: encryptedRefresh,
      tokenExpiresAt: pastExpiry,
    });

    mockRefreshGmail.mockResolvedValue({
      accessToken: newAccessToken,
      refreshToken: undefined, // Google doesn't rotate refresh token
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });

    mockConnectionUpdate.mockResolvedValue({ id: "conn-7" });

    const { getValidAccessToken } = await import("@/lib/connections");
    const result = await getValidAccessToken("client-7", "gmail");

    expect(result).toBe(newAccessToken);
    // encryptedRefreshToken should NOT be in the update data (old one preserved)
    const updateCall = mockConnectionUpdate.mock.calls[0][0];
    expect(updateCall.data.encryptedRefreshToken).toBeUndefined();
  });
});
