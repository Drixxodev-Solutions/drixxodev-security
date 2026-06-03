/**
 * app/(operator)/dashboard/clients/new/page.tsx — New client (M4).
 *
 * Operator-only page (protected by Clerk middleware via /dashboard(.*)).
 * Renders the create-client form inside a card. The actual create happens
 * through the existing POST /api/clients route, called by NewClientForm.
 *
 * No DB access here, so no force-dynamic needed — the form does the work.
 */

import Link from "next/link";
import NewClientForm from "./NewClientForm";
import styles from "./new-client.module.css";

export default function NewClientPage() {
  return (
    <div className={styles.page}>
      <Link href="/dashboard" className={styles.back}>
        ← Back to clients
      </Link>
      <h1 className={styles.pageTitle}>New client</h1>
      <p className={styles.pageSubtitle}>
        Create a client record. You can connect their tools afterwards from the
        client&apos;s onboarding link.
      </p>
      <div className={styles.card}>
        <NewClientForm />
      </div>
    </div>
  );
}
