/**
 * app/(operator)/sign-in/[[...sign-in]]/page.tsx — Operator sign-in (M4).
 *
 * Renders the Clerk <SignIn /> component, centered on screen.
 * Only the operator accesses this page — clients never log in (§2).
 *
 * The catch-all route `[[...sign-in]]` is required by Clerk so that
 * multi-step sign-in flows (e.g. email code verification) render
 * correctly within our app rather than redirecting out.
 */

import { SignIn } from "@clerk/nextjs";
import styles from "./sign-in.module.css";

export default function SignInPage() {
  return (
    <div className={styles.page}>
      <SignIn />
    </div>
  );
}
