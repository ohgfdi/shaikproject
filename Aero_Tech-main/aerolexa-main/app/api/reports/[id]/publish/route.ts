import { randomUUID } from "crypto";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireEntitlement } from "@/lib/server/entitlements";
import { requirePublishRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

/**
 * POST /api/reports/[id]/publish
 *
 * Publishes a report:
 *   - workspace  → workspace-authenticated view only (no link needed)
 *   - public     → generates a shareToken and a /apps/<token> view-only link
 *
 * Only the project OWNER may opt into a public link.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const report = await prisma.report.findUnique({ where: { id: params.id } });
    if (!report) throw new ApiError(404, "NOT_FOUND", "Report not found.");

    // Publishing (especially public) is an OWNER-level action. Workspace
    // scoping is enforced INSIDE the guard: when the report has no project,
    // only its creator may publish — previously ANY workspace member (and any
    // cross-workspace caller, whose request fell through every check) could
    // flip accessMode to public.
    await requirePublishRole(ctx, report, "Report");

    const body = await readJsonBody<{ accessMode?: "workspace" | "public" }>(request);
    const accessMode = body.accessMode ?? report.accessMode;

    // Public distribution is a Pro/Firm entitlement (capacity gate — the
    // report's computed numbers are identical either way).
    if (accessMode === "public") {
      await requireEntitlement(ctx.workspace.id, "publicShareLinks", { feature: "Public share links" });
    }

    let shareToken = report.shareToken;
    let publishedAt = report.publishedAt;

    if (accessMode === "public") {
      if (!shareToken) {
        shareToken = randomUUID();
        publishedAt = new Date();
      }
    } else {
      shareToken = null;
      publishedAt = null;
    }

    await prisma.report.update({
      where: { id: report.id },
      data: { accessMode, shareToken, publishedAt },
    });

    return ok({
      accessMode,
      shareToken,
      shareUrl: accessMode === "public" && shareToken ? `/apps/${shareToken}` : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/reports/[id]/publish
 * Unpublishes and drops the public link.
 */
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const report = await prisma.report.findUnique({ where: { id: params.id } });
    if (!report) throw new ApiError(404, "NOT_FOUND", "Report not found.");

    // Unpublishing is the same OWNER-level action (SEC-2 guard).
    await requirePublishRole(ctx, report, "Report");

    await prisma.report.update({
      where: { id: report.id },
      data: { accessMode: "workspace", shareToken: null, publishedAt: null },
    });

    return ok({ accessMode: "workspace", shareToken: null, shareUrl: null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
