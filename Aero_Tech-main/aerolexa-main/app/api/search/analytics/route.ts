import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { aggregateSearchAnalytics } from "@/lib/search/facets";
import { ok, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

/**
 * Search analytics (search upgrade).
 *
 * GET /api/search/analytics — the workspace's aggregated search behaviour:
 * total queries, zero-hit queries + rate (the "users searched, found
 * nothing" signal) and the top queries. Workspace-scoped: every caller
 * sees only their own workspace's aggregate (the workspace is 1:1 with
 * the account, so no cross-tenant surface exists).
 */
export async function GET() {
  try {
    const ctx = await requireAuth();
    const rows = await prisma.searchQueryLog.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { query: true, hitCount: true, createdAt: true },
    });
    return ok(aggregateSearchAnalytics(rows));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** DELETE /api/search/analytics — clear the workspace's search log. */
export async function DELETE() {
  try {
    const ctx = await requireAuth();
    await prisma.searchQueryLog.deleteMany({ where: { workspaceId: ctx.workspace.id } });
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
