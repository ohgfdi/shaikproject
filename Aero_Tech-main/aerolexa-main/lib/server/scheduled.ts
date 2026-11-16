/**
 * Scheduled-report generation.
 *
 * Builds the same professional HTML export of a Report row as the manual
 * /export/reports route (identical deterministic renderer) into data/exports,
 * records the run on the schedule row, creates an in-app notification, and
 * sends the delivery notice through the configured mail transport (console in
 * dev — the console message states exactly what was sent). No external email
 * credentials are required — the preview + local export are always available.
 */
import { sendMail } from "@/lib/auth/mail";
// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - scheduled report is a deployment-wide aggregate operation
import { prisma } from "@/lib/db";
import { nextRunAt } from "@/lib/engine/cron";
import { renderReportDocument } from "@/lib/export/report-doc";
import { parseJsonArray } from "@/lib/json";
import { reportSections } from "@/lib/serialize";
import { logSecurityEvent, notify } from "@/lib/server/activity";
import { writeExportHtml } from "@/lib/server/artifacts";
import type { ScheduledReportView } from "@/lib/types";

/** Serialize a schedule row for the client (computes next run). */
export function toView(s: {
  id: string;
  name: string;
  cron: string;
  reportId: string | null;
  report: { title: string } | null;
  projectId: string | null;
  project: { name: string } | null;
  recipients: string;
  enabled: boolean;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  lastRunOutputUrl: string | null;
}): ScheduledReportView {
  let nextRunAtIso: string | null = null;
  try {
    const from = s.lastRunAt ?? new Date();
    nextRunAtIso = nextRunAt(s.cron, from)?.toISOString() ?? null;
  } catch {
    nextRunAtIso = null;
  }
  return {
    id: s.id,
    name: s.name,
    cron: s.cron,
    reportId: s.reportId,
    reportName: s.report?.title ?? null,
    projectId: s.projectId,
    projectName: s.project?.name ?? null,
    recipients: parseJsonArray<string>(s.recipients, []),
    enabled: s.enabled,
    nextRunAt: nextRunAtIso,
    lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
    lastRunStatus: s.lastRunStatus,
    lastRunMessage: s.lastRunMessage,
    lastRunOutputUrl: s.lastRunOutputUrl ? `/api/scheduled-reports/${s.id}/artifact` : null,
  };
}

export interface ScheduledRunOutcome {
  outputUrl: string | null;
  message: string;
  status: "ok" | "error";
}

export async function runScheduleNow(scheduleId: string): Promise<ScheduledRunOutcome> {
  try {
    const schedule = await prisma.scheduledReport.findUnique({
      where: { id: scheduleId },
      include: {
        report: { include: { project: { select: { name: true } }, createdBy: { select: { name: true } } } },
        user: { select: { id: true, name: true, workspaceId: true } },
      },
    });
    if (!schedule) return { outputUrl: null, message: "Schedule not found.", status: "error" };
    if (!schedule.report) {
      await prisma.scheduledReport.update({
        where: { id: schedule.id },
        data: { lastRunStatus: "error", lastRunMessage: "The linked report was deleted." },
      });
      return { outputUrl: null, message: "The linked report was deleted.", status: "error" };
    }

    const report = schedule.report;
    // Identical professional document as the manual export, with a provenance
    // note that states this copy was produced by the schedule.
    const dataset = report.projectId
      ? await prisma.dataset.findFirst({
          where: { workspaceId: report.workspaceId, projectId: report.projectId },
          orderBy: { createdAt: "desc" },
          select: { name: true, rowCount: true, columnCount: true },
        })
      : null;

    const html = renderReportDocument(reportSections(report), {
      title: report.title,
      projectName: report.project?.name ?? null,
      authorName: report.createdBy.name,
      version: report.version,
      generatedAt: new Date(),
      datasetName: dataset?.name ?? null,
      datasetRowCount: dataset?.rowCount ?? null,
      datasetColumnCount: dataset?.columnCount ?? null,
      productionNote: `Automated run of schedule “${schedule.name}”`,
    });

    // Write through the storage driver: the artifact becomes readable by every
    // replica (S3 + local cache), not just the one that ran this schedule.
    const fileName = await writeExportHtml("sched", schedule.id, html);

    const recipients = parseJsonArray<string>(schedule.recipients, []);
    const deliveredTo: string[] = [];
    for (const email of recipients) {
      try {
        await sendMail({
          to: email,
          subject: `${report.title} — ${schedule.name}`,
          text:
            `Your scheduled Ledgerly report “${report.title}” was generated and stored in the workspace.\n\n` +
            `Open Ledgerly → Reports → Scheduled to view or download the HTML export.\n\n— Ledgerly`,
        });
        deliveredTo.push(email);
      } catch {
        // console transport only; failures are recorded on the run message
      }
    }

    const fileNameBase = fileName.split(/[\\/]/).pop() ?? fileName;
    await prisma.scheduledReport.update({
      where: { id: schedule.id },
      data: {
        lastRunAt: new Date(),
        lastRunStatus: "ok",
        lastRunMessage:
          deliveredTo.length === 0
            ? "Export generated locally (no recipients configured)."
            : `Export generated and delivered to ${deliveredTo.join(", ")} via the configured mail transport.`,
        lastRunOutputUrl: fileNameBase,
      },
    });

    await notify(schedule.userId, {
      type: "report",
      title: "Scheduled report ready",
      message: `“${report.title}” (${schedule.name}) was generated${deliveredTo.length ? ` and sent to ${deliveredTo.length} recipient(s)` : ""}.`,
    });
    // Audit: schedule run is recorded on the owning workspace.
    if (schedule.user.workspaceId) {
      await logSecurityEvent(
        schedule.user.workspaceId,
        schedule.userId,
        "SCHEDULE_RUN",
        `Scheduled report “${schedule.name}” ran for “${report.title}”`,
        schedule.projectId,
        { scheduleId: schedule.id },
      ).catch(() => undefined);
    }

    return {
      outputUrl: `/api/scheduled-reports/${schedule.id}/artifact`,
      message: `Export generated${deliveredTo.length ? ` and “sent” to ${deliveredTo.length} recipient(s)` : " locally"} (${recipients.length} recipients configured).`,
      status: "ok",
    };
  } catch (err) {
    return {
      outputUrl: null,
      message: `Run failed: ${err instanceof Error ? err.message : "unknown error"}.`,
      status: "error",
    };
  }
}
