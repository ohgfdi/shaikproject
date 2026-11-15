import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { nextRunAt, parseCron, CronError } from "@/lib/engine/cron";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";
import { toScheduledNotebookView } from "@/lib/server/scheduled-notebook";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET() {
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const rows = await prisma.scheduledNotebook.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { notebook: { select: { title: true } }, project: { select: { name: true } } },
    });
    return ok({ schedules: rows.map((s) => toScheduledNotebookView(s)) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      name?: string;
      cron?: string;
      notebookId?: string;
      recipients?: string[];
      enabled?: boolean;
    }>(request);
    const name = (body.name ?? "").trim();
    if (!name || name.length > 120)
      throw new ApiError(400, "VALIDATION", "Give the schedule a name (max 120 characters).");
    if (!body.notebookId) throw new ApiError(400, "VALIDATION", "Pick the notebook to run.");
    let parsed;
    try {
      parsed = parseCron(body.cron ?? "");
    } catch (err) {
      if (err instanceof CronError) throw new ApiError(400, "VALIDATION", err.message);
      throw err;
    }
    if (!nextRunAt(parsed))
      throw new ApiError(400, "VALIDATION", "The schedule never fires — check the cron expression.");

    const notebook = await prisma.notebook.findUnique({ where: { id: body.notebookId } });
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");
    await requireRowRole(ctx, notebook, "EDITOR");

    const recipients = (Array.isArray(body.recipients) ? body.recipients : [])
      .map((r) => r.trim())
      .filter((r) => r !== "")
      .slice(0, 20);
    for (const r of recipients) {
      if (!EMAIL_RE.test(r)) throw new ApiError(400, "VALIDATION", `“${r}” is not a valid email address.`);
    }

    const schedule = await prisma.scheduledNotebook.create({
      data: {
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        projectId: notebook.projectId,
        notebookId: notebook.id,
        name,
        cron: (body.cron ?? "").trim(),
        recipients: stringifyJson(recipients),
        enabled: body.enabled !== false,
      },
    });
    await logActivity(
      ctx,
      "SCHEDULE_CREATED",
      `Notebook schedule “${schedule.name}” created for “${notebook.title}”`,
      notebook.projectId,
      { scheduleId: schedule.id, cron: schedule.cron },
    );
    const full = await prisma.scheduledNotebook.findUnique({
      where: { id: schedule.id },
      include: { notebook: { select: { title: true } }, project: { select: { name: true } } },
    });
    return ok({ schedule: toScheduledNotebookView(full!) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
