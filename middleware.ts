/**
 * middleware.ts — Clerk operator-auth middleware (M4).
 *
 * Protects operator surfaces only:
 *   - /dashboard(...)
 *   - /api/dashboard(...)
 *   - /api/clients(...)
 *
 * Public (NO Clerk required — clients must reach these unauthenticated):
 *   - / (root)
 *   - /onboarding(...)
 *   - /oauth/connect(...)
 *   - /oauth/callback(...)
 *   - /sign-in(...)
 *
 * §2 core principle: clients never need a login to our systems beyond OAuth
 * consent. They must be able to reach onboarding/OAuth without Clerk.
 */

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/api/dashboard(.*)",
  "/api/clients(.*)",
]);

export default clerkMiddleware((auth, req) => {
  if (isProtectedRoute(req)) {
    auth().protect();
  }
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
