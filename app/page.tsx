/**
 * app/page.tsx — Public root landing.
 *
 * The only public, unauthenticated face of the platform. It is the doorway
 * into the operator portal — it links to /dashboard, which the Clerk
 * middleware redirects to sign-in for unauthenticated visitors.
 *
 * This page is a plain server component: the root layout has NO ClerkProvider
 * (it is scoped to the (operator) route group), so nothing here may use Clerk
 * hooks or components. No internal details (prompts, keys, how-it-works) are
 * exposed here — §2 core principle, §7 security rules.
 */

import Link from "next/link";
import styles from "./home.module.css";

export default function HomePage() {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <p className={styles.brand}>Drixxodev</p>
        <h1 className={styles.title}>Managed automation platform</h1>
        <p className={styles.subtitle}>
          AI-powered automations, run and monitored on your behalf.
        </p>
        <Link href="/dashboard" className={styles.cta}>
          Open operator dashboard
        </Link>
      </div>
    </main>
  );
}
