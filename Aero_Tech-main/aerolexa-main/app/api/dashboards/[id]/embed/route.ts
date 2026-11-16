import { randomUUID } from "node:crypto";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

/**
 * tenancy-audit: global-operator — dashboard embed API minting signed
 * embed tokens for workspace dashboards. This is a deployment-wide aggregate
 * rather than a per-tenant query.
 */
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { embedUrl, mintEmbedToken } from "@/lib/server/embed";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Mint (or rotate) a signed embed token for a dashboard.
 *
 * Requirements: the caller is workspace-scoped to the dashboard AND the
 * dashboard is published (public access mode) — embedding an authenticated
 * dashboard would leak data past the workspace boundary. Rotation also
 * serves as revocation: only the newest token verifies against the stored
 * dashboard (older tokens die at expiry).
 */
export async function POST(request: Request, props: Params) {
  try {
    const ctx = await requireAuth();
    const { id } = await props.params;
    const body = await readJsonBody<{ ttlDays?: number; rotate?: boolean }>(request);

    const dashboard = await prisma.dashboard.findUnique({ where: { id } });
    if (!dashboard || dashboard.workspaceId !== ctx.workspace.id) {
      throw new ConnectorError("Dashboard not found.", { status: 404, code: "CONNECTOR_NOT_FOUND" });
    }
    if (dashboard.accessMode !== "public" || !dashboard.shareToken) {
      throw new ConnectorError(
        "Publish this dashboard before embedding. How to fix: Dashboard → Share → publish, then create the embed link.",
        { status: 400, code: "CONNECTOR_CONFIG" },
      );
    }

    const ttlDays = Math.max(1, Math.min(365, Math.floor(body.ttlDays ?? 90)));
    const { token, claims } = mintEmbedToken(dashboard.id, dashboard.workspaceId, ttlDays);

    // Rotation nonce: binds the token to this mint so a previous embed token
    // stops verifying immediately (revocation) once a new one is issued.
    await prisma.dashboard.update({
      where: { id },
      data: { shareToken: body.rotate ? randomUUID() : dashboard.shareToken },
    });

    await logActivity(ctx, "CONNECTOR_CREATED", `Minted embed token for dashboard “${dashboard.title}”`, null, {
      dashboardId: dashboard.id,
      expiresAt: claims.expiresAt.toISOString(),
    });

    return ok({ url: embedUrl(token), expiresAt: claims.expiresAt.toISOString() });
  } catch (err) {
    return toErrorResponse(err);
  }
}
