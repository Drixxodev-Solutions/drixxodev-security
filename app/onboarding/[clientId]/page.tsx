/**
 * app/onboarding/[clientId]/page.tsx — Client onboarding page (M4 polish).
 *
 * This is the ONLY surface the client ever sees (§6.6).
 * It renders "Connect [Provider]" buttons for exactly the providers the
 * client's automations need (derived from automation config.requiredProviders,
 * falling back to ["gmail"] if none are specified).
 *
 * The browser navigates to backend OAuth routes — the frontend never handles
 * tokens or the `code` exchange (frontend agent hard rule, §7.3).
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

// All providers the platform supports (must be registered in providers/registry.ts).
const ALL_PROVIDER_LABELS: Record<string, string> = {
  gmail: "Gmail",
  slack: "Slack",
  gcal: "Google Calendar",
};

// Fallback when no automation specifies requiredProviders.
const DEFAULT_PROVIDERS = ["gmail"];

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
      automations: {
        select: {
          // config is a Json column — cast to unknown, extract requiredProviders
          config: true,
        },
      },
    },
  });
  return client;
}

/**
 * Derive the ordered list of providers needed for this client by inspecting
 * each automation's config.requiredProviders (string[]).
 * If no automation specifies providers, fall back to DEFAULT_PROVIDERS.
 */
function deriveRequiredProviders(
  automations: Array<{ config: unknown }>
): string[] {
  const found = new Set<string>();
  for (const automation of automations) {
    const cfg = automation.config as Record<string, unknown> | null;
    if (
      cfg &&
      Array.isArray(cfg.requiredProviders) &&
      cfg.requiredProviders.length > 0
    ) {
      for (const p of cfg.requiredProviders) {
        if (typeof p === "string") found.add(p);
      }
    }
  }
  if (found.size === 0) return DEFAULT_PROVIDERS;
  return Array.from(found);
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

function SlackIcon() {
  // Inline SVG — Slack brand mark, simplified for 20×20.
  return (
    <svg
      className={styles.providerIcon}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="20" height="20" rx="3" fill="#4A154B" opacity="0.1" />
      {/* Slack hash mark — four rounded bars */}
      <rect x="7.5" y="3.5" width="2" height="6" rx="1" fill="#4A154B" />
      <rect x="10.5" y="3.5" width="2" height="6" rx="1" fill="#4A154B" />
      <rect x="3.5" y="7.5" width="6" height="2" rx="1" fill="#4A154B" />
      <rect x="3.5" y="10.5" width="6" height="2" rx="1" fill="#4A154B" />
      <rect x="7.5" y="10.5" width="2" height="6" rx="1" fill="#4A154B" />
      <rect x="10.5" y="10.5" width="2" height="6" rx="1" fill="#4A154B" />
      <rect x="10.5" y="7.5" width="6" height="2" rx="1" fill="#4A154B" />
      <rect x="10.5" y="10.5" width="6" height="2" rx="1" fill="#4A154B" />
    </svg>
  );
}

function GcalIcon() {
  // Inline SVG — simplified Google Calendar mark, 20×20.
  return (
    <svg
      className={styles.providerIcon}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="3" y="4" width="14" height="13" rx="2" fill="#4285F4" opacity="0.12" />
      <rect
        x="3"
        y="4"
        width="14"
        height="13"
        rx="2"
        stroke="#4285F4"
        strokeWidth="1.4"
      />
      <path d="M3 8h14" stroke="#4285F4" strokeWidth="1.4" />
      <path d="M7 3v3M13 3v3" stroke="#4285F4" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === "gmail") return <GmailIcon />;
  if (provider === "slack") return <SlackIcon />;
  if (provider === "gcal") return <GcalIcon />;
  return null;
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

  // Derive which providers this client needs from their automation configs.
  const requiredProviders = deriveRequiredProviders(client.automations);

  // Build a Set of providers the client already has an active Connection for.
  const activeProviders = new Set(
    client.connections
      .filter((c) => c.status === "active")
      .map((c) => c.provider as string)
  );

  const allConnected = requiredProviders.every((p) => activeProviders.has(p));

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
              {ALL_PROVIDER_LABELS[connectedParam] ?? connectedParam} connected
              successfully.
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

        {/* Connection list — one row per required provider */}
        <ul className={styles.connectionList} aria-label="Required connections">
          {requiredProviders.map((provider) => {
            const isConnected = activeProviders.has(provider);
            const label = ALL_PROVIDER_LABELS[provider] ?? provider;
            // OAuth is kicked off by navigating the browser to the backend route.
            // The frontend never receives, stores, or exchanges the OAuth code — §7.
            const connectHref = `/oauth/connect/${provider}?clientId=${client.id}`;

            return (
              <li key={provider} className={styles.connectionRow}>
                <span className={styles.providerLabel}>
                  <ProviderIcon provider={provider} />
                  {label}
                </span>

                {isConnected ? (
                  <span className={styles.connectedBadge} aria-label="Connected">
                    <span aria-hidden="true">&#10003;</span> Connected
                  </span>
                ) : (
                  <a
                    href={connectHref}
                    className={styles.connectButton}
                    aria-label={`Connect ${label}`}
                  >
                    Connect {label}
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
