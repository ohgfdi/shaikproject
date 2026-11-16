// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - workspace custom metric management is a deployment-wide aggregate operation
import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

async function getGlobalMetricAndCheckAccess(
  ctx: { user: { id: string }; workspace: { id: string } },
  metricId: string,
  _requiredRole: "VIEWER" | "EDITOR" = "VIEWER",
) {
  const metric = await prisma.customMetric.findUnique({
    where: { id: metricId },
    include: { dataset: { select: { id: true, name: true } }, project: { select: { id: true, name: true } } },
  });
  if (!metric) throw new ApiError(404, "NOT_FOUND", "Custom metric not found.");
  if (metric.workspaceId !== ctx.workspace.id)
    throw new ApiError(403, "FORBIDDEN", "Metric belongs to a different workspace.");
  if (!metric.isGlobal) throw new ApiError(403, "FORBIDDEN", "Metric is not global.");

  return metric;
}

/**
 * GET /api/workspace/custom-metrics/[metricId]
 *
 * Get a single global custom metric by ID.
 */
export async function GET(_request: Request, props: { params: Promise<{ metricId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const metric = await getGlobalMetricAndCheckAccess(ctx, params.metricId, "VIEWER");

    return ok({
      id: metric.id,
      name: metric.name,
      description: metric.description,
      daxExpression: metric.daxExpression,
      format: metric.format,
      tags: JSON.parse(metric.tags || "[]"),
      isGlobal: metric.isGlobal,
      datasetId: metric.datasetId,
      datasetName: metric.dataset?.name ?? null,
      projectId: metric.projectId,
      projectName: metric.project?.name ?? null,
      createdById: metric.createdById,
      createdAt: metric.createdAt.toISOString(),
      updatedAt: metric.updatedAt.toISOString(),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PUT /api/workspace/custom-metrics/[metricId]
 *
 * Update a global custom metric.
 * Body: { name?, description?, daxExpression?, format?, tags?, projectId? }
 */
export async function PUT(request: Request, props: { params: Promise<{ metricId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const metric = await getGlobalMetricAndCheckAccess(ctx, params.metricId, "EDITOR");

    // Only allow editing metrics owned by the user
    if (metric.createdById !== ctx.user.id) {
      throw new ApiError(403, "FORBIDDEN", "You do not have permission to edit this metric.");
    }

    const body = await readJsonBody<{
      name?: string;
      description?: string;
      daxExpression?: string;
      format?: "number" | "currency" | "percentage";
      tags?: string[];
      projectId?: string;
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

    if (body.projectId !== undefined) {
      if (body.projectId) {
        const project = await prisma.project.findUnique({
          where: { id: body.projectId, workspaceId: ctx.workspace.id },
        });
        if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found");
      }
      data.projectId = body.projectId ?? null;
    }

    const updated = await prisma.customMetric.update({
      where: { id: params.metricId },
      data,
      include: { dataset: { select: { id: true, name: true } }, project: { select: { id: true, name: true } } },
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
      datasetName: updated.dataset?.name ?? null,
      projectId: updated.projectId,
      projectName: updated.project?.name ?? null,
      createdById: updated.createdById,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/workspace/custom-metrics/[metricId]
 *
 * Delete a global custom metric.
 */
export async function DELETE(_request: Request, props: { params: Promise<{ metricId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const metric = await getGlobalMetricAndCheckAccess(ctx, params.metricId, "EDITOR");

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
