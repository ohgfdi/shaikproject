import { z } from "zod";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { redact } from "@/lib/server/error-tracking";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/feedback — customer feedback, bug reports and feature requests.
 *
 * One inbox serves all three: `kind` discriminates them. Three separate tables
 * would triple the triage code for no gain, and a feature request IS feedback.
 *
 * Every field goes through the same redaction the error tracker uses, because a
 * user pasting their own URL into a bug report is the single most likely way
 * a share token ends up in a database that a workspace member can read.
 */

const MAX_MESSAGE = 5_000;

const schema = z.object({
  kind: z.enum(["feedback", "bug", "feature"]).default("feedback"),
  message: z.string().trim().min(10).max(MAX_MESSAGE),
  // Free-form context from the client (route, browser, app version). Anything
  // the server did not strip is redacted before it is stored.
  context: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    enforceUserRateLimit(ctx.user.id, "feedback", RATE_LIMITS.feedback);

    const body = schema.parse(await readJsonBody(request));

    // The route is the one context field that matters for triage, and it must
    // lose its query string (see lib/server/error-tracking.ts).
    const context: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body.context ?? {})) {
      if (typeof value !== "string") continue;
      const cleaned =
        key.toLowerCase().includes("path") || key.toLowerCase().includes("url")
          ? value.split("?")[0]!.slice(0, 200)
          : value.slice(0, 300);
      context[key] = redact(cleaned);
    }

    const feedback = await prisma.feedback.create({
      data: {
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        kind: body.kind,
        message: redact(body.message).slice(0, MAX_MESSAGE),
        context: JSON.stringify(context),
      },
      select: { id: true, kind: true, createdAt: true },
    });

    return ok({ feedback });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * GET /api/feedback — the workspace's inbox.
 *
 * Scoped to the caller's workspace, so one tenant can never read another
 * tenant's feedback. A VIEWER may see the inbox (it is their own submission
 * history); only the OWNER may change status (PATCH below).
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind");
    const status = url.searchParams.get("status");

    const feedback = await prisma.feedback.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        ...(kind && ["feedback", "bug", "feature"].includes(kind) ? { kind } : {}),
        ...(status && ["open", "triaged", "resolved", "dismissed"].includes(status) ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        kind: true,
        message: true,
        context: true,
        status: true,
        resolution: true,
        createdAt: true,
        resolvedAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });

    return ok({ feedback });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const patchSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["open", "triaged", "resolved", "dismissed"]),
  resolution: z.string().max(2_000).optional(),
});

/** PATCH — triage status. Requires workspace OWNER: this is an admin action. */
export async function PATCH(request: Request) {
  try {
    const ctx = await requireAuth();
    // OWNER-only triage: an EDITER must not be able to mark a customer's bug
    // report as dismissed. Same assertion the RLS admin route makes — requireAuth
    // already guarantees the workspace belongs to the caller (1:1), so this is a
    // check on the owning relationship rather than a role table lookup.
    const ws = await prisma.workspace.findUnique({
      where: { id: ctx.workspace.id },
      select: { user: { select: { id: true } } },
    });
    if (!ws) throw new ApiError(404, "NOT_FOUND", "Workspace not found.");
    if (ws.user?.id !== ctx.user.id) {
      throw new ApiError(403, "FORBIDDEN", "Only a workspace owner can triage feedback.");
    }
    const body = patchSchema.parse(await readJsonBody(request));

    const existing = await prisma.feedback.findFirst({
      where: { id: body.id, workspaceId: ctx.workspace.id },
      select: { id: true },
    });
    if (!existing) throw new ApiError(404, "NOT_FOUND", "Feedback not found.");

    const updated = await prisma.feedback.update({
      where: { id: body.id },
      data: {
        status: body.status,
        ...(body.resolution ? { resolution: redact(body.resolution) } : {}),
        ...(body.status === "resolved" ? { resolvedAt: new Date() } : {}),
      },
      select: { id: true, status: true, resolvedAt: true },
    });
    return ok({ feedback: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}
