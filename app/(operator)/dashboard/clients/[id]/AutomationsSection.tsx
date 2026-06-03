/**
 * app/(operator)/dashboard/clients/[id]/AutomationsSection.tsx
 *
 * Client Component: lists a client's automations and lets the operator
 *   - add a new automation (type + poll interval),
 *   - enable/disable one (per-automation kill switch),
 *   - remove one.
 *
 * Talks to /api/dashboard/clients/:id/automations[/:automationId]; operator
 * auth is enforced by the Clerk middleware on those routes. No secrets here —
 * only non-sensitive automation settings are shown.
 *
 * MUST stay a Client Component ("use client") — uses useState/useRouter.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./detail.module.css";

// Mirrors lib/automations.ts AUTOMATION_TYPE_META (kept in sync manually — the
// server validates the type regardless, so this list is just the UI menu).
const AUTOMATION_TYPES: Array<{ value: string; label: string; description: string }> = [
  {
    value: "email_triage",
    label: "Email triage",
    description:
      "Polls Gmail, classifies new emails, applies labels, and drafts replies for high-urgency messages.",
  },
];

export interface AutomationView {
  id: string;
  type: string;
  enabled: boolean;
  pollInterval: number;
}

interface Props {
  clientId: string;
  automations: AutomationView[];
}

export default function AutomationsSection({ clientId, automations }: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New-automation form state.
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState(AUTOMATION_TYPES[0].value);
  const [pollMinutes, setPollMinutes] = useState(5);

  // Types that already exist for this client can't be added again (server 409s).
  const existingTypes = new Set(automations.map((a) => a.type));
  const addableTypes = AUTOMATION_TYPES.filter((t) => !existingTypes.has(t.value));

  async function call(url: string, init: RequestInit, busyKey: string) {
    setBusyId(busyKey);
    setError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
      return true;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unexpected error — please retry.");
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function handleAdd() {
    const ok = await call(
      `/api/dashboard/clients/${clientId}/automations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, pollInterval: Math.round(pollMinutes * 60) }),
      },
      "add"
    );
    if (ok) setShowForm(false);
  }

  function handleToggle(a: AutomationView) {
    return call(
      `/api/dashboard/clients/${clientId}/automations/${a.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !a.enabled }),
      },
      a.id
    );
  }

  function handleRemove(a: AutomationView) {
    if (!confirm(`Remove the "${a.type}" automation? Its run history is deleted too.`)) {
      return;
    }
    return call(
      `/api/dashboard/clients/${clientId}/automations/${a.id}`,
      { method: "DELETE" },
      a.id
    );
  }

  return (
    <section className={styles.section}>
      <div className={styles.automationsHeader}>
        <h2 className={styles.sectionTitle}>Automations</h2>
        {addableTypes.length > 0 && (
          <button
            className={styles.addAutomationBtn}
            onClick={() => setShowForm((v) => !v)}
            disabled={busyId !== null}
          >
            {showForm ? "Cancel" : "+ Add automation"}
          </button>
        )}
      </div>

      <div className={styles.sectionBody}>
        {automations.length === 0 && !showForm && (
          <p className={styles.empty}>
            No automations yet. Add one so the worker has something to run for this client.
          </p>
        )}

        {automations.length > 0 && (
          <ul className={styles.automationList}>
            {automations.map((a) => {
              const meta = AUTOMATION_TYPES.find((t) => t.value === a.type);
              const busy = busyId === a.id;
              return (
                <li key={a.id} className={styles.automationRow}>
                  <div>
                    <span className={styles.automationName}>{meta?.label ?? a.type}</span>
                    <span
                      className={`${styles.automationBadge} ${
                        a.enabled ? styles.automationOn : styles.automationOff
                      }`}
                    >
                      {a.enabled ? "enabled" : "disabled"}
                    </span>
                    <span className={styles.automationMeta}>
                      every {Math.round(a.pollInterval / 60)} min
                    </span>
                  </div>
                  <div className={styles.automationActions}>
                    <button onClick={() => handleToggle(a)} disabled={busy}>
                      {busy ? "…" : a.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      className={styles.automationRemove}
                      onClick={() => handleRemove(a)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {showForm && (
          <div className={styles.automationForm}>
            <label className={styles.formField}>
              <span>Type</span>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                {addableTypes.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.formField}>
              <span>Poll every (minutes)</span>
              <input
                type="number"
                min={1}
                value={pollMinutes}
                onChange={(e) => setPollMinutes(Math.max(1, Number(e.target.value)))}
              />
            </label>
            <p className={styles.automationHelp}>
              {AUTOMATION_TYPES.find((t) => t.value === type)?.description}
            </p>
            <button
              className={styles.addAutomationBtn}
              onClick={handleAdd}
              disabled={busyId === "add"}
            >
              {busyId === "add" ? "Adding…" : "Create automation"}
            </button>
          </div>
        )}

        {error && <p className={styles.toggleError}>{error}</p>}
      </div>
    </section>
  );
}
