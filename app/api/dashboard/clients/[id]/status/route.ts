/**
 * app/api/dashboard/clients/[id]/status/route.ts — Client status toggle (§6.5, M4).
 *
 * POST /api/dashboard/clients/:id/status
 *
 * Allows the operator to manually set a client's status to "active" or "paused".
 *
 * When resuming (status → "active") after a usage-overage pause, the current-
 * month UsageCounter.pausedForOverageAt is cleared so the auto-pause logic can
 * fire again if the client re-hits the cap (idempotency reset — see lib/usage.ts).
 *
 * Security / auth:
 *   // protected by Clerk middleware (operator-only)
 *   This route is intentionally unauthenticated at the route level; authentication
 *   and operator-only gating are enforced by the Clerk middleware that the
 *   frontend agent adds (middleware.ts). Do NOT add Clerk imports here.
 *
 * force-dynamic: required for Next.js App Router API routes that perform DB
 * writes; prevents static analysis from pre-rendering this path.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ClientStatus } from "@prisma/client";

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function isValidStatus(value: unknown): value is "active" | "paused" {
  return value === "active" || value === "paused";
}

// ---------------------------------------------------------------------------
// POST /api/dashboard/clients/:id/status
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const clientId = params.id;

  // Parse and validate request body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      { error: "Request body must be a JSON object." },
      { status: 400 }
    );
  }

  const { status } = body as Record<string, unknown>;

  if (!isValidStatus(status)) {
    return NextResponse.json(
      { error: 'Invalid status. Must be "active" or "paused".' },
      { status: 400 }
    );
  }

  // -------------------------------------------------------------------------
  // Update the Client record.
  // -------------------------------------------------------------------------
  try {
    const updatedClient = await prisma.client.update({
      where: { id: clientId },
      data: { status: status as ClientStatus },
      select: {
        id: true,
        name: true,
        status: true,
        updatedAt: true,
      },
    });

    // -----------------------------------------------------------------------
    // When resuming (status → "active"): clear the current-month
    // pausedForOverageAt so the auto-pause and 80% alert can fire again if the
    // client re-hits the cap this month. This is the idempotency reset that
    // lib/usage.ts relies on (it only auto-pauses when pausedForOverageAt is
    // null for the current month).
    // -----------------------------------------------------------------------
    if (status === "active") {
      const now = new Date();
      const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

      // Best-effort: if no counter exists yet this month, the update silently
      // finds nothing and that's fine — the next automation run will create it.
      await prisma.usageCounter.updateMany({
        where: {
          clientId,
          month,
          pausedForOverageAt: { not: null },
        },
        data: {
          pausedForOverageAt: null,
        },
      });
    }

    return NextResponse.json({ client: updatedClient });
  } catch (err: unknown) {
    // Record-not-found (Prisma P2025) → 404
    if (
      err instanceof Error &&
      (err.message.includes("Record to update not found") ||
        err.message.includes("P2025"))
    ) {
      return NextResponse.json(
        { error: `Client with id '${clientId}' not found.` },
        { status: 404 }
      );
    }

    console.error(
      `[POST /api/dashboard/clients/${clientId}/status] Unexpected error:`,
      err
    );
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
