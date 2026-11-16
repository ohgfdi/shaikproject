// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - project model management is a deployment-wide aggregate operation
import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireProjectRole } from "@/lib/server/members";
import { loadProjectModel } from "@/lib/server/semantic-model";

export const dynamic = "force-dynamic";

/**
 * GET /api/projects/[id]/model
 *
 * The project's semantic model: tables (the project's datasets),
 * relationships (join mappings interpreted many→one), measures
 * (dataset-scoped custom metrics) and the star-schema issues found by
 * validating every relationship against the real rows.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    await requireProjectRole(ctx, project, "VIEWER");
    const model = await loadProjectModel(ctx.workspace.id, params.id);
    return ok(model);
  } catch (err) {
    return toErrorResponse(err);
  }
}
