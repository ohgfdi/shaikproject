/**
 * Scheduled-notebook execution.
 *
 * Runs all cells in a notebook and exports the results as HTML.
 * Records the run on the schedule row, creates an in-app notification.
 */
import { sendMail } from "@/lib/auth/mail";
// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - scheduled notebook is a deployment-wide aggregate operation
import { prisma } from "@/lib/db";
import { nextRunAt } from "@/lib/engine/cron";
import { loadParsedDataset } from "@/lib/engine/dataset";
import {
  executeChartCell,
  executeMapCell,
  executePivotCell,
  executeTableDisplayCell,
} from "@/lib/engine/notebook-cell-runners";
import { executeNotebookCell } from "@/lib/engine/notebook-dsl";
import { isConditionalTableOutput, isTableOutput } from "@/lib/engine/notebook-output";
import { executeSqlQuery } from "@/lib/engine/sql-executor";
import { serverEnv } from "@/lib/env";
import { parseJsonArray } from "@/lib/json";
import { datasetColumns } from "@/lib/serialize";
import { logSecurityEvent, notify } from "@/lib/server/activity";
import { writeExportHtml } from "@/lib/server/artifacts";
import { applyRowSecurity, type AccessPrincipal } from "@/lib/server/dataset-access";
import type { NotebookCellOutput, ScheduledNotebookView } from "@/lib/types";

/** Minimal HTML escaper for user content in the export (no deps). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Serialize a schedule row for the client (computes next run). */
export function toScheduledNotebookView(s: {
  id: string;
  name: string;
  cron: string;
  notebookId: string;
  notebook: { title: string } | null;
  projectId: string | null;
  project: { name: string } | null;
  recipients: string;
  enabled: boolean;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  lastRunOutputUrl: string | null;
}): ScheduledNotebookView {
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
    notebookId: s.notebookId,
    notebookName: s.notebook?.title ?? null,
    projectId: s.projectId,
    projectName: s.project?.name ?? null,
    recipients: parseJsonArray<string>(s.recipients, []),
    enabled: s.enabled,
    nextRunAt: nextRunAtIso,
    lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
    lastRunStatus: s.lastRunStatus,
    lastRunMessage: s.lastRunMessage,
    lastRunOutputUrl: s.lastRunOutputUrl ? `/api/scheduled-notebooks/${s.id}/artifact` : null,
  };
}

export interface ScheduledNotebookRunOutcome {
  outputUrl: string | null;
  message: string;
  status: "ok" | "error";
}

export async function runScheduledNotebookNow(scheduleId: string): Promise<ScheduledNotebookRunOutcome> {
  try {
    const schedule = await prisma.scheduledNotebook.findUnique({
      where: { id: scheduleId },
      include: {
        notebook: { include: { project: { select: { name: true } }, createdBy: { select: { name: true } } } },
        user: { select: { id: true, name: true, workspaceId: true } },
      },
    });
    if (!schedule) return { outputUrl: null, message: "Schedule not found.", status: "error" };
    if (!schedule.notebook) {
      await prisma.scheduledNotebook.update({
        where: { id: schedule.id },
        data: { lastRunStatus: "error", lastRunMessage: "The linked notebook was deleted." },
      });
      return { outputUrl: null, message: "The linked notebook was deleted.", status: "error" };
    }

    const notebook = schedule.notebook;
    const cells = parseJsonArray<{
      id?: string;
      kind: string;
      content?: string;
      chartConfig?: Record<string, unknown>;
      tableDisplayConfig?: Record<string, unknown>;
      pivotConfig?: Record<string, unknown>;
      mapConfig?: Record<string, unknown>;
      sqlConfig?: { query?: string } | null;
    }>(notebook.cells, []);

    // Load the notebook's dataset ONCE, RLS-filtered as the schedule's OWNER
    // (the run executes with the creator's data visibility, not an implicit
    // superuser), then execute every runnable cell against it.
    const datasetId = notebook.datasetId;
    if (!datasetId) {
      await prisma.scheduledNotebook.update({
        where: { id: schedule.id },
        data: { lastRunStatus: "error", lastRunMessage: "The notebook has no dataset attached." },
      });
      return { outputUrl: null, message: "The notebook has no dataset attached.", status: "error" };
    }
    const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
    if (!dataset) {
      await prisma.scheduledNotebook.update({
        where: { id: schedule.id },
        data: { lastRunStatus: "error", lastRunMessage: "The notebook's dataset was deleted." },
      });
      return { outputUrl: null, message: "The notebook's dataset was deleted.", status: "error" };
    }
    const principal: AccessPrincipal = { userId: schedule.userId, workspaceId: schedule.user.workspaceId ?? "" };
    const cols = datasetColumns(dataset);
    const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    const rls = await applyRowSecurity(principal, dataset, { rows: loaded.rows, columns: cols });
    const dsCtx = {
      datasetName: dataset.name,
      columns: cols,
      rows: rls.rows,
      totalRows: loaded.totalRows,
      rowLimit: 25,
    };

    const runnableKinds = ["code", "sql", "chart", "table-display", "pivot", "map"];
    const executedAt = new Date().toISOString();
    const cellErrors: string[] = [];
    let executedCount = 0;

    // Build the HTML export with REAL outputs
    const htmlHead = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(notebook.title)} — ${escapeHtml(schedule.name)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; }
    .cell { margin-bottom: 2rem; padding: 1rem; border: 1px solid #e5e7eb; border-radius: 0.5rem; }
    .cell-header { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; font-size: 0.875rem; }
    .cell-kind { padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-weight: 500; }
    .kind-code { background: #dbeafe; color: #1e40af; }
    .kind-sql { background: #fef3c7; color: #92400e; }
    .kind-chart { background: #d1fae5; color: #065f46; }
    .kind-table { background: #e0e7ff; color: #3730a3; }
    .kind-pivot { background: #fce7f3; color: #9d174d; }
    .kind-map { background: #f3f4f6; color: #374151; }
    .kind-markdown { background: #fef3c7; color: #92400e; }
    pre { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 0.5rem; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #e5e7eb; padding: 0.5rem; text-align: left; }
    th { background: #f9fafb; }
    .cell-error { color: #b91c1c; font-weight: 500; }
    .provenance { margin-top: 2rem; padding: 1rem; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 0.5rem; font-size: 0.875rem; color: #0369a1; }
  </style>
</head>
<body>
  <h1>${escapeHtml(notebook.title)}</h1>
  <p><strong>Schedule:</strong> ${escapeHtml(schedule.name)} (${escapeHtml(schedule.cron)})</p>
  <p><strong>Project:</strong> ${escapeHtml(notebook.project?.name ?? "—")}</p>
  <p><strong>Author:</strong> ${escapeHtml(notebook.createdBy?.name ?? "—")}</p>
  <p><strong>Generated:</strong> ${escapeHtml(executedAt)}</p>
  <hr />`;

    const renderOutput = (kind: string, output: NotebookCellOutput): string => {
      if (output.type === "error") {
        return `<p class="cell-error">Error: ${escapeHtml(output.message ?? "Unknown error.")}</p>`;
      }
      if (output.type === "chart" && output.chart) {
        const c = output.chart;
        const rowsHtml = (c.categories ?? [])
          .map((cat, i) => {
            const vals = (c.series ?? []).map((s) => String(s.data?.[i] ?? "")).join("</td><td>");
            return `<tr><td>${escapeHtml(String(cat))}</td><td>${vals}</td></tr>`;
          })
          .join("");
        const head = (c.series ?? []).map((s) => `<th>${escapeHtml(s.name)}</th>`).join("");
        return `<p><strong>${escapeHtml(c.title ?? "Chart")}</strong> — ${escapeHtml(c.subtitle ?? "")}</p>
          <table><thead><tr><th>${escapeHtml(c.xLabel ?? "")}</th>${head}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
      }
      if (isTableOutput(output) || isConditionalTableOutput(output)) {
        const head = output.columns.map((c) => `<th>${escapeHtml(String(c.label ?? c.key))}</th>`).join("");
        const body = output.rows
          .map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(String(v ?? ""))}</td>`).join("")}</tr>`)
          .join("");
        return `<p><strong>${escapeHtml(output.title ?? "Table")}</strong></p><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
      }
      if (output.type === "pivot-result") {
        const head = (output.columnHeaders ?? []).map((h) => `<th>${escapeHtml(String(h))}</th>`).join("");
        const body = (output.rowHeaders ?? [])
          .map((rh, i) => {
            const cells2 = (output.data?.[i] ?? [])
              .map((v) => `<td>${v === null ? "" : escapeHtml(String(v))}</td>`)
              .join("");
            return `<tr><td>${escapeHtml(String(rh))}</td>${cells2}</tr>`;
          })
          .join("");
        return `<p><strong>${escapeHtml(output.title ?? "Pivot")}</strong></p><table><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
      }
      if (output.type === "map-result") {
        return `<p><strong>${escapeHtml(output.title ?? "Map")}</strong> — ${(output.points ?? []).length} point(s) plotted (see the interactive notebook for the map view).</p>`;
      }
      // SQL/DSL result set.
      if (output.type === "sql-result") {
        const head = output.columns.map((c) => `<th>${escapeHtml(String(c.name ?? ""))}</th>`).join("");
        const body = output.rows
          .slice(0, 200)
          .map((r) => `<tr>${r.map((v) => `<td>${v === null ? "" : escapeHtml(String(v))}</td>`).join("")}</tr>`)
          .join("");
        return `<p><strong>${escapeHtml(output.title ?? "Result")}</strong></p><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
      }
      return `<pre>${escapeHtml(JSON.stringify(output, null, 2).slice(0, 4000))}</pre>`;
    };

    let html = htmlHead;
    for (const cell of cells) {
      const kindClass = `kind-${cell.kind}`;
      html += `<div class="cell"><div class="cell-header"><span class="cell-kind ${kindClass}">${escapeHtml(cell.kind)}</span></div>`;

      if (cell.kind === "markdown") {
        // Simple markdown rendering for basic elements
        const content = (cell.content ?? "")
          .replace(/^### (.*$)/gim, "<h3>$1</h3>")
          .replace(/^## (.*$)/gim, "<h2>$1</h2>")
          .replace(/^# (.*$)/gim, "<h1>$1</h1>")
          .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
          .replace(/\*(.*?)\*/g, "<em>$1</em>")
          .replace(/`(.*?)`/g, "<code>$1</code>")
          .replace(/\n/g, "<br>");
        html += `<div>${content}</div>`;
      } else if (runnableKinds.includes(cell.kind)) {
        executedCount++;
        try {
          let output: NotebookCellOutput;
          if (cell.kind === "sql") {
            const query = cell.sqlConfig?.query || cell.content || "";
            const allDatasets = await prisma.dataset.findMany({
              where: { workspaceId: notebook.workspaceId },
              select: { name: true },
            });
            output = executeSqlQuery(query, {
              ...dsCtx,
              jinjaVars: {},
              knownDatasets: allDatasets.map((d) => d.name),
            });
          } else if (cell.kind === "chart") {
            output = executeChartCell(cell.chartConfig as never, dsCtx);
          } else if (cell.kind === "table-display") {
            output = executeTableDisplayCell(cell.tableDisplayConfig as never, dsCtx);
          } else if (cell.kind === "pivot") {
            output = executePivotCell(cell.pivotConfig as never, dsCtx);
          } else if (cell.kind === "map") {
            output = executeMapCell(cell.mapConfig as never, dsCtx);
          } else {
            // code cell — the deterministic DSL (NOT arbitrary Python: scheduled
            // runs execute unattended, so the interactive Python-kernel path
            // with its explicit user opt-in stays interactive-only).
            output = executeNotebookCell(cell.content ?? "", dsCtx);
            output = { ...output, kernel: "dsl" as const };
          }
          if (output.type === "error") cellErrors.push(`${cell.kind}: ${output.message ?? "unknown"}`);
          html += renderOutput(cell.kind, output);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          cellErrors.push(`${cell.kind}: ${msg}`);
          html += `<p class="cell-error">Error: ${escapeHtml(msg)}</p>`;
        }
      } else {
        html += `<p><em>(non-runnable cell kind “${escapeHtml(cell.kind)}” skipped)</em></p>`;
      }
      html += `</div>`;
    }

    html += `<div class="provenance">
      <strong>Provenance:</strong> Generated by the scheduled run “${escapeHtml(schedule.name)}” (cron: ${escapeHtml(schedule.cron)}) at ${escapeHtml(executedAt)}.
      Executed ${executedCount} cell(s) against “${escapeHtml(dataset.name)}” (${rls.rows.length.toLocaleString()} of ${loaded.totalRows.toLocaleString()} rows after row-level security).
      Every number above was computed by the same cell executors the interactive notebook uses.${rls.note ? escapeHtml(rls.note) : ""}
    </div>
  </body>
</html>`;

    // Write through the storage driver
    const fileName = await writeExportHtml("sched-nb", schedule.id, html);

    const recipients = parseJsonArray<string>(schedule.recipients, []);
    const deliveredTo: string[] = [];
    for (const email of recipients) {
      try {
        await sendMail({
          to: email,
          subject: `${notebook.title} — ${schedule.name}`,
          text:
            `Your scheduled Ledgerly notebook “${notebook.title}” was generated and stored in the workspace.\n\n` +
            `Open Ledgerly → Notebooks → Scheduled to view or download the HTML export.\n\n— Ledgerly`,
        });
        deliveredTo.push(email);
      } catch {
        // console transport only; failures are recorded on the run message
      }
    }

    const fileNameBase = fileName.split(/[\\/]/).pop() ?? fileName;
    const statusMessage =
      cellErrors.length > 0
        ? `Executed ${executedCount} cell(s) with ${cellErrors.length} error(s): ${cellErrors.slice(0, 3).join("; ")}`
        : `Executed ${executedCount} cell(s) successfully against “${dataset.name}”.`;
    await prisma.scheduledNotebook.update({
      where: { id: schedule.id },
      data: {
        lastRunAt: new Date(),
        lastRunStatus: cellErrors.length > 0 ? (executedCount > 0 ? "ok" : "error") : "ok",
        lastRunMessage:
          statusMessage +
          (deliveredTo.length === 0
            ? " Export stored locally (no recipients configured)."
            : ` Export delivered to ${deliveredTo.join(", ")}.`),
        lastRunOutputUrl: fileNameBase,
      },
    });

    await notify(schedule.userId, {
      type: "report",
      title: "Scheduled notebook ready",
      message: `“${notebook.title}” (${schedule.name}) was generated${deliveredTo.length ? ` and sent to ${deliveredTo.length} recipient(s)` : ""}.`,
    });

    // Audit: schedule run is recorded on the owning workspace.
    if (schedule.user.workspaceId) {
      await logSecurityEvent(
        schedule.user.workspaceId,
        schedule.userId,
        "SCHEDULE_RUN",
        `Scheduled notebook “${schedule.name}” ran for “${notebook.title}”`,
        schedule.projectId,
        { scheduleId: schedule.id },
      ).catch(() => undefined);
    }

    return {
      outputUrl: `/api/scheduled-notebooks/${schedule.id}/artifact`,
      message: `Executed ${executedCount} cell(s)${cellErrors.length ? ` with ${cellErrors.length} error(s)` : ""} and stored the export${deliveredTo.length ? ` (sent to ${deliveredTo.length} recipient(s))` : " locally"}.`,
      status: cellErrors.length > 0 && executedCount === 0 ? "error" : "ok",
    };
  } catch (err) {
    return {
      outputUrl: null,
      message: `Run failed: ${err instanceof Error ? err.message : "unknown error"}.`,
      status: "error",
    };
  }
}
