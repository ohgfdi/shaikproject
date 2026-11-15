import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { nextRunAt, parseCron, CronError } from "@/lib/engine/cron";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireModule } from "@/lib/server/modules";
import { toScheduledNotebookView } from "@/lib/server/scheduled-notebook";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const schedule = await prisma.scheduledNotebook.findUnique({
      where: { id: params.id },
      include: { notebook: { select: { title: true } }, project: { select: { name: true } } },
    });
    if (!schedule) throw new ApiError(404, "NOT_FOUND", "Schedule not found.");
    if (schedule.workspaceId !== ctx.workspace.id) throw new ApiError(403, "FORBIDDEN", "Not your schedule.");
    return ok({ schedule: toScheduledNotebookView(schedule) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      name?: string;
      cron?: string;
      recipients?: string[];
      enabled?: boolean;
    }>(request);
    const schedule = await prisma.scheduledNotebook.findUnique({ where: { id: params.id } });
    if (!schedule) throw new ApiError(404, "NOT_FOUND", "Schedule not found.");
    if (schedule.workspaceId !== ctx.workspace.id) throw new ApiError(403, "FORBIDDEN", "Not your schedule.");

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name || name.length > 120) throw new ApiError(400, "VALIDATION", "Name must be 1–120 characters.");
    }
    if (body.cron !== undefined) {
      let parsed;
      try {
        parsed = parseCron(body.cron);
      } catch (err) {
        if (err instanceof CronError) throw new ApiError(400, "VALIDATION", err.message);
        throw err;
      }
      if (!nextRunAt(parsed))
        throw new ApiError(400, "VALIDATION", "The schedule never fires — check the cron expression.");
    }
    if (body.recipients !== undefined) {
      const recipients = body.recipients
        .map((r) => r.trim())
        .filter((r) => r !== "")
        .slice(0, 20);
      for (const r of recipients) {
        if (!EMAIL_RE.test(r)) throw new ApiError(400, "VALIDATION", `“${r}” is not a valid email address.`);
      }
    }

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.cron !== undefined) data.cron = body.cron.trim();
    if (body.recipients !== undefined) data.recipients = stringifyJson(body.recipients);
    if (body.enabled !== undefined) data.enabled = body.enabled;

    const updated = await prisma.scheduledNotebook.update({
      where: { id: params.id },
      data,
      include: { notebook: { select: { title: true } }, project: { select: { name: true } } },
    });
    await logActivity(ctx, "SCHEDULE_UPDATED", `Notebook schedule “${updated.name}” updated`, updated.projectId, {
      scheduleId: updated.id,
    });
    return ok({ schedule: toScheduledNotebookView(updated) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const schedule = await prisma.scheduledNotebook.findUnique({ where: { id: params.id } });
    if (!schedule) throw new ApiError(404, "NOT_FOUND", "Schedule not found.");
    if (schedule.workspaceId !== ctx.workspace.id) throw new ApiError(403, "FORBIDDEN", "Not your schedule.");
    await prisma.scheduledNotebook.delete({ where: { id: params.id } });
    await logActivity(ctx, "SCHEDULE_DELETED", `Notebook schedule deleted`, schedule.projectId, {
      scheduleId: params.id,
    });
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
