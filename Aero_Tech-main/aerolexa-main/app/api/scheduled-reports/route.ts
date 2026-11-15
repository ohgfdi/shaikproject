import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { nextRunAt, parseCron, CronError } from "@/lib/engine/cron";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireEntitlement } from "@/lib/server/entitlements";
import { requireRowRole } from "@/lib/server/members";
import { toView } from "@/lib/server/scheduled";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET() {
  try {
    const ctx = await requireAuth();
    const rows = await prisma.scheduledReport.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { report: { select: { title: true } }, project: { select: { name: true } } },
    });
    return ok({ schedules: rows.map((s) => toView(s)) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    // Scheduled automation is a Pro/Firm entitlement (Pro plan feature list:
    // "Scheduled reports & notebooks").
    await requireEntitlement(ctx.workspace.id, "scheduledReports", { feature: "Scheduled reports" });
    const body = await readJsonBody<{
      name?: string;
      cron?: string;
      reportId?: string;
      recipients?: string[];
      enabled?: boolean;
    }>(request);
    const name = (body.name ?? "").trim();
    if (!name || name.length > 120)
      throw new ApiError(400, "VALIDATION", "Give the schedule a name (max 120 characters).");
    if (!body.reportId) throw new ApiError(400, "VALIDATION", "Pick the report template to run.");
    let parsed;
    try {
      parsed = parseCron(body.cron ?? "");
    } catch (err) {
      if (err instanceof CronError) throw new ApiError(400, "VALIDATION", err.message);
      throw err;
    }
    if (!nextRunAt(parsed))
      throw new ApiError(400, "VALIDATION", "The schedule never fires — check the cron expression.");

    const report = await prisma.report.findUnique({ where: { id: body.reportId } });
    if (!report) throw new ApiError(404, "NOT_FOUND", "Report not found.");
    await requireRowRole(ctx, report, "EDITOR");

    const recipients = (Array.isArray(body.recipients) ? body.recipients : [])
      .map((r) => r.trim())
      .filter((r) => r !== "")
      .slice(0, 20);
    for (const r of recipients) {
      if (!EMAIL_RE.test(r)) throw new ApiError(400, "VALIDATION", `“${r}” is not a valid email address.`);
    }

    const schedule = await prisma.scheduledReport.create({
      data: {
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        projectId: report.projectId,
        reportId: report.id,
        name,
        cron: (body.cron ?? "").trim(),
        recipients: stringifyJson(recipients),
        enabled: body.enabled !== false,
      },
    });
    await logActivity(
      ctx,
      "SCHEDULE_CREATED",
      `Schedule “${schedule.name}” created for “${report.title}”`,
      report.projectId,
      { scheduleId: schedule.id, cron: schedule.cron },
    );
    const full = await prisma.scheduledReport.findUnique({
      where: { id: schedule.id },
      include: { report: { select: { title: true } }, project: { select: { name: true } } },
    });
    return ok({ schedule: toView(full!) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
