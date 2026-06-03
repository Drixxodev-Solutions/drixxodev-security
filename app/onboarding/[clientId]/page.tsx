/**
 * app/onboarding/[clientId]/page.tsx — Client onboarding page (M1).
 *
 * This is the ONLY surface the client ever sees (§6.6).
 * It renders a "Connect Gmail" button that navigates the browser to the backend
 * OAuth route. The browser never handles tokens or the `code` exchange — those
 * stay entirely on the backend (frontend agent hard rule, §7.3).
 *
 * Safe fields only: we select id, name, status from Client and
 * id, provider, status from Connection — NEVER token fields (§7.2).
 *
 * force-dynamic prevents Next.js from statically evaluating the DB query
 * at build time (same pattern as app/api/clients/route.ts).
 */

export const dynamic = "force-dynamic";

import { prisma } from "@/lib/db";
import styles from "./onboarding.module.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageProps {
  params: { clientId: string };
  searchParams: { connected?: string; error?: string };
}

// The only providers required at M1.
const REQUIRED_PROVIDERS = ["gmail"] as const;
type RequiredProvider = (typeof REQUIRED_PROVIDERS)[number];

const PROVIDER_LABELS: Record<RequiredProvider, string> = {
  gmail: "Gmail",
};

// ---------------------------------------------------------------------------
// Data loading (server-side only)
// ---------------------------------------------------------------------------

async function getClientData(clientId: string) {
  // Select only safe, non-sensitive fields — never token columns (§7.2).
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      status: true,
      connections: {
        select: {
          provider: true,
          status: true,
        },
      },
    },
  });
  return client;
}

// ---------------------------------------------------------------------------
// Sub-components (server-rendered, no client state needed)
// ---------------------------------------------------------------------------

function GmailIcon() {
  // Inline SVG — no external asset dependency, no CDN call.
  return (
    <svg
      className={styles.providerIcon}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="20" height="20" rx="3" fill="#EA4335" opacity="0.12" />
      <path
        d="M3 6.5l7 4.5 7-4.5"
        stroke="#EA4335"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="3"
        y="6"
        width="14"
        height="9"
        rx="1.5"
        stroke="#EA4335"
        strokeWidth="1.4"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function OnboardingPage({
  params,
  searchParams,
}: PageProps) {
  const client = await getClientData(params.clientId);

  // 404 — return a friendly card rather than a blank Next.js error page.
  if (!client) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <p className={styles.brand}>Drixxodev</p>
          <div className={styles.notFound}>
            <h1>Page not found</h1>
            <p>
              This onboarding link is invalid or has expired. Please contact
              support to get a new link.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Build a Set of providers the client already has an active Connection for.
  const activeProviders = new Set(
    client.connections
      .filter((c) => c.status === "active")
      .map((c) => c.provider as string)
  );

  const allConnected = REQUIRED_PROVIDERS.every((p) => activeProviders.has(p));

  // Derive banner content from search params returned by the OAuth callback.
  // The backend redirects to this page with ?connected=gmail on success
  // or ?error=<message> on failure.
  const connectedParam = searchParams.connected;
  const errorParam = searchParams.error;

  return (
    <div className={styles.page}>
      <main className={styles.card}>
        {/* Brand */}
        <p className={styles.brand}>Drixxodev</p>

        {/* Heading */}
        <h1 className={styles.title}>Connect your tools</h1>
        <p className={styles.subtitle}>
          Hi {client.name} — grant access once and we handle everything from
          here.
        </p>

        {/* OAuth return banners */}
        {connectedParam && (
          <div
            className={`${styles.banner} ${styles.bannerSuccess}`}
            role="status"
            aria-live="polite"
          >
            <span aria-hidden="true">&#10003;</span>
            <span>
              {PROVIDER_LABELS[connectedParam as RequiredProvider] ??
                connectedParam}{" "}
              connected successfully.
            </span>
          </div>
        )}
        {errorParam && (
          <div
            className={`${styles.banner} ${styles.bannerError}`}
            role="alert"
            aria-live="assertive"
          >
            <span aria-hidden="true">&#33;</span>
            <span>
              Something went wrong connecting your account. Please try again or
              contact support.
            </span>
          </div>
        )}

        {/* Connection list */}
        <ul className={styles.connectionList} aria-label="Required connections">
          {REQUIRED_PROVIDERS.map((provider) => {
            const isConnected = activeProviders.has(provider);
            // OAuth is kicked off by navigating the browser to the backend route.
            // The frontend never receives, stores, or exchanges the OAuth code — §7.
            const connectHref = `/oauth/connect/${provider}?clientId=${client.id}`;

            return (
              <li key={provider} className={styles.connectionRow}>
                <span className={styles.providerLabel}>
                  {provider === "gmail" && <GmailIcon />}
                  {PROVIDER_LABELS[provider]}
                </span>

                {isConnected ? (
                  <span className={styles.connectedBadge} aria-label="Connected">
                    <span aria-hidden="true">&#10003;</span> Connected
                  </span>
                ) : (
                  <a
                    href={connectHref}
                    className={styles.connectButton}
                    aria-label={`Connect ${PROVIDER_LABELS[provider]}`}
                  >
                    Connect {PROVIDER_LABELS[provider]}
                  </a>
                )}
              </li>
            );
          })}
        </ul>

        {/* All-set message once every required provider is active */}
        {allConnected && (
          <div
            className={styles.allSet}
            role="status"
            aria-live="polite"
            aria-label="Setup complete"
          >
            <span aria-hidden="true">&#10003;</span> You&apos;re all set.
          </div>
        )}
      </main>
    </div>
  );
}
