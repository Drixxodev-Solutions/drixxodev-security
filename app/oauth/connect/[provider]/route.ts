/**
 * app/oauth/connect/[provider]/route.ts — start an OAuth connect flow (§6.1, M4).
 *
 * GET /oauth/connect/[provider]?clientId=<id>
 *
 * Generates the provider authorization URL and persists the CSRF `state`
 * server-side as an httpOnly cookie. For PKCE providers (e.g. Gmail) the
 * `codeVerifier` cookie is also set. Non-PKCE providers (e.g. Slack) do NOT
 * use a verifier cookie.
 *
 * The route dispatches through the provider registry (providers/registry.ts)
 * instead of hardcoding Gmail — adding a new provider only requires registering
 * it in the registry.
 *
 * force-dynamic: this route must run per-request (it generates random state and
 * sets cookies); it must never be statically evaluated at build time.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/providers/registry";

// Cookie lifetime for the in-flight OAuth handshake. Short — the user should
// complete consent within a few minutes; stale state must not linger (§7.6).
const OAUTH_COOKIE_MAX_AGE_SECONDS = 600; // 10 minutes

export async function GET(
  req: NextRequest,
  { params }: { params: { provider: string } }
) {
  const { provider } = params;

  // Dispatch through registry — unknown providers return undefined → 400.
  const providerEntry = getProvider(provider);
  if (!providerEntry) {
    return NextResponse.json(
      { error: `Unsupported provider: ${provider}` },
      { status: 400 }
    );
  }

  const clientId = req.nextUrl.searchParams.get("clientId");
  if (!clientId) {
    return NextResponse.json(
      { error: "Missing required query parameter: clientId." },
      { status: 400 }
    );
  }

  let authUrl: URL;
  let state: string;
  let codeVerifier: string | undefined;
  try {
    ({ url: authUrl, state, codeVerifier } = providerEntry.createAuthorizationURL());
  } catch (err) {
    // Misconfiguration (e.g. missing env vars for this provider).
    // Never include error detail in the client response — it may expose config secrets.
    console.error(`[oauth/connect] failed to build authorization URL for ${provider}:`, err);
    return NextResponse.json(
      { error: "OAuth is not configured. Please contact support." },
      { status: 500 }
    );
  }

  // 302 to the provider consent screen, carrying the CSRF/PKCE material in
  // httpOnly cookies so only this server can read them back in the callback.
  const res = NextResponse.redirect(authUrl);

  const cookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: OAUTH_COOKIE_MAX_AGE_SECONDS,
  };

  // Namespaced per provider so concurrent connects for different providers
  // don't collide.
  res.cookies.set(`oauth_state_${provider}`, state, cookieOptions);

  // Only set the verifier cookie for PKCE providers (e.g. Gmail).
  // Non-PKCE providers (e.g. Slack) do not use a verifier.
  if (providerEntry.usesPKCE && codeVerifier) {
    res.cookies.set(`oauth_verifier_${provider}`, codeVerifier, cookieOptions);
  }

  res.cookies.set(`oauth_client_${provider}`, clientId, cookieOptions);

  return res;
}
