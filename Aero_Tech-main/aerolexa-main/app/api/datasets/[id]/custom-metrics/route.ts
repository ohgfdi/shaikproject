import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

/**
 * GET /api/datasets/[id]/custom-metrics
 *
 * List all custom metrics available for this dataset (dataset-scoped, project-scoped, and global).
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset not found.");

    await requireRowRole(ctx, dataset, "VIEWER");

    const projectId = dataset.projectId ?? undefined;

    const metrics = await prisma.customMetric.findMany({
      where: {
        workspaceId: dataset.workspaceId,
        OR: [{ datasetId: params.id }, { isGlobal: true }, { projectId, datasetId: null }],
      },
      orderBy: { createdAt: "desc" },
    });

    return ok({
      metrics: metrics.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        daxExpression: m.daxExpression,
        format: m.format,
        tags: JSON.parse(m.tags || "[]"),
        isGlobal: m.isGlobal,
        datasetId: m.datasetId,
        projectId: m.projectId,
        createdById: m.createdById,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/datasets/[id]/custom-metrics
 *
 * Create a new custom metric for this dataset.
 * Body: { name, description?, daxExpression, format?, tags?, isGlobal? }
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset not found.");

    await requireRowRole(ctx, dataset, "EDITOR");

    const body = await readJsonBody<{
      name?: string;
      description?: string;
      daxExpression?: string;
      format?: "number" | "currency" | "percentage";
      tags?: string[];
      isGlobal?: boolean;
    }>(request);

    const name = (body.name ?? "").trim();
    if (!name) throw new ApiError(400, "VALIDATION", "Name is required");
    if (name.length > 100) throw new ApiError(400, "VALIDATION", "Name too long (max 100 characters)");

    const daxExpression = (body.daxExpression ?? "").trim();
    if (!daxExpression) throw new ApiError(400, "VALIDATION", "DAX expression is required");
    if (daxExpression.length > 5_000)
      throw new ApiError(400, "VALIDATION", "DAX expression too long (max 5,000 characters)");

    const format = body.format ?? "number";
    const tags = body.tags ?? [];

    const metric = await prisma.customMetric.create({
      data: {
        workspaceId: dataset.workspaceId,
        projectId: dataset.projectId ?? null,
        datasetId: params.id,
        name,
        description: body.description?.trim() ?? null,
        daxExpression,
        format,
        tags: JSON.stringify(tags),
        isGlobal: body.isGlobal ?? false,
        createdById: ctx.user.id,
      },
    });

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
