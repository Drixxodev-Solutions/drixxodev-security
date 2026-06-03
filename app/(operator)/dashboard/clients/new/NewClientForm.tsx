/**
 * app/(operator)/dashboard/clients/new/NewClientForm.tsx
 *
 * Client Component: create-client form.
 *
 * POSTs to the existing POST /api/clients, then navigates to the new client's
 * detail page on success. Operator auth is enforced by the Clerk middleware on
 * that API route (it matches /api/clients(.*)), so this component does not
 * handle auth itself — the same pattern PauseToggle.tsx relies on.
 *
 * MUST remain a Client Component ("use client") because it uses useState and
 * useRouter. No secrets are imported or rendered here.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./new-client.module.css";

interface CreatedClient {
  id: string;
}

export default function NewClientForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [plan, setPlan] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          contactEmail,
          ...(plan.trim() ? { plan: plan.trim() } : {}),
        }),
      });
      const data = (await res.json()) as {
        client?: CreatedClient;
        error?: string;
      };
      if (!res.ok || !data.client) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      router.push(`/dashboard/clients/${data.client.id}`);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Unexpected error — please retry."
      );
      setLoading(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <label className={styles.field}>
        <span className={styles.label}>Name</span>
        <input
          className={styles.input}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Co."
          required
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Contact email</span>
        <input
          className={styles.input}
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          placeholder="owner@acme.com"
          required
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>
          Plan <span className={styles.optional}>(optional)</span>
        </span>
        <input
          className={styles.input}
          type="text"
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          placeholder="starter"
        />
      </label>

      {error && <p className={styles.error}>{error}</p>}

      <button className={styles.submit} type="submit" disabled={loading}>
        {loading ? "Creating…" : "Create client"}
      </button>
    </form>
  );
}
