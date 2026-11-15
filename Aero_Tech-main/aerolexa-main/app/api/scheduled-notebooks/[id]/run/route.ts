import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";
import { runScheduledNotebookNow } from "@/lib/server/scheduled-notebook";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const schedule = await prisma.scheduledNotebook.findUnique({ where: { id: params.id } });
    if (!schedule) throw new ApiError(404, "NOT_FOUND", "Schedule not found.");
    await requireRowRole(ctx, schedule, "EDITOR");

    const outcome = await runScheduledNotebookNow(schedule.id);
    return ok(outcome);
  } catch (err) {
    return toErrorResponse(err);
  }
}
