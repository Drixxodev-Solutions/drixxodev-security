/**
 * lib/connections.ts — connection token access with auto-refresh (§6.1).
 *
 * `getValidAccessToken` is the single entry point automations use to obtain a
 * usable access token for a client's provider connection. It transparently
 * refreshes an expired (or near-expired) access token using the stored refresh
 * token, re-encrypting and persisting the rotated credentials.
 *
 * Tokens are decrypted only in-memory here and returned to the caller for the
 * duration of one external call; they are never logged (§7.2).
 */

import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { refreshAccessToken as refreshGmailToken } from "@/providers/gmail";
import { ConnectionProvider } from "@prisma/client";

// Refresh slightly before actual expiry to avoid races where a token expires
// mid-request.
const EXPIRY_SKEW_MS = 60_000; // 60 seconds

type ProviderName = "gmail";

// Per-provider refresh dispatch. Extend as providers are added (Slack, ...).
const REFRESHERS: Record<
  ProviderName,
  (
    refreshToken: string
  ) => Promise<{
    accessToken: string;
    refreshToken: string | undefined;
    expiresAt: Date;
  }>
> = {
  gmail: refreshGmailToken,
};

const PROVIDER_ENUM: Record<ProviderName, ConnectionProvider> = {
  gmail: ConnectionProvider.gmail,
};

/**
 * Returns a valid (fresh) plaintext access token for the given client+provider.
 * Refreshes and persists rotated credentials if the current token is expired or
 * within the skew window. Throws a non-sensitive error if no usable connection
 * exists or the refresh fails.
 */
export async function getValidAccessToken(
  clientId: string,
  provider: ProviderName
): Promise<string> {
  const connection = await prisma.connection.findUnique({
    where: {
      clientId_provider: { clientId, provider: PROVIDER_ENUM[provider] },
    },
  });

  if (!connection) {
    throw new Error(`No ${provider} connection found for client ${clientId}.`);
  }
  if (connection.status === "revoked") {
    throw new Error(`The ${provider} connection for client ${clientId} was revoked.`);
  }

  const notYetExpired =
    connection.tokenExpiresAt != null &&
    connection.tokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now();

  if (notYetExpired) {
    // Current access token is still good — decrypt in-memory and return it.
    return decrypt(connection.encryptedAccessToken);
  }

  // Need to refresh. Without a refresh token we can't recover silently.
  if (!connection.encryptedRefreshToken) {
    await markExpired(connection.id);
    throw new Error(
      `The ${provider} access token for client ${clientId} expired and no refresh token is available; re-connect required.`
    );
  }

  try {
    const refreshToken = decrypt(connection.encryptedRefreshToken);
    const refreshed = await REFRESHERS[provider](refreshToken);

    await prisma.connection.update({
      where: { id: connection.id },
      data: {
        encryptedAccessToken: encrypt(refreshed.accessToken),
        // Persist a rotated refresh token only if the provider issued one.
        ...(refreshed.refreshToken
          ? { encryptedRefreshToken: encrypt(refreshed.refreshToken) }
          : {}),
        tokenExpiresAt: refreshed.expiresAt,
        status: "active",
      },
    });

    return refreshed.accessToken;
  } catch {
    // Refresh failed (revoked grant, network error, ...). Flag the connection so
    // the operator/onboarding can prompt a re-connect. Never log token values.
    console.error(`[connections] token refresh failed for ${provider}/${clientId}`);
    await markExpired(connection.id);
    throw new Error(
      `Failed to refresh the ${provider} access token for client ${clientId}.`
    );
  }
}

async function markExpired(connectionId: string): Promise<void> {
  try {
    await prisma.connection.update({
      where: { id: connectionId },
      data: { status: "expired" },
    });
  } catch {
    // Best-effort status update; don't mask the original error.
  }
}
