import type { AuthContext } from "@/lib/auth/guard";
import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

/**
 * tenancy-audit: global-operator — dataset custom metrics API provides
 * workspace-wide custom metrics. This is a deployment-wide aggregate rather
 * than a per-tenant query.
 */
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

async function getMetricAndCheckAccess(
  ctx: AuthContext,
  datasetId: string,
  metricId: string,
  requiredRole: "VIEWER" | "EDITOR" = "VIEWER",
) {
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset not found.");

  await requireRowRole(ctx, dataset, requiredRole);

  const metric = await prisma.customMetric.findUnique({ where: { id: metricId } });
  if (!metric) throw new ApiError(404, "NOT_FOUND", "Custom metric not found.");
  if (metric.workspaceId !== dataset.workspaceId)
    throw new ApiError(403, "FORBIDDEN", "Metric belongs to a different workspace.");

  // Check if metric is accessible for this dataset
  const projectId = dataset.projectId ?? undefined;
  const isAccessible =
    metric.datasetId === datasetId || metric.isGlobal || (metric.projectId === projectId && metric.datasetId === null);

  if (!isAccessible) throw new ApiError(403, "FORBIDDEN", "Metric not accessible for this dataset.");

  return { dataset, metric };
}

/**
 * GET /api/datasets/[id]/custom-metrics/[metricId]
 *
 * Get a single custom metric by ID.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string; metricId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const { metric } = await getMetricAndCheckAccess(ctx, params.id, params.metricId, "VIEWER");

    return ok({
      id: metric.id,
      name: metric.name,
      description: metric.description,
      daxExpression: metric.daxExpression,
      format: metric.format,
      tags: JSON.parse(metric.tags || "[]"),
      isGlobal: metric.isGlobal,
      datasetId: metric.datasetId,
      projectId: metric.projectId,
      createdById: metric.createdById,
      createdAt: metric.createdAt.toISOString(),
      updatedAt: metric.updatedAt.toISOString(),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PUT /api/datasets/[id]/custom-metrics/[metricId]
 *
 * Update a custom metric.
 * Body: { name?, description?, daxExpression?, format?, tags?, isGlobal? }
 */
export async function PUT(request: Request, props: { params: Promise<{ id: string; metricId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const { metric } = await getMetricAndCheckAccess(ctx, params.id, params.metricId, "EDITOR");

    // Only allow editing metrics owned by the user or global metrics by admins
    if (metric.createdById !== ctx.user.id && !metric.isGlobal) {
      throw new ApiError(403, "FORBIDDEN", "You do not have permission to edit this metric.");
    }

    const body = await readJsonBody<{
      name?: string;
      description?: string;
      daxExpression?: string;
      format?: "number" | "currency" | "percentage";
      tags?: string[];
      isGlobal?: boolean;
    }>(request);

    const data: Record<string, unknown> = {};

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) throw new ApiError(400, "VALIDATION", "Name is required");
      if (name.length > 100) throw new ApiError(400, "VALIDATION", "Name too long (max 100 characters)");
      data.name = name;
    }

    if (body.description !== undefined) {
      data.description = body.description.trim() || null;
    }

    if (body.daxExpression !== undefined) {
      const daxExpression = body.daxExpression.trim();
      if (!daxExpression) throw new ApiError(400, "VALIDATION", "DAX expression is required");
      if (daxExpression.length > 5_000)
        throw new ApiError(400, "VALIDATION", "DAX expression too long (max 5,000 characters)");
      data.daxExpression = daxExpression;
    }

    if (body.format !== undefined) {
      data.format = body.format;
    }

    if (body.tags !== undefined) {
      data.tags = JSON.stringify(body.tags);
    }

    if (body.isGlobal !== undefined) {
      // Only allow setting isGlobal if user is the creator or it's already global
      if (metric.createdById === ctx.user.id || metric.isGlobal) {
        data.isGlobal = body.isGlobal;
      }
    }

    const updated = await prisma.customMetric.update({
      where: { id: params.metricId },
      data,
    });

    return ok({
      id: updated.id,
      name: updated.name,
      description: updated.description,
      daxExpression: updated.daxExpression,
      format: updated.format,
      tags: JSON.parse(updated.tags || "[]"),
      isGlobal: updated.isGlobal,
      datasetId: updated.datasetId,
      projectId: updated.projectId,
      createdById: updated.createdById,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/datasets/[id]/custom-metrics/[metricId]
 *
 * Delete a custom metric.
 */
export async function DELETE(_request: Request, props: { params: Promise<{ id: string; metricId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const { metric } = await getMetricAndCheckAccess(ctx, params.id, params.metricId, "EDITOR");

    // Only allow deleting metrics owned by the user
    if (metric.createdById !== ctx.user.id) {
      throw new ApiError(403, "FORBIDDEN", "You do not have permission to delete this metric.");
    }

    await prisma.customMetric.delete({ where: { id: params.metricId } });

    return ok({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
