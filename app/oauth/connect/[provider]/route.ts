/**
 * app/oauth/connect/[provider]/route.ts — start an OAuth connect flow (§6.1, M1).
 *
 * GET /oauth/connect/gmail?clientId=<id>
 *
 * Generates the provider authorization URL and persists the CSRF `state` and
 * PKCE `codeVerifier` server-side as httpOnly cookies, then 302-redirects the
 * client's browser to the provider consent screen. The browser never sees or
 * handles tokens — the `code` is exchanged on the backend in the callback (§7.3).
 *
 * force-dynamic: this route must run per-request (it generates random state and
 * sets cookies); it must never be statically evaluated at build time.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createAuthorizationURL } from "@/providers/gmail";

// Cookie lifetime for the in-flight OAuth handshake. Short — the user should
// complete consent within a few minutes; stale state must not linger (§7.6).
const OAUTH_COOKIE_MAX_AGE_SECONDS = 600; // 10 minutes

// Only Gmail is supported at M1. Other providers (Slack, ...) come later.
const SUPPORTED_PROVIDERS = new Set(["gmail"]);

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

  const clientId = req.nextUrl.searchParams.get("clientId");
  if (!clientId) {
    return NextResponse.json(
      { error: "Missing required query parameter: clientId." },
      { status: 400 }
    );
  }

  let authUrl: URL;
  let state: string;
  let codeVerifier: string;
  try {
    ({ url: authUrl, state, codeVerifier } = createAuthorizationURL());
  } catch (err) {
    // Misconfiguration (e.g. missing GOOGLE_OAUTH_* / APP_BASE_URL env vars).
    // Never include the error detail in the client response — it may name secrets.
    console.error("[oauth/connect] failed to build authorization URL:", err);
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

  // Namespaced per provider so concurrent connects don't collide.
  res.cookies.set(`oauth_state_${provider}`, state, cookieOptions);
  res.cookies.set(`oauth_verifier_${provider}`, codeVerifier, cookieOptions);
  res.cookies.set(`oauth_client_${provider}`, clientId, cookieOptions);

  return res;
}
