import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dashboard = await prisma.dashboard.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, dashboard, "EDITOR");
    const copy = await prisma.dashboard.create({
      data: {
        workspaceId: ctx.workspace.id,
        projectId: dashboard!.projectId,
        title: `${dashboard!.title} (copy)`,
        description: dashboard!.description,
        widgets: dashboard!.widgets,
        createdById: ctx.user.id,
      },
    });
    await logActivity(ctx, "DASHBOARD_CREATED", `Dashboard “${copy.title}” duplicated`, dashboard!.projectId, {
      dashboardId: copy.id,
    });
    return ok({ dashboard: { id: copy.id, title: copy.title } }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
