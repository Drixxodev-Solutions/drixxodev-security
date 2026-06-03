/**
 * app/oauth/callback/[provider]/route.ts — finish an OAuth connect flow (§6.1, M1).
 *
 * GET /oauth/callback/gmail?code=...&state=...
 *
 * Security-critical order of operations:
 *   1. Validate the `state` parameter against the httpOnly cookie (CSRF — §7.6)
 *      BEFORE any token exchange. Reject on missing/mismatched state.
 *   2. Exchange the `code` for tokens (backend only).
 *   3. ENCRYPT the access + refresh tokens (§7.2) and upsert the Connection.
 *   4. Clear the handshake cookies and redirect back to onboarding.
 *
 * Plaintext tokens and the auth `code` are NEVER logged or placed in a redirect.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { exchangeCode } from "@/providers/gmail";
import { encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { ConnectionProvider } from "@prisma/client";

const SUPPORTED_PROVIDERS = new Set(["gmail"]);

const PROVIDER_ENUM: Record<string, ConnectionProvider> = {
  gmail: ConnectionProvider.gmail,
};

/** Build an absolute redirect URL back to the onboarding page. */
function onboardingRedirect(
  req: NextRequest,
  clientId: string,
  query: string
): NextResponse {
  const base = process.env.APP_BASE_URL ?? req.nextUrl.origin;
  return NextResponse.redirect(`${base}/onboarding/${clientId}?${query}`);
}

/** Clear the three in-flight handshake cookies on a response. */
function clearOAuthCookies(res: NextResponse, provider: string): void {
  for (const name of [
    `oauth_state_${provider}`,
    `oauth_verifier_${provider}`,
    `oauth_client_${provider}`,
  ]) {
    res.cookies.set(name, "", { path: "/", maxAge: 0 });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { provider: string } }
) {
  const { provider } = params;

  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return NextResponse.json(
      { error: `Unsupported provider: ${provider}` },
      { status: 400 }
    );
  }

  const url = req.nextUrl;
  const storedClientId = req.cookies.get(`oauth_client_${provider}`)?.value;

  // The provider can redirect back with its own error (e.g. user denied consent).
  const providerError = url.searchParams.get("error");
  if (providerError) {
    // Don't echo the raw provider error into the page; log it server-side only.
    console.warn(`[oauth/callback] provider returned error for ${provider}`);
    if (storedClientId) {
      const res = onboardingRedirect(req, storedClientId, "error=oauth_denied");
      clearOAuthCookies(res, provider);
      return res;
    }
    return NextResponse.json({ error: "OAuth was cancelled." }, { status: 400 });
  }

  // -------------------------------------------------------------------------
  // STEP 1 — CSRF: validate `state` BEFORE touching the authorization code.
  // A missing cookie, a missing query param, or any mismatch is rejected and
  // NO token exchange happens. This is the §7.6 non-negotiable.
  // -------------------------------------------------------------------------
  const queryState = url.searchParams.get("state");
  const cookieState = req.cookies.get(`oauth_state_${provider}`)?.value;
  const codeVerifier = req.cookies.get(`oauth_verifier_${provider}`)?.value;

  if (
    !queryState ||
    !cookieState ||
    !codeVerifier ||
    queryState !== cookieState
  ) {
    console.warn(`[oauth/callback] state validation failed for ${provider}`);
    if (storedClientId) {
      const res = onboardingRedirect(req, storedClientId, "error=invalid_state");
      clearOAuthCookies(res, provider);
      return res;
    }
    return NextResponse.json(
      { error: "Invalid or expired OAuth state." },
      { status: 400 }
    );
  }

  const code = url.searchParams.get("code");
  if (!code || !storedClientId) {
    if (storedClientId) {
      const res = onboardingRedirect(req, storedClientId, "error=oauth_failed");
      clearOAuthCookies(res, provider);
      return res;
    }
    return NextResponse.json(
      { error: "Missing authorization code." },
      { status: 400 }
    );
  }

  // -------------------------------------------------------------------------
  // STEP 2-3 — Exchange code, ENCRYPT tokens, upsert Connection.
  // -------------------------------------------------------------------------
  try {
    const tokens = await exchangeCode(code, codeVerifier);

    await prisma.connection.upsert({
      where: {
        clientId_provider: {
          clientId: storedClientId,
          provider: PROVIDER_ENUM[provider],
        },
      },
      create: {
        clientId: storedClientId,
        provider: PROVIDER_ENUM[provider],
        encryptedAccessToken: encrypt(tokens.accessToken),
        encryptedRefreshToken: tokens.refreshToken
          ? encrypt(tokens.refreshToken)
          : null,
        tokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        status: "active",
      },
      update: {
        encryptedAccessToken: encrypt(tokens.accessToken),
        // Only overwrite the refresh token if the provider returned a new one;
        // Google often omits it on re-consent, and we must keep the old one.
        ...(tokens.refreshToken
          ? { encryptedRefreshToken: encrypt(tokens.refreshToken) }
          : {}),
        tokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        status: "active",
      },
    });

    const res = onboardingRedirect(
      req,
      storedClientId,
      `connected=${provider}`
    );
    clearOAuthCookies(res, provider);
    return res;
  } catch {
    // Never log token/code values — only a generic failure marker.
    console.error(`[oauth/callback] token exchange/storage failed for ${provider}`);
    const res = onboardingRedirect(req, storedClientId, "error=oauth_failed");
    clearOAuthCookies(res, provider);
    return res;
  }
}
