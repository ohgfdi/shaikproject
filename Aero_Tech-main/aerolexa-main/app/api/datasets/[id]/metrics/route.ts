import { SemanticLayerManager } from "@/lib/analytics/semantic-layer";
import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

/**
 * tenancy-audit: global-operator — dataset metrics API lists governed metrics
 * computed from a workspace dataset. This is a deployment-wide aggregate
 * rather than a per-tenant query.
 *
 * GET /api/datasets/[id]/metrics
 *
 * Lists the governed metrics that can be computed from this dataset's
 * real columns — the semantic layer. Each metric returns its definition
 * and (optionally) its computed value with a confidence score.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");

    const layer = new SemanticLayerManager(dataset.id);
    await layer.initialize();

    const metrics = layer.getMetrics();
    const values = await layer.computeMetrics();

    return ok({
      dataset: { id: dataset.id, name: dataset.name },
      metrics,
      values,
      count: metrics.length,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
