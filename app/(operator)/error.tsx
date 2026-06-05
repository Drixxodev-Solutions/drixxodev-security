"use client";

/**
 * app/(operator)/error.tsx — Operator route-group error boundary.
 *
 * Catches uncaught errors thrown while rendering operator pages (e.g. a
 * failed DB query when DATABASE_URL is misconfigured in the deployment
 * environment) and renders a readable message instead of the bare
 * "Application error: a server-side exception has occurred" screen.
 *
 * §7 security: we never render the raw error message or stack here —
 * that could leak connection strings or other internals. The digest is
 * safe to show; it maps to the full error in the server logs.
 */

import { useEffect } from "react";

export default function OperatorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the server/browser console for debugging; the full
    // stack is already captured in the platform's runtime logs.
    console.error("[operator] render error:", error);
  }, [error]);

  return (
    <div
      style={{
        maxWidth: 480,
        margin: "4rem auto",
        padding: "2rem",
        textAlign: "center",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Something went wrong
      </h1>
      <p style={{ color: "#666", marginBottom: "1.5rem" }}>
        The operator dashboard couldn&apos;t load. This is usually a backend
        configuration issue (for example, the database isn&apos;t reachable).
        Check the server logs and try again.
      </p>
      {error.digest && (
        <p style={{ color: "#999", fontSize: "0.8rem", marginBottom: "1.5rem" }}>
          Reference: {error.digest}
        </p>
      )}
      <button
        onClick={reset}
        style={{
          padding: "0.5rem 1.25rem",
          borderRadius: 6,
          border: "1px solid #ccc",
          background: "#fff",
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </div>
  );
}
