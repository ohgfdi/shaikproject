import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireProjectRole } from "@/lib/server/members";
import { evaluateProjectMeasure } from "@/lib/server/semantic-model";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects/[id]/model/evaluate
 *
 * Evaluate a measure over the project's semantic model with optional
 * RELATED() dimension filters and RLS-style row filters. Body:
 *   { daxExpression: "SUM([Amount])",
 *     relatedFilter?: { relationshipId, values },
 *     rowFilter?: { column, values } }
 *
 * Returns the value plus an "applied" transparency list (which filters ran)
 * so every number can be traced.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    await requireProjectRole(ctx, project, "VIEWER");
    const body = await readJsonBody<{
      daxExpression?: string;
      relatedFilter?: { relationshipId?: string; values?: (string | number | boolean)[] };
      rowFilter?: { column?: string; values?: (string | number | boolean)[] };
    }>(request);

    const daxExpression = (body.daxExpression ?? "").trim();
    if (!daxExpression) {
      return Response.json({ error: { message: "Write a measure expression first." } }, { status: 400 });
    }

    const relatedFilter =
      body.relatedFilter?.relationshipId && body.relatedFilter.values
        ? { relationshipId: body.relatedFilter.relationshipId, values: body.relatedFilter.values }
        : undefined;
    const rowFilter =
      body.rowFilter?.column && body.rowFilter.values
        ? { column: body.rowFilter.column, values: body.rowFilter.values }
        : undefined;

    try {
      const result = await evaluateProjectMeasure({
        workspaceId: ctx.workspace.id,
        projectId: params.id,
        daxExpression,
        relatedFilter,
        rowFilter,
      });
      await logActivity(ctx, "MODEL_MEASURE", `Evaluated “${daxExpression}” on the project model`, params.id, {
        projectId: params.id,
      });
      return ok(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The measure could not be evaluated.";
      return Response.json({ error: { message } }, { status: 400 });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
