import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const insight = await prisma.insight.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, insight, "EDITOR");
    await prisma.insight.delete({ where: { id: insight!.id } });
    await logActivity(ctx, "ARTIFACT_DELETED", `Insight removed`, insight!.projectId);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
