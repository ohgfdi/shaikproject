import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { toReport } from "@/lib/server/error-tracking";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/errors — ingest a client-side error report.
 *
 * Self-hosted error tracking (see lib/server/error-tracking.ts): reports are
 * redacted, fingerprinted and de-duplicated locally rather than shipped to a
 * third party, which for this app would mean handing a vendor every stack frame
 * and every URL — and the URL is a capability (/apps/<shareToken>).
 *
 * Rate limited per user: without it this is an unbounded write endpoint that
 * any signed-in account could use to fill the operator's database.
 */

const MAX_MESSAGE = 2_000;
const MAX_STACK = 20_000;

const schema = z.object({
  name: z.string().min(1).max(200),
  message: z.string().min(1).max(MAX_MESSAGE),
  // Clients may omit the stack (Firefox does not always provide one).
  stack: z.string().max(MAX_STACK).optional().default(""),
  path: z.string().max(500).optional().default(""),
  requestId: z.string().max(64).optional(),
});

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    enforceUserRateLimit(ctx.user.id, "error_report", RATE_LIMITS.error_report);

    const body = schema.parse(await readJsonBody(request));

    // Reuse the server-side redaction so a client-supplied message cannot slip
    // PII into the store by skipping our own path.
    const err = Object.assign(new Error(body.message), { name: body.name, stack: body.stack || body.message });
    const report = toReport(err, {
      path: body.path,
      ...(body.requestId ? { requestId: body.requestId } : {}),
      userId: ctx.user.id,
      workspaceId: ctx.workspace.id,
    });

    // Aggregate on the fingerprint: a repeat occurrence bumps count/lastSeenAt
    // instead of inserting a row, which is what keeps the table bounded.
    const saved = await prisma.errorReport.upsert({
      where: { fingerprint: report.fingerprint },
      create: { ...report },
      update: {
        lastSeenAt: new Date(),
        count: { increment: 1 },
        // The newest occurrence carries the most useful context (a stack that
        // only appears in production, a path that moved).
        message: report.message,
        stack: report.stack,
        path: report.path,
      },
    });

    // Never echo the stored message back — it is redacted, but there is no
    // reason for the client to receive a copy of its own report.
    return ok({ id: saved.id, fingerprint: report.fingerprint.slice(0, 8) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * GET /api/errors — the operator's triage list.
 *
 * Unresolved first, most frequent first. Reads are workspace-scoped so a
 * tenant's operator sees their own deployment's errors and not another
 * tenant's.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const url = new URL(request.url);
    const includeResolved = url.searchParams.get("all") === "1";

    const reports = await prisma.errorReport.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        ...(includeResolved ? {} : { resolvedAt: null }),
      },
      orderBy: [{ count: "desc" }, { lastSeenAt: "desc" }],
      take: 100,
      select: {
        id: true,
        fingerprint: true,
        name: true,
        message: true,
        path: true,
        count: true,
        firstSeenAt: true,
        lastSeenAt: true,
        resolvedAt: true,
      },
    });

    return ok({ reports });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH /api/errors — resolve/acknowledge a report.
 *
 * Workspace-scoped on the update itself, not just the read: a user who guesses
 * an id from another tenant must get a 404, not silently update it.
 */
const patchSchema = z.object({
  id: z.string().min(1),
  resolved: z.boolean(),
});

export async function PATCH(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = patchSchema.parse(await readJsonBody(request));

    const existing = await prisma.errorReport.findFirst({
      where: { id: body.id, workspaceId: ctx.workspace.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Error report not found." } },
        { status: 404 },
      );
    }

    await prisma.errorReport.update({
      where: { id: body.id },
      data: { resolvedAt: body.resolved ? new Date() : null },
    });
    return ok({ updated: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
