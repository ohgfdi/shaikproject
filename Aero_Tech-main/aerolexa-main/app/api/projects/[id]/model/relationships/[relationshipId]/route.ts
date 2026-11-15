import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireProjectRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/projects/[id]/model/relationships/[relationshipId]
 *
 * Remove a relationship from the project's semantic model (EDITOR+).
 */
export async function DELETE(_request: Request, props: { params: Promise<{ id: string; relationshipId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    await requireProjectRole(ctx, project, "EDITOR");
    const mapping = await prisma.projectJoinMapping.findFirst({
      where: { id: params.relationshipId, projectId: params.id, workspaceId: ctx.workspace.id },
    });
    if (!mapping) {
      throw new ApiError(404, "NOT_FOUND", "Relationship not found — it may already have been removed.");
    }
    await prisma.projectJoinMapping.delete({ where: { id: mapping.id } });
    await logActivity(
      ctx,
      "MODEL_RELATIONSHIP_REMOVED",
      `Removed relationship ${mapping.leftColumn} → ${mapping.rightColumn}`,
      params.id,
      {
        projectId: params.id,
      },
    );
    return ok({ removed: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
