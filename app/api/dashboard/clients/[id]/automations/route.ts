/**
 * app/api/dashboard/clients/[id]/automations/route.ts — Automation create/list (§6.4, M4).
 *
 * POST /api/dashboard/clients/:id/automations  — attach a new automation to a client.
 * GET  /api/dashboard/clients/:id/automations  — list a client's automations.
 *
 * This is the missing link between "create a client" and "the worker runs
 * something": the worker (worker/index.ts) only polls Automation rows that
 * exist and are enabled, so a client with no Automation never produces a Run.
 *
 * Security / auth:
 *   // protected by Clerk middleware (operator-only)
 *   Like the sibling status route, this route is intentionally unauthenticated
 *   at the route level; operator-only gating is enforced by middleware.ts.
 *   Do NOT add Clerk imports here.
 *
 * No secrets are read or returned here — config is non-sensitive automation
 * settings only (never tokens or prompts).
 *
 * force-dynamic: required for App Router API routes that perform DB writes.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { AutomationType, Prisma } from "@prisma/client";
import {
  buildAutomationConfig,
  isValidAutomationType,
  normalizePollInterval,
} from "@/lib/automations";

// ---------------------------------------------------------------------------
// POST /api/dashboard/clients/:id/automations
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const clientId = params.id;

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

  const b = body as Record<string, unknown>;

  if (!isValidAutomationType(b.type)) {
    return NextResponse.json(
      {
        error: `Invalid automation type. Supported: ${Object.values(
          AutomationType
        ).join(", ")}.`,
      },
      { status: 400 }
    );
  }

  // pollInterval is optional; clamp to a safe floor so we never hammer a provider.
  const pollInterval = normalizePollInterval(b.pollInterval);
  if (pollInterval === null) {
    return NextResponse.json(
      { error: "pollInterval must be a number of seconds (>= 60)." },
      { status: 400 }
    );
  }

  // Merge caller-supplied config over the type's safe defaults (incl. the
  // requiredProviders the onboarding page reads to know which buttons to show).
  let config: Prisma.JsonObject;
  try {
    config = buildAutomationConfig(b.type, b.config);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid config." },
      { status: 400 }
    );
  }

  const enabled = typeof b.enabled === "boolean" ? b.enabled : true;

  try {
    // Guard against creating a duplicate automation of the same type for a client.
    const existing = await prisma.automation.findFirst({
      where: { clientId, type: b.type },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        {
          error: `This client already has a '${b.type}' automation. Edit or remove it first.`,
        },
        { status: 409 }
      );
    }

    const automation = await prisma.automation.create({
      data: { clientId, type: b.type, config, pollInterval, enabled },
      select: {
        id: true,
        type: true,
        enabled: true,
        pollInterval: true,
        config: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ automation }, { status: 201 });
  } catch (err: unknown) {
    // Foreign-key violation → client doesn't exist (P2003).
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2003"
    ) {
      return NextResponse.json(
        { error: `Client with id '${clientId}' not found.` },
        { status: 404 }
      );
    }
    console.error(
      `[POST /api/dashboard/clients/${clientId}/automations] Unexpected error:`,
      err
    );
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/dashboard/clients/:id/automations
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const clientId = params.id;
  try {
    const automations = await prisma.automation.findMany({
      where: { clientId },
      select: {
        id: true,
        type: true,
        enabled: true,
        pollInterval: true,
        config: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ automations });
  } catch (err: unknown) {
    console.error(
      `[GET /api/dashboard/clients/${clientId}/automations] Unexpected error:`,
      err
    );
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
