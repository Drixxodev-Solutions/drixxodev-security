/**
 * app/(operator)/dashboard/clients/[id]/PauseToggle.tsx
 *
 * Client Component: pause / resume toggle button.
 *
 * POSTs to /api/dashboard/clients/:id/status with the opposite status,
 * then calls router.refresh() to reload the server-rendered page data.
 *
 * Operator auth is enforced by the Clerk middleware on that API route —
 * this component does not need to handle auth itself.
 *
 * This file MUST remain a Client Component ("use client") because it
 * uses useState and useRouter.  No secrets are imported or rendered here.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./detail.module.css";

interface PauseToggleProps {
  clientId: string;
  currentStatus: "active" | "paused";
}

export default function PauseToggle({
  clientId,
  currentStatus,
}: PauseToggleProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextStatus = currentStatus === "active" ? "paused" : "active";
  const label = currentStatus === "active" ? "Pause client" : "Resume client";

  async function handleToggle() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/clients/${clientId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Unexpected error — please retry."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        className={
          currentStatus === "active"
            ? styles.togglePause
            : styles.toggleResume
        }
        onClick={handleToggle}
        disabled={loading}
        aria-label={label}
      >
        {loading ? "Saving…" : label}
      </button>
      {error && <p className={styles.toggleError}>{error}</p>}
    </div>
  );
}
