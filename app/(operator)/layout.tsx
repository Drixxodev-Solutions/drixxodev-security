/**
 * app/(operator)/layout.tsx — Operator route-group layout (M4).
 *
 * ClerkProvider is scoped HERE — not in the root layout — so that
 * public pages (/, /onboarding/*, /oauth/*) build without Clerk keys
 * (§2 core principle, §7 security rules).
 *
 * This layout wraps:
 *   - /dashboard (operator dashboard)
 *   - /sign-in   (Clerk-hosted sign-in)
 *
 * It renders minimal operator chrome: app name + UserButton.
 * Clerk keys are read from env at runtime; they are never shipped to
 * client components except the public NEXT_PUBLIC_ publishable key
 * which is safe to expose (it is not a secret — it identifies the
 * Clerk frontend API instance).
 */

import { ClerkProvider, UserButton } from "@clerk/nextjs";
import styles from "./operator.module.css";

export const metadata = {
  title: "Drixxodev | Operator",
};

export default function OperatorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <header className={styles.header}>
            <span className={styles.appName}>Drixxodev</span>
            <UserButton afterSignOutUrl="/sign-in" />
          </header>
          <main className={styles.main}>{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}
