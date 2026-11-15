import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseCron, CronError } from "@/lib/engine/cron";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { toView } from "@/lib/server/scheduled";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const schedule = await prisma.scheduledReport.findUnique({
      where: { id: params.id },
      include: { report: { select: { title: true } }, project: { select: { name: true } } },
    });
    if (!schedule || schedule.workspaceId !== ctx.workspace.id) {
      throw new ApiError(404, "NOT_FOUND", "Schedule not found.");
    }
    const body = await readJsonBody<{
      name?: string;
      cron?: string;
      recipients?: string[];
      enabled?: boolean;
      reportId?: string;
    }>(request);

    const data: {
      name?: string;
      cron?: string;
      recipients?: string;
      enabled?: boolean;
      reportId?: string;
      projectId?: string | null;
    } = {};
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim().slice(0, 120);
    if (typeof body.cron === "string" && body.cron.trim()) {
      try {
        parseCron(body.cron);
      } catch (err) {
        if (err instanceof CronError) throw new ApiError(400, "VALIDATION", err.message);
        throw err;
      }
      data.cron = body.cron.trim();
    }
    if (Array.isArray(body.recipients)) {
      const cleaned = body.recipients
        .map((r) => r.trim())
        .filter(Boolean)
        .slice(0, 20);
      data.recipients = stringifyJson(cleaned);
    }
    if (typeof body.enabled === "boolean") data.enabled = body.enabled;
    if (body.reportId) {
      const report = await prisma.report.findUnique({ where: { id: body.reportId } });
      if (!report || report.workspaceId !== ctx.workspace.id) throw new ApiError(404, "NOT_FOUND", "Report not found.");
      data.reportId = report.id;
      data.projectId = report.projectId;
    }

    const updated = await prisma.scheduledReport.update({ where: { id: schedule.id }, data });
    if (data.enabled === false) {
      await logActivity(ctx, "SCHEDULE_UPDATED", `Schedule “${updated.name}” paused`, schedule.projectId, {
        scheduleId: updated.id,
      });
    }
    const full = await prisma.scheduledReport.findUnique({
      where: { id: updated.id },
      include: { report: { select: { title: true } }, project: { select: { name: true } } },
    });
    return ok({ schedule: toView(full!) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const schedule = await prisma.scheduledReport.findUnique({ where: { id: params.id } });
    if (!schedule || schedule.workspaceId !== ctx.workspace.id) {
      throw new ApiError(404, "NOT_FOUND", "Schedule not found.");
    }
    await prisma.scheduledReport.delete({ where: { id: schedule.id } });
    await logActivity(ctx, "ARTIFACT_DELETED", `Schedule “${schedule.name}” deleted`, schedule.projectId, {
      scheduleId: schedule.id,
    });
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
