import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";
import { runScheduleNow } from "@/lib/server/scheduled";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const schedule = await prisma.scheduledReport.findUnique({ where: { id: params.id } });
    if (!schedule || schedule.workspaceId !== ctx.workspace.id) {
      throw new ApiError(404, "NOT_FOUND", "Schedule not found.");
    }
    const outcome = await runScheduleNow(schedule.id);
    return ok(outcome);
  } catch (err) {
    return toErrorResponse(err);
  }
}
