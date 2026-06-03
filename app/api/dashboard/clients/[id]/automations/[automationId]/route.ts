/**
 * app/api/dashboard/clients/[id]/automations/[automationId]/route.ts (§6.4, M4).
 *
 * PATCH  /api/dashboard/clients/:id/automations/:automationId
 *        — enable/disable an automation (body: { enabled: boolean }) and/or
 *          change its pollInterval (body: { pollInterval: number }).
 * DELETE /api/dashboard/clients/:id/automations/:automationId
 *        — remove an automation (its Runs cascade-delete per the schema).
 *
 * Disabling is the per-automation kill switch: the worker skips disabled
 * automations, complementing the per-client pause toggle (§6.5).
 *
 * Security / auth:
 *   // protected by Clerk middleware (operator-only)
 *   Operator-only gating is enforced by middleware.ts — do NOT add Clerk here.
 *
 * force-dynamic: required for App Router API routes that perform DB writes.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { normalizePollInterval } from "@/lib/automations";

interface RouteParams {
  params: { id: string; automationId: string };
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id: clientId, automationId } = params;

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
  const data: Prisma.AutomationUpdateInput = {};

  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean." },
        { status: 400 }
      );
    }
    data.enabled = b.enabled;
  }

  if (b.pollInterval !== undefined) {
    const pollInterval = normalizePollInterval(b.pollInterval);
    if (pollInterval === null) {
      return NextResponse.json(
        { error: "pollInterval must be a number of seconds (>= 60)." },
        { status: 400 }
      );
    }
    data.pollInterval = pollInterval;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "Nothing to update. Provide 'enabled' and/or 'pollInterval'." },
      { status: 400 }
    );
  }

  try {
    // updateMany scoped by BOTH ids so an automation can't be mutated via the
    // wrong client's URL; count tells us whether it matched.
    const result = await prisma.automation.updateMany({
      where: { id: automationId, clientId },
      data,
    });
    if (result.count === 0) {
      return NextResponse.json(
        { error: "Automation not found for this client." },
        { status: 404 }
      );
    }
    const automation = await prisma.automation.findUnique({
      where: { id: automationId },
      select: { id: true, type: true, enabled: true, pollInterval: true },
    });
    return NextResponse.json({ automation });
  } catch (err: unknown) {
    console.error(
      `[PATCH .../${clientId}/automations/${automationId}] Unexpected error:`,
      err
    );
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { id: clientId, automationId } = params;
  try {
    const result = await prisma.automation.deleteMany({
      where: { id: automationId, clientId },
    });
    if (result.count === 0) {
      return NextResponse.json(
        { error: "Automation not found for this client." },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    console.error(
      `[DELETE .../${clientId}/automations/${automationId}] Unexpected error:`,
      err
    );
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
