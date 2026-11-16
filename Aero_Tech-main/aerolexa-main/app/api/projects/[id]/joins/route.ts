// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - project join mapping is a deployment-wide aggregate operation
import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { validateJoinMapping, type JoinMapping } from "@/lib/engine/dataset-joins";
import { datasetColumns } from "@/lib/serialize";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireProjectRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    await requireProjectRole(ctx, project, "VIEWER");
    const mappings = await prisma.projectJoinMapping.findMany({
      where: { projectId: params.id, workspaceId: ctx.workspace.id },
      orderBy: { createdAt: "desc" },
    });
    return ok({ mappings });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    await requireProjectRole(ctx, project, "EDITOR");
    if (!project)
      throw new ApiError(
        404,
        "NOT_FOUND",
        "Project not found. What happened: the project you're looking for doesn't exist or has been deleted. How to fix: check the project ID or create a new project.",
      );
    const body = await readJsonBody<{
      leftDatasetId?: string;
      leftColumn?: string;
      rightDatasetId?: string;
      rightColumn?: string;
    }>(request);
    if (!body.leftDatasetId || !body.leftColumn || !body.rightDatasetId || !body.rightColumn) {
      throw new ApiError(
        400,
        "JOIN_INCOMPLETE",
        "Choose both datasets and both join columns. What happened: the join configuration is incomplete. How to fix: select a join key column for each dataset you want to join.",
      );
    }
    if (body.leftDatasetId === body.rightDatasetId)
      throw new ApiError(
        400,
        "JOIN_SAME_DATASET",
        "Choose two different datasets. What happened: you selected the same dataset for both sides of the join. How to fix: select a different dataset for the right side of the join.",
      );
    const datasets = await prisma.dataset.findMany({
      where: {
        id: { in: [body.leftDatasetId, body.rightDatasetId] },
        projectId: params.id,
        workspaceId: ctx.workspace.id,
      },
    });
    if (datasets.length !== 2)
      throw new ApiError(
        400,
        "JOIN_PROJECT_MISMATCH",
        "Both datasets must belong to this project. What happened: one or both datasets are from a different project. How to fix: refresh the project and choose its datasets.",
      );
    const left = datasets.find((dataset) => dataset.id === body.leftDatasetId)!;
    const right = datasets.find((dataset) => dataset.id === body.rightDatasetId)!;
    const leftColumn = datasetColumns(left).find((column) => column.name === body.leftColumn);
    const rightColumn = datasetColumns(right).find((column) => column.name === body.rightColumn);
    if (!leftColumn || !rightColumn)
      throw new ApiError(
        400,
        "JOIN_COLUMN_NOT_FOUND",
        "One join column was not found. What happened: the selected column doesn't exist in the dataset. How to fix: refresh the schema and select an existing column.",
      );
    const [leftLoaded, rightLoaded] = await Promise.all([
      loadParsedDataset(left.id, 50_000),
      loadParsedDataset(right.id, 50_000),
    ]);
    // RLS: join-key value lists are derived from data, so they are filtered
    // like any other read — an unfiltered list would disclose hidden keys.
    const [leftRows, rightRows] = await Promise.all([
      applyRowSecurity(ctx, left, { rows: leftLoaded.rows, columns: datasetColumns(left) }),
      applyRowSecurity(ctx, right, { rows: rightLoaded.rows, columns: datasetColumns(right) }),
    ]);
    const validation = validateJoinMapping({
      leftDatasetId: left.id,
      leftColumn: leftColumn.name,
      leftType: leftColumn.type,
      rightDatasetId: right.id,
      rightColumn: rightColumn.name,
      rightType: rightColumn.type,
      leftValues: leftRows.rows.map(
        (row) => row[datasetColumns(left).findIndex((column) => column.name === leftColumn.name)] ?? null,
      ),
      rightValues: rightRows.rows.map(
        (row) => row[datasetColumns(right).findIndex((column) => column.name === rightColumn.name)] ?? null,
      ),
    } satisfies JoinMapping);
    const mapping = await prisma.projectJoinMapping.create({
      data: {
        workspaceId: ctx.workspace.id,
        projectId: params.id,
        leftDatasetId: left.id,
        leftColumn: leftColumn.name,
        leftType: leftColumn.type,
        rightDatasetId: right.id,
        rightColumn: rightColumn.name,
        rightType: rightColumn.type,
        warnings: JSON.stringify(validation.warnings),
      },
    });
    return ok({ mapping, validation });
  } catch (err) {
    return toErrorResponse(err);
  }
}
