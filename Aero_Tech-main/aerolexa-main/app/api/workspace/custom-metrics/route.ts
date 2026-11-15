import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/workspace/custom-metrics
 *
 * List all global custom metrics for the current workspace.
 */
export async function GET(_request: Request) {
  try {
    const ctx = await requireAuth();

    const metrics = await prisma.customMetric.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        isGlobal: true,
      },
      orderBy: { createdAt: "desc" },
      include: {
        dataset: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
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
        datasetName: m.dataset?.name ?? null,
        projectId: m.projectId,
        projectName: m.project?.name ?? null,
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
 * POST /api/workspace/custom-metrics
 *
 * Create a new global custom metric for the workspace.
 * Body: { name, description?, daxExpression, format?, tags?, projectId? }
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();

    const body = await readJsonBody<{
      name?: string;
      description?: string;
      daxExpression?: string;
      format?: "number" | "currency" | "percentage";
      tags?: string[];
      projectId?: string;
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

    // Verify project exists if provided
    if (body.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: body.projectId, workspaceId: ctx.workspace.id },
      });
      if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found");
    }

    const metric = await prisma.customMetric.create({
      data: {
        workspaceId: ctx.workspace.id,
        projectId: body.projectId ?? null,
        datasetId: null,
        name,
        description: body.description?.trim() ?? null,
        daxExpression,
        format,
        tags: JSON.stringify(tags),
        isGlobal: true,
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
