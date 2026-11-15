import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import {
  executeChartCell,
  executeMapCell,
  executePivotCell,
  executeTableDisplayCell,
} from "@/lib/engine/notebook-cell-runners";
import { buildDag } from "@/lib/engine/notebook-dag";
import { executeNotebookCell } from "@/lib/engine/notebook-dsl";
import { collectExtras, reactiveRerunPlan } from "@/lib/engine/notebook-handoff";
import { assertSafePythonCode } from "@/lib/engine/python/code-gate";
import { runServerPython } from "@/lib/engine/python/python-kernel";
import { executeSqlQuery } from "@/lib/engine/sql-executor";
import { serverEnv } from "@/lib/env";
import { parseJsonArray, stringifyJson } from "@/lib/json";
import { datasetColumns } from "@/lib/serialize";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";
import { enforceUserRateLimit, RATE_LIMITS } from "@/lib/server/rate-limit";
import type {
  NotebookCell,
  NotebookCellOutput,
  ChartCellConfig,
  PivotCellConfig,
  TableDisplayConfig,
  SqlCellConfig,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    // Running a cell is not a read: it executes server compute, rewrites the
    // notebook document and records a version. VIEWER is read-only, so the
    // minimum role is EDITOR.
    enforceUserRateLimit(ctx.user.id, "notebook_run", RATE_LIMITS.notebook_run);
    const notebook = await prisma.notebook.findUnique({
      where: { id: params.id },
      include: { dataset: { select: { id: true, name: true } } },
    });
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");
    await requireRowRole(ctx, notebook, "EDITOR");

    const body = await readJsonBody<{
      cellId?: string;
      code?: string;
      cellKind?: string;
      cellConfig?: Record<string, unknown>;
      kernel?: string;
      /** True when the caller wants the reactive re-run plan for a widget change. */
      reactive?: boolean;
      /** "dag" returns the dependency-ordered execution plan instead of running a cell. */
      mode?: "dag";
    }>(request);

    // DAG mode (E16): the engine's topological order is the execution plan the
    // client follows, so `executeDag()`'s cycle detection actually gates runs.
    // No cell is executed here — the caller runs them in the returned order.
    if (body.mode === "dag") {
      const cells = parseJsonArray<NotebookCell>(notebook.cells, []);
      const dag = buildDag(cells);
      const runnable = new Set(["code", "sql", "chart", "table-display", "pivot", "map"]);
      return ok({
        dag: {
          order: dag.sortedIds,
          hasCycle: dag.hasCycle,
          cyclePath: dag.cyclePath,
          runnableIds: dag.sortedIds.filter((id) => {
            const cell = cells.find((c) => c.id === id);
            return cell ? runnable.has(cell.kind) : false;
          }),
        },
      });
    }

    const code = body.code ?? "";
    const cellKind = body.cellKind ?? "code";
    const cellConfig = body.cellConfig ?? {};
    /** "auto" (default) | "pyodide-server" — the kernel the client wants for code cells. */
    const kernelWanted = body.kernel === "pyodide-server" ? "pyodide-server" : "auto";
    // A widget cell carries no code of its own, so the "empty cell" guard must
    // not reject it: the client asks for the reactive plan by running the
    // widget cell with `reactive: true`, and the guard used to make that
    // branch unreachable (400) before the plan could ever be returned.
    const isPlanOnlyRequest = body.reactive === true && typeof body.cellId === "string";
    if (!code.trim() && !isPlanOnlyRequest && !["chart", "table-display", "pivot", "map"].includes(cellKind)) {
      throw new ApiError(400, "VALIDATION", "Nothing to run — the cell is empty.");
    }

    const datasetId = notebook.datasetId ?? notebook.dataset?.id;
    if (!datasetId) {
      // Keep the response shape identical to the success path: a consumer that
      // reads `rerunCellIds` must not have to special-case this branch.
      return ok({
        output: {
          type: "error",
          message: "No dataset is attached to this notebook. Edit the notebook in a project that has datasets.",
        } as NotebookCellOutput,
        persisted: false,
        dataset: null,
        rerunCellIds: [] as string[],
      });
    }
    const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
    await requireRowRole(ctx, dataset, "EDITOR");
    if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset not found.");

    const cols = datasetColumns(dataset);
    const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    // RLS: notebook cells must compute over the same rows the user can see
    // everywhere else, so a restricted user's notebook cannot be used as a
    // side channel to aggregate hidden rows.
    const rls = await applyRowSecurity(ctx, dataset, { rows: loaded.rows, columns: cols });
    const dsCtx = {
      datasetName: dataset.name,
      columns: cols,
      rows: rls.rows,
      totalRows: loaded.totalRows,
      rowLimit: 25,
    };

    let output: NotebookCellOutput;

    if (cellKind === "code" && kernelWanted === "pyodide-server") {
      // Real server-side Python (Pyodide wasm worker). Explicit user choice —
      // no silent fallback to the DSL: if the engine is disabled/unavailable
      // runServerPython raises PYTHON_KERNEL_UNAVAILABLE and the UI shows it.
      // User-typed code passes the same gate as AI-generated code so the
      // execution boundary is one rule, not two.
      const verdict = assertSafePythonCode(code);
      if (!verdict.ok) {
        throw new ApiError(400, "PYTHON_BLOCKED", verdict.reason ?? "This code was blocked by the Python safety gate.");
      }
      // SQL→Python handoff (ROADMAP 4.1): every ran, named tabular cell in the
      // notebook becomes a `df_<name>` pandas DataFrame in the worker, so a
      // SQL cell's result set is directly usable downstream.
      const docCells = parseJsonArray<NotebookCell>(notebook.cells, []);
      const { extras, truncatedNames } = collectExtras(docCells);
      output = await runServerPython(code, dsCtx, extras);
      if (truncatedNames.length > 0 && "title" in output) {
        output = {
          ...output,
          title: `${output.title || "Python result"} · handoff truncated: ${truncatedNames.join(", ")}`,
        };
      }
    } else if (cellKind === "sql") {
      // SQL cell — run the query against the dataset with Jinja support
      const sqlConfig = cellConfig as unknown as SqlCellConfig;
      const query = sqlConfig?.query || code;
      // Collect Jinja variables from the notebook's widget cells and Jinja vars in cellConfig
      const jinjaVars =
        ((cellConfig as unknown as Record<string, unknown>)?.jinjaVars as Record<string, unknown>) ?? {};
      // Get all dataset names for dbt ref resolution
      const allDatasets = await prisma.dataset.findMany({
        where: { workspaceId: notebook.workspaceId },
        select: { name: true },
      });
      const sqlResult = executeSqlQuery(query, {
        ...dsCtx,
        jinjaVars,
        knownDatasets: allDatasets.map((d) => d.name),
      });
      output = { ...sqlResult, kernel: "dsl" as const };
    } else if (cellKind === "chart") {
      // Chart cell — generate a chart from dataset columns
      const cfg = cellConfig as unknown as ChartCellConfig;
      output = executeChartCell(cfg, dsCtx);
    } else if (cellKind === "table-display") {
      // Table display cell with conditional formatting
      const cfg = cellConfig as unknown as TableDisplayConfig;
      output = executeTableDisplayCell(cfg, dsCtx);
    } else if (cellKind === "pivot") {
      // Pivot cell — no-code pivot table
      const cfg = cellConfig as unknown as PivotCellConfig;
      output = executePivotCell(cfg, dsCtx);
    } else if (cellKind === "map") {
      // Map cell — render lat/lng points
      const cfg = cellConfig as {
        latColumn: string;
        lngColumn: string;
        sizeColumn?: string;
        colorColumn?: string;
        labelColumn?: string;
      };
      output = executeMapCell(cfg, dsCtx);
    } else {
      // Standard code cell — DSL or browser Pyodide
      output = executeNotebookCell(code, dsCtx);
      output = { ...output, kernel: "dsl" as const };
    }

    // Persist the output back onto the cell when it already exists in the doc.
    let persisted = false;
    if (body.cellId) {
      const cells = parseJsonArray<NotebookCell>(notebook.cells, []);
      const idx = cells.findIndex((c) => c.id === body.cellId);
      if (idx >= 0) {
        cells[idx] = { ...(cells[idx] as NotebookCell), output, ranAt: new Date().toISOString() } as NotebookCell;
        await prisma.notebook.update({ where: { id: notebook.id }, data: { cells: stringifyJson(cells) } });
        persisted = true;
      }
    }

    // Auto-create a notebook version snapshot after each cell run.
    //
    // Runs are rate-limited but still unbounded over time, so auto-snapshots are
    // capped: a rolling window of the most recent AUTO snapshots is kept and
    // older ones pruned. Manual saves (label "manual") and publish snapshots
    // are never pruned — they are the versions a user chose to keep.
    const previousVersion = await prisma.notebookVersion.count({ where: { notebookId: notebook.id } });
    const snapshotVersion = previousVersion + 1;
    const AUTO_SNAPSHOT_CONFIG = stringifyJson({ label: "auto-run" });
    await prisma.notebookVersion.create({
      data: {
        workspaceId: notebook.workspaceId,
        notebookId: notebook.id,
        version: snapshotVersion,
        result: stringifyJson(output),
        config: AUTO_SNAPSHOT_CONFIG,
        createdById: ctx.user.id,
      },
    });
    await pruneAutoSnapshots(notebook.id, AUTO_SNAPSHOT_CAP);

    await logActivity(
      ctx,
      "NOTEBOOK_CELL_RUN",
      `Notebook cell ran in “${notebook.title}” against “${dataset.name}”`,
      notebook.projectId,
      { notebookId: notebook.id, datasetId: dataset.id },
    );

    // Reactive parameter cells (ROADMAP 4.3): when the ran cell is a widget
    // (or the caller asked), the response carries the ordered ids of every
    // downstream cell to re-run so parameter changes propagate automatically.
    const rerunCellIds =
      body.reactive || cellKind === "widget"
        ? body.cellId
          ? reactiveRerunPlan(parseJsonArray<NotebookCell>(notebook.cells, []), body.cellId)
          : []
        : [];

    return ok({ output, persisted, dataset: { id: dataset.id, name: dataset.name }, rerunCellIds });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// Cell executors live in lib/engine/notebook-cell-runners.ts — SHARED with the
// scheduled-notebook runner so interactive and scheduled runs compute the same
// numbers from one implementation.
// ---------------------------------------------------------------------------

/** Rolling window of auto-run snapshots kept per notebook. */
const AUTO_SNAPSHOT_CAP = 30;

/**
 * Delete the oldest auto-run snapshots beyond `cap`. Only rows whose config is
 * exactly the auto-run marker are eligible, so user-made versions are safe.
 */
async function pruneAutoSnapshots(notebookId: string, cap: number): Promise<void> {
  const stale = await prisma.notebookVersion.findMany({
    where: { notebookId, config: stringifyJson({ label: "auto-run" }) },
    orderBy: { version: "desc" },
    skip: cap,
    select: { id: true },
    take: 200,
  });
  if (stale.length === 0) return;
  await prisma.notebookVersion.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
}
