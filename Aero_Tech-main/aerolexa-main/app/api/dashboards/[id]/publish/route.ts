import { randomUUID } from "crypto";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireEntitlement } from "@/lib/server/entitlements";
import { requirePublishRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboards/[id]/publish
 *
 * Publishes a dashboard:
 *   - workspace  → workspace-authenticated view only (no link needed)
 *   - public     → generates a shareToken and a /apps/<token> view-only link
 *
 * Only the project OWNER may opt into a public link. Empty body means
 * "keep current mode"; pass { accessMode: "public" } or "workspace".
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dashboard = await prisma.dashboard.findUnique({ where: { id: params.id } });
    if (!dashboard) throw new ApiError(404, "NOT_FOUND", "Dashboard not found.");

    // Publishing (especially public) is an OWNER-level action, with workspace
    // scoping and a creator check for projectless dashboards (SEC-2 guard).
    await requirePublishRole(ctx, dashboard, "Dashboard");

    const body = await readJsonBody<{ accessMode?: "workspace" | "public" }>(request);
    const accessMode = body.accessMode ?? dashboard.accessMode;

    // Public distribution is a Pro/Firm entitlement (capacity gate).
    if (accessMode === "public") {
      await requireEntitlement(ctx.workspace.id, "publicShareLinks", { feature: "Public share links" });
    }

    let shareToken = dashboard.shareToken;
    let publishedAt = dashboard.publishedAt;

    if (accessMode === "public") {
      if (!shareToken) {
        shareToken = randomUUID();
        publishedAt = new Date();
      }
    } else {
      shareToken = null;
      publishedAt = null;
    }

    await prisma.dashboard.update({
      where: { id: dashboard.id },
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
 * DELETE /api/dashboards/[id]/publish
 * Unpublishes and drops the public link.
 */
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dashboard = await prisma.dashboard.findUnique({ where: { id: params.id } });
    if (!dashboard) throw new ApiError(404, "NOT_FOUND", "Dashboard not found.");

    // Unpublishing is the same OWNER-level action (SEC-2 guard).
    await requirePublishRole(ctx, dashboard, "Dashboard");

    await prisma.dashboard.update({
      where: { id: dashboard.id },
      data: { accessMode: "workspace", shareToken: null, publishedAt: null },
    });

    return ok({ accessMode: "workspace", shareToken: null, shareUrl: null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
