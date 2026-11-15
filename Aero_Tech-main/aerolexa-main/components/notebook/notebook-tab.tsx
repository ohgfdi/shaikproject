"use client";

import {
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  GitBranch,
  LayoutGrid,
  Lightbulb,
  ListPlus,
  Loader2,
  MapPin,
  NotebookPen,
  Play,
  Plus,
  Share2,
  Sparkles,
  Table2,
  Trash2,
  Wand2,
} from "lucide-react";
import { Download } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

import { CopilotTextarea } from "@/components/notebook/copilot-textarea";
import { CursorOverlay } from "@/components/notebook/CursorOverlay";
import { NotebookWidgetControl, WIDGET_KIND_LABELS } from "@/components/notebook/notebook-input-widgets";
import { SchemaBrowser } from "@/components/notebook/schema-browser";
import { useNotebookCollab } from "@/components/notebook/use-collab";
import { VersionHistory } from "@/components/notebook/version-history";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { DemoBadge, ErrorMessage, LoadingSkeleton } from "@/components/ui/feedback";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Badge, Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { reactiveRerunPlan } from "@/lib/engine/notebook-handoff";
import { createPyodideKernel, type PyodideDataset, type PyodideKernel } from "@/lib/engine/notebook-pyodide";
import { downstreamOf, substituteWidgetVariables, widgetValuesFromCells } from "@/lib/engine/notebook-widgets";
import { ReactiveRunQueue, isRunnableCell } from "@/lib/engine/reactive-run";
import type {
  ColumnDef,
  NotebookCell,
  NotebookCellKind,
  NotebookCellOutput,
  NotebookWidget,
  NotebookWidgetKind,
  NotebookWidgetValue,
  NotebookVersion,
  ChartCellConfig,
  TableDisplayConfig,
  PivotCellConfig,
  MapCellConfig,
  SqlValue,
  ScheduledNotebookView,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export interface NotebookOption {
  id: string;
  title: string;
  datasetId: string | null;
}
export interface DatasetOption {
  id: string;
  name: string;
  isDemo: boolean;
}

interface NotebookDoc {
  id: string;
  title: string;
  dataset: { id: string; name: string } | null;
  cells: NotebookCell[];
  accessMode: "workspace" | "public";
  shareUrl: string | null;
  publishedAt: string | null;
  versions?: NotebookVersion[];
}

interface PublishResult {
  version: number;
  accessMode: "workspace" | "public";
  viewOnly: boolean;
  shareUrl: string | null;
  workspaceUrl: string;
}

const KERNEL_NOTE =
  "DSL fallback kernel (statistically validated commands, Calculated label): Pyodide could not initialize. Use Python after restoring network access and retrying the notebook.";

const TEMPLATE_COMMANDS: { id: string; title: string; command: string; description: string }[] = [
  {
    id: "kpi-single",
    title: "KPI Summary",
    command: "%kpi column_name",
    description: "Sum, average, min/max for a column",
  },
  {
    id: "correlation",
    title: "Correlation",
    command: "%corr col1 col2",
    description: "Pearson correlation of two columns",
  },
  {
    id: "trend-over-time",
    title: "Trend Over Time",
    command: "%trend date_column",
    description: "Chart a metric over a date column",
  },
  {
    id: "histogram",
    title: "Histogram",
    command: "%histogram column_name",
    description: "Distribution of a numeric column",
  },
  {
    id: "top-values",
    title: "Top N Values",
    command: "%top 10 column_name",
    description: "Top values of a numeric column",
  },
  {
    id: "unique-count",
    title: "Unique Count",
    command: "%unique column_name",
    description: "Distinct values in a column",
  },
];

interface RowsResponse {
  columns: ColumnDef[];
  rows: SqlValue[][];
  totalRows: number;
}

const WIDGET_DEFAULTS: Record<NotebookWidgetKind, () => Omit<NotebookWidget, "variable">> = {
  text: () => ({ kind: "text", label: "Text input", value: "" }),
  number: () => ({ kind: "number", label: "Number", min: 0, max: 100, step: 1, value: 50 }),
  dropdown: () => ({
    kind: "dropdown",
    label: "Dropdown",
    options: [
      { value: "East", label: "East" },
      { value: "West", label: "West" },
      { value: "North", label: "North" },
      { value: "South", label: "South" },
    ],
    value: "East",
  }),
  "date-range": () => ({ kind: "date-range", label: "Date range", value: { min: "", max: "" } }),
};

export function NotebookTab({
  projectId,
  datasets,
  serverPythonEnabled = false,
  collaborationEnabled = false,
}: {
  projectId: string;
  datasets: DatasetOption[];
  /** WS1: real server-side Python kernel available (PYODIDE_SERVER_ENABLED). */
  serverPythonEnabled?: boolean;
  /** WS4: real-time collaboration available (COLLABORATION_ENABLED). */
  collaborationEnabled?: boolean;
}) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [notebooks, setNotebooks] = useState<NotebookOption[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doc, setDoc] = useState<NotebookDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * Cells currently executing. A reactive cascade runs several cells in
   * sequence, so a single `runningId` was wrong twice over: the first of N
   * concurrent runs cleared it while the rest were still going, and two cells
   * could never show progress at once.
   */
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(() => new Set());
  const [widgetMenuOpen, setWidgetMenuOpen] = useState(false);
  const [kernelStatus, setKernelStatus] = useState<"idle" | "loading" | "ready" | "fallback">("idle");
  const [kernelError, setKernelError] = useState<string | null>(null);
  const [kernelProgress, setKernelProgress] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [sidePanel, setSidePanel] = useState<"schema" | "versions" | "schedule" | null>(null);
  // WS1: which engine runs code cells. "server" = real CPython (Pyodide wasm
  // worker on the server); "browser" = the pre-existing in-tab Pyodide/DSL path.
  const [kernelChoice, setKernelChoice] = useState<"server" | "browser">(
    serverPythonEnabled &&
      (typeof localStorage === "undefined" || localStorage.getItem("Ledgerly-kernel") !== "browser")
      ? "server"
      : "browser",
  );
  const [serverKernelError, setServerKernelError] = useState<string | null>(null);
  // WS4: real-time collaboration (Yjs CRDT over SSE + POST).
  const collab = useNotebookCollab(doc?.id ?? null, collaborationEnabled);

  // Scheduled notebooks
  const [schedules, setSchedules] = useState<ScheduledNotebookView[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({
    name: "",
    cron: "0 9 * * *",
    recipients: "",
    enabled: true,
  });
  const [scheduleSubmitting, setScheduleSubmitting] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const loadSchedules = useCallback(async () => {
    setScheduleLoading(true);
    try {
      const res = await api<{ schedules: ScheduledNotebookView[] }>("/api/scheduled-notebooks");
      setSchedules(res.schedules);
    } catch (err) {
      setScheduleError(errorMessage(err));
    } finally {
      setScheduleLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  useEffect(() => {
    if (!widgetMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWidgetMenuOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const menu = document.getElementById("widget-add-menu");
      if (menu && !menu.contains(e.target as Node) && !(e.target as HTMLElement).closest("[data-widget-trigger]")) {
        setWidgetMenuOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [widgetMenuOpen]);

  const [templateOpen, setTemplateOpen] = useState(false);
  const [dagMode, setDagMode] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [focusedCellId, setFocusedCellId] = useState<string | null>(null);
  const [pyodideKernel, setPyodideKernel] = useState<PyodideKernel | null>(null);
  const runCellRef = useRef<(cell: NotebookCell) => void>(() => {});

  // Global keyboard handler for notebook ergonomics
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        // Still allow Shift+Enter to run from markdown cells
        if (
          e.key === "Enter" &&
          e.shiftKey &&
          target.tagName === "TEXTAREA" &&
          target.closest('[data-cell-kind="markdown"]')
        ) {
          const cellId = target.closest("[data-cell-id]")?.getAttribute("data-cell-id");
          if (cellId && doc) {
            const cell = doc.cells.find((c) => c.id === cellId);
            if (cell && runCellRef.current) {
              e.preventDefault();
              void runCellRef.current(cell);
            }
          }
        }
        return;
      }

      if (!doc) return;

      // Command palette: / or Ctrl+K
      if ((e.key === "/" && !(e.metaKey || e.ctrlKey)) || ((e.metaKey || e.ctrlKey) && e.key === "k")) {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      // Cell navigation with Arrow keys (when not in command palette)
      if (!commandPaletteOpen) {
        const focusedCellIndex = doc.cells.findIndex((c) => c.id === focusedCellId);

        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (focusedCellIndex > 0) {
            const prevCell = doc.cells[focusedCellIndex - 1];
            if (prevCell) setFocusedCellId(prevCell.id);
          } else if (focusedCellIndex === -1 && doc.cells.length > 0) {
            const firstCell = doc.cells[0];
            if (firstCell) setFocusedCellId(firstCell.id);
          }
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          if (focusedCellIndex >= 0 && focusedCellIndex < doc.cells.length - 1) {
            const nextCell = doc.cells[focusedCellIndex + 1];
            if (nextCell) setFocusedCellId(nextCell.id);
          } else if (focusedCellIndex === -1 && doc.cells.length > 0) {
            const firstCell = doc.cells[0];
            if (firstCell) setFocusedCellId(firstCell.id);
          }
        }

        // Shift+Enter to run focused cell
        if (e.key === "Enter" && e.shiftKey && focusedCellIndex >= 0) {
          const cell = doc.cells[focusedCellIndex];
          if (
            cell &&
            (cell.kind === "code" ||
              cell.kind === "sql" ||
              cell.kind === "chart" ||
              cell.kind === "table-display" ||
              cell.kind === "pivot" ||
              cell.kind === "map") &&
            runCellRef.current
          ) {
            e.preventDefault();
            void runCellRef.current(cell);
          }
        }

        // Enter to enter edit mode on focused cell
        if (e.key === "Enter" && !e.shiftKey && focusedCellIndex >= 0) {
          const cell = doc.cells[focusedCellIndex];
          if (cell && (cell.kind === "markdown" || cell.kind === "code")) {
            e.preventDefault();
            const textarea = document.querySelector(`[data-cell-id="${cell.id}"] textarea`);
            (textarea as HTMLTextAreaElement)?.focus();
          }
        }

        // Escape to blur
        if (e.key === "Escape") {
          setFocusedCellId(null);
          (document.activeElement as HTMLElement)?.blur();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [doc, commandPaletteOpen, focusedCellId]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kernelPromiseRef = useRef<Promise<{ datasetId: string; kernel: PyodideKernel }> | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  /** Serialises reactive cascades with last-write-wins; see lib/engine/reactive-run.ts. */
  const reactiveQueueRef = useRef<ReactiveRunQueue | null>(null);
  if (!reactiveQueueRef.current) reactiveQueueRef.current = new ReactiveRunQueue();
  /** Re-entrancy guard for "Run all", independent of per-cell running state. */
  const runAllInFlightRef = useRef(false);
  const [runAllBusy, setRunAllBusy] = useState(false);
  const datasetColumnsRef = useRef<{ name: string; type: string }[]>([]);
  // WS4: when each cell was last edited locally — remote merges never clobber
  // a cell the user typed into within the last 2 seconds.
  const lastLocalEditRef = useRef<Map<string, number>>(new Map());

  // Reconcile remote Yjs state into the local doc (content only, guarded).
  useEffect(() => {
    if (!collaborationEnabled || !doc || collab.remoteCells.length === 0) return;
    const now = Date.now();
    let changed = false;
    const cells = doc.cells.map((cell) => {
      const remote = collab.remoteCells.find((rc) => rc.id === cell.id);
      if (!remote || remote.content === cell.content) return cell;
      const lastLocal = lastLocalEditRef.current.get(cell.id) ?? 0;
      if (now - lastLocal < 2000) return cell; // user is actively editing
      changed = true;
      return { ...cell, content: remote.content } as NotebookCell;
    });
    if (changed) setDoc((d) => (d ? { ...d, cells } : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab.remoteCells]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ notebooks: NotebookOption[] }>(`/api/projects/${projectId}/notebooks`);
      setNotebooks(data.notebooks);
      if (!selectedId && data.notebooks.length > 0) {
        void openNotebook(data.notebooks[0]!.id);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNotebook = async (id: string) => {
    setSelectedId(id);
    setPublishOpen(false);
    setPublishResult(null);
    setPublishError(null);
    try {
      const data = await api<{
        notebook: NotebookDoc & { cells: NotebookCell[] };
      }>(`/api/notebooks/${id}`);
      setDoc(data.notebook);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    const datasetId = doc?.dataset?.id;
    if (!datasetId) {
      kernelPromiseRef.current = null;
      setKernelError(null);
      setKernelStatus("fallback");
      setKernelProgress(null);
      setPyodideKernel(null);
      return;
    }
    setKernelError(null);
    setKernelStatus("loading");
    setKernelProgress("initializing kernel");
    const promise = (async () => {
      const allRows = await Promise.all(
        datasets.map(async (dataset) => ({
          dataset,
          data: await api<RowsResponse>(`/api/datasets/${dataset.id}/rows`),
        })),
      );
      const active = allRows.find((item) => item.dataset.id === datasetId)?.data;
      if (!active)
        throw new Error(
          "The active dataset could not be loaded. What happened: the dataset context is missing or invalid. How to fix: ensure a valid dataset is selected and try again.",
        );
      datasetColumnsRef.current = active.columns.map((c) => ({ name: c.name, type: c.type }));
      const additional: PyodideDataset[] = allRows
        .filter((item) => item.dataset.id !== datasetId)
        .map((item) => ({ name: item.dataset.name, columns: item.data.columns, rows: item.data.rows }));
      const kernel = createPyodideKernel(
        {
          datasetName: doc?.dataset?.name ?? "dataset",
          columns: active.columns,
          rows: active.rows,
          totalRows: active.totalRows,
          rowLimit: active.rows.length,
        },
        undefined,
        additional,
      );
      await kernel.ready;
      setKernelStatus("ready");
      setKernelProgress(null);
      setPyodideKernel(kernel);
      return { datasetId, kernel };
    })().catch((err) => {
      setKernelError(err instanceof Error ? err.message : "The browser kernel could not initialize.");
      setKernelStatus("fallback");
      setKernelProgress(null);
      throw err;
    });
    kernelPromiseRef.current = promise;
    return () => {
      if (kernelPromiseRef.current === promise) kernelPromiseRef.current = null;
    };
  }, [doc?.dataset?.id, doc?.dataset?.name, datasets]);

  const scheduleSave = useCallback((cells: NotebookCell[], title?: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const d = docRef.current;
      if (!d) return;
      setSaving(true);
      api(`/api/notebooks/${d.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title, cells }),
      })
        .catch((err) => toast({ title: "Could not save notebook", message: errorMessage(err), type: "error" }))
        .finally(() => setSaving(false));
    }, 900);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateCells = (cells: NotebookCell[]) => {
    setDoc((d) => (d ? { ...d, cells } : d));
    scheduleSave(cells);
  };

  const updateCell = (cellId: string, patch: Partial<NotebookCell>) => {
    if (!doc) return;
    const cells = doc.cells.map((c) => (c.id === cellId ? ({ ...c, ...patch } as NotebookCell) : c));
    updateCells(cells);
  };

  const addCell = (kind: NotebookCellKind, afterId?: string) => {
    if (!doc) return;
    const defaults: Record<string, string> = {
      markdown: "### Notes",
      code: "%kpi ",
      sql: "SELECT * FROM dataset LIMIT 100",
      chart: "",
      "table-display": "",
      pivot: "",
      map: "",
      widget: "",
    };
    const cell: NotebookCell = {
      id: crypto.randomUUID(),
      kind,
      content: defaults[kind] ?? "",
      output: null,
      ranAt: null,
    };
    // Set default configs for new cell types
    if (kind === "chart") {
      cell.chartConfig = {
        chartType: "bar",
        yColumns: [datasetColumnsRef.current[0]?.name ?? ""],
        xColumn: datasetColumnsRef.current[1]?.name ?? datasetColumnsRef.current[0]?.name ?? "",
      };
    } else if (kind === "table-display") {
      cell.tableDisplayConfig = { limit: 50, enableFilter: true, showRowNumbers: true };
    } else if (kind === "pivot") {
      cell.pivotConfig = {
        rowColumns: [],
        columnColumns: [],
        values: [{ column: datasetColumnsRef.current[0]?.name ?? "", aggregation: "sum" }],
      };
    } else if (kind === "map") {
      const numCols = datasetColumnsRef.current.filter((c) => c.type === "number");
      cell.mapConfig = {
        latColumn: numCols[0]?.name ?? "",
        lngColumn: numCols[1]?.name ?? "",
      };
    } else if (kind === "sql") {
      cell.sqlConfig = { query: "SELECT * FROM dataset LIMIT 100" };
    }
    const cells = [...doc.cells];
    const idx = afterId ? cells.findIndex((c) => c.id === afterId) : -1;
    cells.splice(idx >= 0 ? idx + 1 : cells.length, 0, cell);
    updateCells(cells);
  };

  const insertTemplate = (command: string) => {
    const cell: NotebookCell = {
      id: crypto.randomUUID(),
      kind: "code",
      content: command,
      output: null,
      ranAt: null,
    };
    if (doc) updateCells([...doc.cells, cell]);
    setTemplateOpen(false);
  };

  const addWidgetCell = (widgetKind: NotebookWidgetKind) => {
    if (!doc) return;
    const variable = `widget_${widgetKind.replace("-", "")}_${crypto.randomUUID().slice(0, 6)}`;
    const widget: NotebookWidget = {
      ...WIDGET_DEFAULTS[widgetKind](),
      variable,
    };
    const cell: NotebookCell = {
      id: crypto.randomUUID(),
      kind: "widget",
      content: "",
      widget,
      output: null,
      ranAt: null,
    };
    updateCells([...doc.cells, cell]);
    setWidgetMenuOpen(false);
    toast({
      title: "Input widget added",
      message: `Code cells can reference it with {{${variable}}}.`,
      type: "success",
    });
  };

  const removeCell = (cellId: string) => {
    if (!doc) return;
    updateCells(doc.cells.filter((c) => c.id !== cellId));
  };

  const moveCell = (cellId: string, dir: -1 | 1) => {
    if (!doc) return;
    const cells = [...doc.cells];
    const idx = cells.findIndex((c) => c.id === cellId);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= cells.length) return;
    const [cell] = cells.splice(idx, 1);
    cells.splice(to, 0, cell as NotebookCell);
    updateCells(cells);
  };

  const updateWidgetValue = (cellId: string, value: NotebookWidgetValue) => {
    if (!doc) return;
    const cell = doc.cells.find((c) => c.id === cellId);
    if (!cell?.widget) return;
    const nextCells = doc.cells.map((c) => (c.id === cellId ? { ...c, widget: { ...c.widget!, value } } : c));
    updateCells(nextCells);
    void requestReactiveRun(cellId, nextCells);
  };

  /**
   * Ask the server which cells a parameter change invalidates, then run them
   * strictly in order (ROADMAP 4.3).
   *
   * The plan comes from the server so there is exactly one graph walk in the
   * system; the local `downstreamOf` is only a fallback for an offline client,
   * and it applies the same rules, so the two cannot disagree about coverage.
   *
   * Execution is queued, not fired: `run()` supersedes any burst still in
   * flight, so dragging a slider settles on the final value instead of
   * interleaving N cascades and committing stale outputs last.
   */
  const requestReactiveRun = async (cellId: string, cellsAtChange: NotebookCell[]) => {
    const notebookId = doc?.id;
    if (!notebookId) return;

    let plan: string[];
    try {
      const data = await api<{ rerunCellIds: string[] }>(`/api/notebooks/${notebookId}/rerun-plan`, {
        method: "POST",
        body: JSON.stringify({ cellId }),
      });
      plan = data.rerunCellIds;
    } catch {
      // Offline or throttled: still react locally rather than dropping the
      // change on the floor. `reactiveRerunPlan` is the same pure walk the
      // route uses, so the fallback plan is equivalent, not a second opinion.
      const variable = cellsAtChange.find((c) => c.id === cellId)?.widget?.variable;
      plan = variable
        ? downstreamOf(cellsAtChange, cellId, { changedVariable: variable }).map((c) => c.id)
        : reactiveRerunPlan(cellsAtChange, cellId);
    }
    if (plan.length === 0) return;
    const queue = reactiveQueueRef.current;
    if (!queue) return;

    await queue.run(plan, {
      // Read the cell list fresh per step so a cell deleted mid-cascade is
      // skipped rather than resurrected by a stale closure.
      getCells: () => docRef.current?.cells ?? [],
      // Every step substitutes from `docRef.current`, never from a snapshot
      // taken when the drag started — that is what keeps a superseded burst
      // from re-running against stale parameter values.
      runCell: (target) => runCellWith(target, docRef.current?.cells ?? []),
    });
  };

  /**
   * Core cell runner. `cellsOverride` supplies the authoritative cell list
   * (used by reactive re-runs so a burst of widget changes re-runs against
   * the NEW values, never a stale snapshot).
   *
   * Never throws: failures are committed to the cell as an error output so one
   * bad cell in a cascade does not abandon the rest.
   */
  const runCellWith = async (cell: NotebookCell, cellsOverride: NotebookCell[]): Promise<boolean> => {
    if (!isRunnableCell(cell)) return false;
    const source = cellsOverride;
    // Derived-state guard: add to a new Set so concurrent cells each get their
    // own update and React never sees a mutated shared reference.
    setRunningIds((prev) => {
      const next = new Set(prev);
      next.add(cell.id);
      return next;
    });
    try {
      // Substitute widget values ({{variable}}) before execution. SQL cells
      // get SQL literals ('East', NULL, x AND y) — not Python reprs.
      const values = widgetValuesFromCells(source);
      const content =
        cell.kind === "sql"
          ? substituteWidgetVariables(cell.sqlConfig?.query || cell.content, values, "sql")
          : substituteWidgetVariables(cell.content, values);
      let output: NotebookCellOutput;

      if (cell.kind === "sql") {
        // SQL cell — run via API (with widget substitution applied)
        output = await runSqlCell(doc!.id, cell, content);
      } else if (cell.kind === "chart") {
        output = await runTypedCell(source, cell, "chart", cell.chartConfig ?? {});
      } else if (cell.kind === "table-display") {
        output = await runTypedCell(source, cell, "table-display", cell.tableDisplayConfig ?? {});
      } else if (cell.kind === "pivot") {
        output = await runTypedCell(source, cell, "pivot", cell.pivotConfig ?? {});
      } else if (cell.kind === "map") {
        output = await runTypedCell(source, cell, "map", cell.mapConfig ?? {});
      } else if (content.trimStart().startsWith("%")) {
        output = await runDslCell(doc!.id, cell, content);
      } else if (kernelChoice === "server") {
        // WS1: real server-side Python (CPython via Pyodide wasm worker).
        // No silent fallback: an unavailable engine is an explicit error the
        // user can act on (switch kernels or ask an operator to enable it).
        const data = await api<{ output: NotebookCellOutput }>(`/api/notebooks/${doc!.id}/run`, {
          method: "POST",
          body: JSON.stringify({ cellId: cell.id, code: content, cellKind: "code", kernel: "pyodide-server" }),
        });
        setServerKernelError(null);
        output = data.output;
      } else {
        try {
          const session = await kernelPromiseRef.current;
          if (!session || session.datasetId !== doc!.dataset?.id)
            throw new Error(
              "Pyodide session unavailable. What happened: the Pyodide kernel session is missing or mismatched. How to fix: reload the notebook or reinitialize the Pyodide kernel.",
            );
          output = await session.kernel.run(content);
        } catch {
          setKernelStatus("fallback");
          output = await runDslCell(doc!.id, cell, content);
        }
      }
      // Commit the output ONLY if this cell still exists in the doc — a
      // delete-during-run must not resurrect the cell.
      const live = docRef.current;
      if (live && live.cells.some((c) => c.id === cell.id)) {
        updateCell(cell.id, { output, ranAt: new Date().toISOString() });
      }
      return true;
    } catch (err) {
      const message = errorMessage(err);
      if (kernelChoice === "server") setServerKernelError(message);
      const live = docRef.current;
      if (live && live.cells.some((c) => c.id === cell.id)) {
        updateCell(cell.id, {
          output: { type: "error", message } as NotebookCellOutput,
          ranAt: new Date().toISOString(),
        });
      }
      // Reported, not thrown: the cascade continues to the next cell so one
      // failure cannot strand everything downstream of it un-refreshed.
      return false;
    } finally {
      setRunningIds((prev) => {
        if (!prev.has(cell.id)) return prev;
        const next = new Set(prev);
        next.delete(cell.id);
        return next;
      });
    }
  };

  const runCell = async (cell: NotebookCell) => {
    runCellRef.current = runCell;
    if (!doc) return;
    await runCellWith(cell, doc.cells);
  };

  const runSqlCell = async (notebookId: string, cell: NotebookCell, query: string): Promise<NotebookCellOutput> => {
    const data = await api<{ output: NotebookCellOutput }>(`/api/notebooks/${notebookId}/run`, {
      method: "POST",
      body: JSON.stringify({ cellId: cell.id, code: query, cellKind: "sql", cellConfig: { query } }),
    });
    return data.output;
  };

  const runTypedCell = async (
    cells: NotebookCell[],
    cell: NotebookCell,
    cellKind: string,
    cellConfig: unknown,
  ): Promise<NotebookCellOutput> => {
    const notebookId = docRef.current?.id;
    if (!notebookId) throw new Error("Notebook is not open.");
    void cells;
    const data = await api<{ output: NotebookCellOutput }>(`/api/notebooks/${notebookId}/run`, {
      method: "POST",
      body: JSON.stringify({ cellId: cell.id, code: cell.content, cellKind, cellConfig }),
    });
    return data.output;
  };

  const runDslCell = async (notebookId: string, cell: NotebookCell, content: string): Promise<NotebookCellOutput> => {
    const data = await api<{ output: NotebookCellOutput }>(`/api/notebooks/${notebookId}/run`, {
      method: "POST",
      body: JSON.stringify({ cellId: cell.id, code: content }),
    });
    return data.output;
  };

  /**
   * Run every code cell top to bottom, sequentially, so each cell sees the
   * output of the one above it.
   *
   * The old guard was `!runningId`, which coupled this to whichever cell
   * happened to be running: if a reactive cascade was in flight, "Run all"
   * skipped every cell and silently did nothing. Re-entrancy is now tracked
   * independently by `runAllInFlightRef`.
   */
  const runAll = async () => {
    if (!doc || runAllInFlightRef.current) return;
    runAllInFlightRef.current = true;
    setRunAllBusy(true);
    try {
      const cells = docRef.current?.cells ?? [];
      if (dagMode) {
        // DAG mode asks the engine for the dependency order (and its cycle
        // verdict) instead of trusting array order. A cycle is reported, not
        // silently run in a misleading order.
        const plan = await api<{
          dag: { order: string[]; hasCycle: boolean; cyclePath: string[] | null; runnableIds: string[] };
        }>(`/api/notebooks/${doc.id}/run`, {
          method: "POST",
          body: JSON.stringify({ mode: "dag" }),
        });
        if (plan.dag.hasCycle) {
          toast({
            title: "Circular dependency",
            message: plan.dag.cyclePath?.join(" → ") ?? "Two or more cells depend on each other.",
            type: "error",
          });
          return;
        }
        const byId = new Map(cells.map((c) => [c.id, c] as const));
        for (const id of plan.dag.runnableIds) {
          const cell = byId.get(id);
          if (cell && cell.kind === "code") await runCell(cell);
        }
        return;
      }
      for (const cell of cells) {
        if (cell.kind === "code") await runCell(cell);
      }
    } finally {
      runAllInFlightRef.current = false;
      setRunAllBusy(false);
    }
  };

  const createNotebook = async () => {
    setCreating(true);
    setError(null);
    try {
      const data = await api<{ notebook: { id: string } }>(`/api/projects/${projectId}/notebooks`, {
        method: "POST",
        body: JSON.stringify({ datasetId: datasets[0]?.id ?? null }),
      });
      toast({ title: "Notebook created", type: "success" });
      await load();
      await openNotebook(data.notebook.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const removeNotebook = async () => {
    if (!doc) return;
    const ok = await confirm({
      title: `Delete notebook “${doc.title}”?`,
      message: "This cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api(`/api/notebooks/${doc.id}`, { method: "DELETE" });
      setDoc(null);
      setSelectedId(null);
      toast({ title: "Notebook deleted", type: "success" });
      void load();
    } catch (err) {
      toast({ title: "Could not delete notebook", message: errorMessage(err), type: "error" });
    }
  };

  const runSchedule = async (scheduleId: string) => {
    try {
      setSchedules((prev) => prev.map((s) => (s.id === scheduleId ? { ...s, lastRunStatus: "running" } : s)));
      const res = await api<{ outputUrl: string | null; message: string; status: "ok" | "error" }>(
        `/api/scheduled-notebooks/${scheduleId}/run`,
        { method: "POST" },
      );
      toast({
        title: res.status === "ok" ? "Schedule run complete" : "Schedule run failed",
        message: res.message,
        type: res.status === "ok" ? "success" : "error",
      });
      loadSchedules();
    } catch (err) {
      toast({ title: "Could not run schedule", message: errorMessage(err), type: "error" });
      loadSchedules();
    }
  };

  const deleteSchedule = async (scheduleId: string) => {
    const ok = await confirm({
      title: "Delete this schedule?",
      message: "This cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api(`/api/scheduled-notebooks/${scheduleId}`, { method: "DELETE" });
      toast({ title: "Schedule deleted", type: "success" });
      loadSchedules();
    } catch (err) {
      toast({ title: "Could not delete schedule", message: errorMessage(err), type: "error" });
    }
  };

  const doPublish = async (allowPublic: boolean) => {
    if (!doc) return;
    setPublishLoading(true);
    setPublishError(null);
    try {
      const data = await api<PublishResult>(`/api/notebooks/${doc.id}/publish`, {
        method: "POST",
        body: JSON.stringify({ viewOnly: true, allowPublic }),
      });
      setPublishResult(data);
      setDoc((d) =>
        d ? { ...d, accessMode: data.accessMode, shareUrl: data.shareUrl, publishedAt: new Date().toISOString() } : d,
      );
      toast({
        title: data.accessMode === "public" ? "Published with a public link" : "Published to the workspace",
        type: "success",
      });
    } catch (err) {
      setPublishError(errorMessage(err));
    } finally {
      setPublishLoading(false);
    }
  };

  const doUnpublish = async () => {
    if (!doc) return;
    setPublishLoading(true);
    setPublishError(null);
    try {
      await api(`/api/notebooks/${doc.id}/publish`, { method: "DELETE" });
      setPublishResult((prev) => (prev ? { ...prev, accessMode: "workspace", shareUrl: null } : prev));
      setDoc((d) => (d ? { ...d, accessMode: "workspace", shareUrl: null } : d));
      toast({ title: "Public link removed", type: "success" });
    } catch (err) {
      setPublishError(errorMessage(err));
    } finally {
      setPublishLoading(false);
    }
  };

  const copyShareUrl = async () => {
    const url = publishResult?.shareUrl ?? doc?.shareUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${url}`);
      toast({ title: "Link copied to clipboard", type: "success" });
    } catch {
      toast({
        title: "Could not copy the link automatically",
        message: `${window.location.origin}${url}`,
        type: "info",
      });
    }
  };

  if (!notebooks) {
    return <LoadingSkeleton rows={3} />;
  }
  if (notebooks.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={NotebookPen}
          title="No notebooks yet"
          description="Notebooks mix notes with runnable cells that query the project's datasets. Python (Pyodide) is optional — the prototype kernel computes deterministically in the meantime."
          action={
            <Button onClick={createNotebook} loading={creating} icon={<Plus aria-hidden className="size-4" />}>
              New notebook
            </Button>
          }
        />
      </Card>
    );
  }

  // Command Palette for notebook operations
  const CommandPalette = () => {
    if (!commandPaletteOpen || !doc) return null;
    const cells = doc.cells;
    const focusedIdx = cells.findIndex((c) => c.id === focusedCellId);
    const actions = [
      {
        id: "add-markdown",
        label: "Add Markdown cell",
        icon: FileText,
        shortcut: "M",
        handler: () => addCell("markdown"),
      },
      { id: "add-code", label: "Add Code cell", icon: ListPlus, shortcut: "C", handler: () => addCell("code") },
      { id: "add-sql", label: "Add SQL cell", icon: Table2, shortcut: "S", handler: () => addCell("sql") },
      { id: "add-chart", label: "Add Chart cell", icon: LayoutGrid, shortcut: "H", handler: () => addCell("chart") },
      {
        id: "add-table",
        label: "Add Table cell",
        icon: Table2,
        shortcut: "T",
        handler: () => addCell("table-display"),
      },
      { id: "add-pivot", label: "Add Pivot cell", icon: LayoutGrid, shortcut: "P", handler: () => addCell("pivot") },
      { id: "add-map", label: "Add Map cell", icon: MapPin, shortcut: "G", handler: () => addCell("map") },
      {
        id: "run-focused",
        label: "Run focused cell",
        icon: Play,
        shortcut: "Shift+Enter",
        handler: () => {
          const cell = cells[focusedIdx];
          if (cell) void runCell(cell);
        },
        disabled: focusedIdx < 0,
      },
      {
        id: "run-all",
        label: "Run all cells",
        icon: Sparkles,
        shortcut: "Ctrl+Shift+Enter",
        handler: () => {
          cells
            .filter((c) => ["code", "sql", "chart", "table-display", "pivot", "map"].includes(c.kind))
            .forEach((c) => void runCell(c));
        },
      },
      {
        id: "delete-focused",
        label: "Delete focused cell",
        icon: Trash2,
        shortcut: "Del",
        handler: () => {
          const cell = cells[focusedIdx];
          if (cell) removeCell(cell.id);
        },
        disabled: focusedIdx < 0,
      },
      {
        id: "move-up",
        label: "Move cell up",
        icon: ChevronUp,
        shortcut: "Alt+↑",
        handler: () => {
          const cell = cells[focusedIdx];
          if (cell && focusedIdx > 0) moveCell(cell.id, -1);
        },
        disabled: focusedIdx <= 0,
      },
      {
        id: "move-down",
        label: "Move cell down",
        icon: ChevronDown,
        shortcut: "Alt+↓",
        handler: () => {
          const cell = cells[focusedIdx];
          if (cell && focusedIdx >= 0 && focusedIdx < cells.length - 1) moveCell(cell.id, 1);
        },
        disabled: focusedIdx < 0 || focusedIdx >= cells.length - 1,
      },
    ];
    return (
      <div
        className="fixed inset-0 z-50 flex items-start justify-center pt-20 pointer-events-none"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="pointer-events-auto w-full max-w-md rounded-lg border border-line bg-surface shadow-xl overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <span className="flex size-7 items-center justify-center rounded bg-accent/10 text-accent">
              <Wand2 aria-hidden className="size-4" />
            </span>
            <input
              type="text"
              placeholder="Type a command or search…"
              autoFocus
              className="flex-1 h-9 rounded-md border-none bg-transparent px-2 text-sm focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === "Escape") setCommandPaletteOpen(false);
              }}
            />
            <kbd className="ml-auto px-2 py-0.5 text-[10px] text-muted bg-surface-2 rounded">Esc to close</kbd>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {actions.map((action) => (
              <button
                key={action.id}
                onClick={() => {
                  action.handler();
                  setCommandPaletteOpen(false);
                }}
                disabled={action.disabled}
                className={cn(
                  "w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors",
                  action.disabled ? "text-muted/50" : "text-foreground hover:bg-surface-2",
                )}
              >
                <span className="flex items-center gap-2">
                  <action.icon aria-hidden className="size-4" />
                  {action.label}
                </span>
                <kbd className="px-1.5 py-0.5 text-[10px] text-muted bg-surface-2 rounded font-mono">
                  {action.shortcut}
                </kbd>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // Schedule Dialog
  const ScheduleDialog = () => {
    if (!scheduleDialogOpen) return null;
    return (
      <Dialog
        open={scheduleDialogOpen}
        onClose={() => {
          setScheduleDialogOpen(false);
          setScheduleError(null);
        }}
        title="Create schedule"
        description="Run this notebook automatically on a cron schedule. The notebook will execute all runnable cells and export the results."
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setScheduleDialogOpen(false);
                setScheduleError(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={createSchedule} loading={scheduleSubmitting}>
              Create schedule
            </Button>
          </>
        }
      >
        {scheduleError && <div className="mb-3 p-2 rounded text-sm text-danger bg-danger/10">{scheduleError}</div>}
        <div className="space-y-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Schedule name</span>
            <input
              type="text"
              value={scheduleForm.name}
              onChange={(e) => setScheduleForm((f) => ({ ...f, name: e.target.value }))}
              className="h-9 rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
              placeholder="e.g. Daily morning report"
              required
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Cron expression</span>
            <input
              type="text"
              value={scheduleForm.cron}
              onChange={(e) => setScheduleForm((f) => ({ ...f, cron: e.target.value }))}
              className="h-9 rounded-md border border-line bg-surface px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-focus/60"
              placeholder="0 9 * * *"
              required
            />
            <p className="text-caption text-muted">
              5-field cron (minute hour day month weekday). Example: &ldquo;0 9 * * *&rdquo; = daily at 09:00
            </p>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Recipients (one email per line)</span>
            <textarea
              value={scheduleForm.recipients}
              onChange={(e) => setScheduleForm((f) => ({ ...f, recipients: e.target.value }))}
              className="h-24 rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
              placeholder="team@example.com&#10;manager@example.com"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={scheduleForm.enabled}
              onChange={(e) => setScheduleForm((f) => ({ ...f, enabled: e.target.checked }))}
              className="size-4 accent-accent"
            />
            <span className="text-sm text-foreground">Enabled</span>
          </label>
        </div>
      </Dialog>
    );
  };

  const createSchedule = async () => {
    if (!doc) return;
    setScheduleSubmitting(true);
    setScheduleError(null);
    try {
      const recipients = scheduleForm.recipients
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean);
      await api(`/api/scheduled-notebooks`, {
        method: "POST",
        body: JSON.stringify({
          name: scheduleForm.name.trim(),
          cron: scheduleForm.cron.trim(),
          notebookId: doc.id,
          recipients,
          enabled: scheduleForm.enabled,
        }),
      });
      toast({ title: "Schedule created", type: "success" });
      setScheduleDialogOpen(false);
      loadSchedules();
    } catch (err) {
      setScheduleError(errorMessage(err));
    } finally {
      setScheduleSubmitting(false);
    }
  };

  return (
    <div>
      <CommandPalette />
      <ScheduleDialog />
      {error && <ErrorMessage title="Notebook error" message={error} onRetry={() => void load()} className="mb-4" />}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Notebook</span>
        <select
          aria-label="Select notebook"
          value={selectedId ?? ""}
          onChange={(e) => void openNotebook(e.target.value)}
          className="h-9 max-w-64 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
        >
          {notebooks.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          size="sm"
          onClick={createNotebook}
          loading={creating}
          icon={<Plus aria-hidden className="size-4" />}
        >
          New
        </Button>
        <div className="flex-1" />
        {serverPythonEnabled && (
          <button
            type="button"
            onClick={() => {
              const next = kernelChoice === "server" ? "browser" : "server";
              setKernelChoice(next);
              setServerKernelError(null);
              try {
                localStorage.setItem("Ledgerly-kernel", next);
              } catch {
                // private browsing — non-fatal
              }
            }}
            title="Switch the engine that runs Python code cells"
            className="rounded px-2 py-1 text-xs"
          >
            <Badge variant={kernelChoice === "server" ? "info" : "outline"}>
              {kernelChoice === "server" ? "Python · server kernel" : "Python · browser kernel"}
            </Badge>
          </button>
        )}
        {serverKernelError && (
          <Badge variant="outline" className="text-[10px] text-danger">
            server kernel error
          </Badge>
        )}
        {kernelStatus === "fallback" ? (
          <DemoBadge
            tooltip={`${KERNEL_NOTE} What happened: ${kernelError ?? "initialization failed"}. How to fix: restore network access and retry.`}
          />
        ) : (
          <Badge variant="outline">
            {kernelStatus === "loading"
              ? kernelProgress
                ? `${kernelProgress}…`
                : "Pyodide · loading"
              : kernelStatus === "ready"
                ? "Pyodide · ready"
                : "Pyodide · loading"}
          </Badge>
        )}
        {collaborationEnabled && collab.peers.length > 0 && (
          <div className="flex items-center -space-x-1.5" aria-label={`${collab.peers.length} collaborator(s) online`}>
            {collab.peers.slice(0, 5).map((p) => (
              <span
                key={p.id}
                title={`${p.name}${p.cellId ? " · editing this notebook" : ""}`}
                className="flex size-6 items-center justify-center rounded-full border border-line text-[10px] font-semibold text-background"
                style={{ backgroundColor: p.color }}
              >
                {p.name.slice(0, 2).toUpperCase()}
              </span>
            ))}
            {collab.connected && <span className="ml-1 text-[10px] text-muted">live</span>}
          </div>
        )}
        {saving && <Badge variant="outline">Saving…</Badge>}
        {doc?.accessMode === "public" && <Badge variant="info">Public app</Badge>}
        <a
          href={`/api/notebooks/${selectedId ?? ""}/export`}
          aria-label="Export notebook as .ipynb"
          onClick={(e) => {
            if (!doc) e.preventDefault();
          }}
          className={doc ? "" : "pointer-events-none opacity-40"}
        >
          <Button variant="secondary" size="sm" disabled={!doc} icon={<Download aria-hidden className="size-4" />}>
            .ipynb
          </Button>
        </a>
        <Button
          variant="secondary"
          size="sm"
          disabled={!doc}
          onClick={() => {
            setPublishOpen((v) => !v);
            setPublishError(null);
          }}
          icon={<Share2 aria-hidden className="size-4" />}
        >
          Publish
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSidePanel(sidePanel === "schema" ? null : "schema")}
          disabled={!doc}
          icon={<Table2 aria-hidden className="size-4" />}
        >
          Schema
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSidePanel(sidePanel === "versions" ? null : "versions")}
          disabled={!doc}
          icon={<Clock aria-hidden className="size-4" />}
        >
          Versions
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSidePanel(sidePanel === "schedule" ? null : "schedule")}
          disabled={!doc}
          icon={<Clock aria-hidden className="size-4" />}
        >
          Schedule
        </Button>
        <Button
          variant={dagMode ? "primary" : "secondary"}
          size="sm"
          onClick={() => setDagMode(!dagMode)}
          disabled={!doc}
          icon={<GitBranch aria-hidden className="size-4" />}
          title={dagMode ? "DAG mode: cells run in dependency order" : "Enable DAG mode: cells run in dependency order"}
        >
          DAG
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void runAll()}
          disabled={!doc || runAllBusy}
          icon={<Play aria-hidden className="size-4" />}
        >
          Run all
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void removeNotebook()}
          disabled={!doc}
          aria-label="Delete notebook"
        >
          <Trash2 aria-hidden className="size-4 text-muted hover:text-danger" />
        </Button>
        {runningIds.size > 0 ? (
          <Badge variant="info" className="gap-1.5">
            <Loader2 aria-hidden className="size-3 animate-spin" />
            Re-running {runningIds.size} {runningIds.size === 1 ? "cell" : "cells"}
          </Badge>
        ) : null}
      </div>

      {publishOpen && doc && (
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">Publish as app</h3>
            {publishResult?.version || (doc.publishedAt && doc.accessMode === "public") ? (
              <Badge variant="outline">v{publishResult?.version ?? "—"}</Badge>
            ) : null}
            <Badge variant={doc.accessMode === "public" ? "info" : "outline"}>
              {doc.accessMode === "public" ? "Public link active" : "Workspace view"}
            </Badge>
            <div className="flex-1" />
            <Button
              size="xs"
              variant="secondary"
              loading={publishLoading}
              onClick={() => void doPublish(doc.accessMode === "public")}
            >
              Re-publish snapshot
            </Button>
          </div>
          <p className="mt-2 text-caption text-muted">
            Publishing snapshots the current cells and outputs as an immutable version. Workspace members can open the
            read-only view; only the project owner can enable a public link.
          </p>
          {publishError && <p className="mt-2 text-sm text-danger">{publishError}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={doc.accessMode === "public"}
                disabled={publishLoading}
                onChange={(e) => void doPublish(e.target.checked)}
                className="size-4 accent-accent"
              />
              Anyone with the link can view (no sign-in)
            </label>
            {(publishResult?.shareUrl ?? doc.shareUrl) && (
              <>
                <code className="max-w-xs truncate rounded bg-surface px-2 py-1 font-mono text-xs text-foreground">
                  {window.location.origin}
                  {publishResult?.shareUrl ?? doc.shareUrl}
                </code>
                <Button size="xs" variant="secondary" onClick={() => void copyShareUrl()}>
                  Copy link
                </Button>
              </>
            )}
            {publishResult?.workspaceUrl && (
              <a href={publishResult.workspaceUrl} className="text-sm text-accent underline-offset-2 hover:underline">
                Open workspace view
              </a>
            )}
            {doc.accessMode === "public" && (
              <Button size="xs" variant="ghost" loading={publishLoading} onClick={() => void doUnpublish()}>
                Remove public link
              </Button>
            )}
          </div>
        </Card>
      )}

      {doc ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTemplateOpen((open) => !open)}
            className="mr-2"
            aria-expanded={templateOpen}
            aria-controls="notebook-template-gallery"
            aria-label="Open template gallery"
          >
            <Lightbulb aria-hidden className="size-3.5" /> Templates
          </Button>
          {templateOpen && (
            <div
              id="notebook-template-gallery"
              className="mb-3 grid grid-cols-1 gap-2 rounded-md border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-3"
            >
              {TEMPLATE_COMMANDS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => insertTemplate(t.command)}
                  className="group flex items-start gap-2 rounded border border-line bg-background p-2 text-left transition-colors hover:border-focus/60 hover:bg-surface-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-foreground">{t.title}</span>
                    <code className="block truncate text-[10px] font-mono text-muted">{t.command}</code>
                  </span>
                </button>
              ))}
            </div>
          )}
          <input
            aria-label="Notebook title"
            value={doc.title}
            onChange={(e) => {
              const title = e.target.value;
              setDoc((d) => (d ? { ...d, title } : d));
              scheduleSave(doc.cells, title);
            }}
            className="mb-3 h-9 w-full max-w-md rounded-md border border-line bg-surface px-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-focus/60"
          />
          {/* Side panel: Schema Browser or Version History */}
          {sidePanel && doc && (
            <Card className="mb-4 overflow-hidden">
              <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
                <span className="text-sm font-medium text-foreground">
                  {sidePanel === "schema" ? "Schema Browser" : "Version History"}
                </span>
                <button
                  onClick={() => setSidePanel(null)}
                  className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line active:scale-95"
                  aria-label="Close panel"
                >
                  <Trash2 aria-hidden className="size-3.5" />
                </button>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {sidePanel === "schema" && doc.dataset && (
                  <SchemaBrowser
                    datasetId={doc.dataset.id}
                    compact
                    onInsertColumn={(col) => {
                      // Insert column name at the end of the last code cell or create a new one
                      const lastCodeCell = doc.cells.filter((c) => c.kind === "code").pop();
                      if (lastCodeCell) {
                        updateCell(lastCodeCell.id, { content: lastCodeCell.content + " " + col });
                      } else {
                        addCell("code");
                      }
                    }}
                  />
                )}
                {sidePanel === "versions" && (
                  <VersionHistory
                    notebookId={doc.id}
                    currentCells={doc.cells}
                    currentTitle={doc.title}
                    onRestore={(cells) => {
                      updateCells(cells);
                      toast({ title: "Version restored", type: "success" });
                    }}
                  />
                )}
                {sidePanel === "schedule" && (
                  <div className="p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium text-foreground">Scheduled Runs</h3>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setScheduleForm({ name: "", cron: "0 9 * * *", recipients: "", enabled: true });
                          setScheduleDialogOpen(true);
                        }}
                        icon={<Plus aria-hidden className="size-3.5" />}
                      >
                        New schedule
                      </Button>
                    </div>
                    {scheduleLoading ? (
                      <div className="flex justify-center py-8 text-sm text-muted">Loading schedules…</div>
                    ) : schedules.length === 0 ? (
                      <div className="py-8 text-center text-sm text-muted">
                        No schedules yet. Click &ldquo;New schedule&rdquo; to create one.
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {schedules.map((s) => (
                          <li
                            key={s.id}
                            className="flex items-center justify-between rounded border border-line p-3 hover:bg-surface-2"
                          >
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-foreground truncate">{s.name}</p>
                              <p className="text-caption text-muted">
                                {s.cron} · Next: {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—"}
                              </p>
                              {s.lastRunAt && (
                                <p className="text-caption text-muted">
                                  Last run: {new Date(s.lastRunAt).toLocaleString()} ·{" "}
                                  {s.lastRunStatus === "ok" ? "✓" : "✗"} {s.lastRunMessage ?? ""}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              {s.enabled && (
                                <Button variant="ghost" size="sm" onClick={() => runSchedule(s.id)}>
                                  <Play aria-hidden className="size-3.5" />
                                  Run now
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => deleteSchedule(s.id)}
                                className="text-muted hover:text-danger"
                              >
                                <Trash2 aria-hidden className="size-3.5" />
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </Card>
          )}

          {dagMode && doc && (
            <Card className="mb-4 p-3">
              <div className="flex items-center gap-2">
                <GitBranch aria-hidden className="size-4 text-accent" />
                <span className="text-sm font-medium text-foreground">DAG Execution Mode</span>
                <Badge variant="info">active</Badge>
              </div>
              <p className="mt-1 text-caption text-muted">
                Cells run in dependency order. Reference another cell&apos;s output with $variable_name. Set an output
                variable on a cell to make it available to downstream cells.
              </p>
            </Card>
          )}

          <div className="mb-4 flex items-center gap-2 text-sm">
            <span className="text-muted">Dataset context:</span>
            <select
              aria-label="Default dataset"
              value={doc.dataset?.id ?? ""}
              onChange={async (e) => {
                if (!doc) return;
                const id = e.target.value;
                try {
                  await api(`/api/notebooks/${doc.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ datasetId: id || null, cells: doc.cells }),
                  });
                  toast({ title: "Dataset context updated", type: "success" });
                  await openNotebook(doc.id);
                } catch (err) {
                  toast({ title: "Could not update dataset", message: errorMessage(err), type: "error" });
                }
              }}
              className="h-8 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              {datasets.length === 0 && <option value="">No datasets in this project</option>}
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} {d.isDemo ? "(demo)" : ""}
                </option>
              ))}
            </select>
            {doc.dataset && <Badge variant="outline">{doc.dataset.name}</Badge>}
          </div>

          <ol className="flex flex-col gap-3">
            {doc.cells.map((cell, i) => (
              <li
                key={cell.id}
                className={cn("card overflow-hidden", focusedCellId === cell.id && "ring-2 ring-accent/50")}
                data-cell-id={cell.id}
                data-cell-kind={cell.kind}
                onClick={() => setFocusedCellId(cell.id)}
              >
                <div className="flex items-center justify-between gap-2 border-b border-line bg-surface px-3 py-1.5">
                  <div className="flex items-center gap-1">
                    <Badge variant={cell.kind === "code" ? "accent" : cell.kind === "widget" ? "info" : "outline"}>
                      {cell.kind}
                    </Badge>
                    {cell.kind === "code" && (
                      <button
                        className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line active:scale-95"
                        onClick={() => updateCell(cell.id, { kind: "markdown" })}
                        title="Convert to markdown"
                        aria-label={`Convert cell ${i + 1} to markdown`}
                      >
                        <FileText aria-hidden className="size-3.5" />
                      </button>
                    )}
                    {cell.kind === "markdown" && (
                      <button
                        className="rounded p-0.5 text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line active:scale-95 hover:bg-surface-2 hover:text-foreground"
                        onClick={() => updateCell(cell.id, { kind: "code" })}
                        title="Convert to code"
                        aria-label={`Convert cell ${i + 1} to code`}
                      >
                        <Sparkles aria-hidden className="size-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button
                      className="rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30"
                      onClick={() => moveCell(cell.id, -1)}
                      disabled={i === 0}
                      aria-label="Move cell up"
                    >
                      <ChevronUp aria-hidden className="size-4" />
                    </button>
                    <button
                      className="rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30"
                      onClick={() => moveCell(cell.id, 1)}
                      disabled={i === doc.cells.length - 1}
                      aria-label="Move cell down"
                    >
                      <ChevronDown aria-hidden className="size-4" />
                    </button>
                    <button
                      className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                      onClick={() => removeCell(cell.id)}
                      aria-label="Delete cell"
                    >
                      <Trash2 aria-hidden className="size-4" />
                    </button>
                  </div>
                </div>

                {cell.kind === "widget" && cell.widget ? (
                  <div className="flex flex-wrap items-center gap-3 bg-background px-3 py-3">
                    <label className="text-sm font-medium text-foreground">
                      {cell.widget.label ?? cell.widget.variable}
                    </label>
                    <NotebookWidgetControl
                      widget={cell.widget}
                      onChange={(value) => updateWidgetValue(cell.id, value)}
                    />
                    <span className="text-caption text-muted">binds {"{{" + cell.widget.variable + "}}"}</span>
                  </div>
                ) : cell.kind === "code" ? (
                  <>
                    <CopilotTextarea
                      value={cell.content}
                      onChange={(value) => {
                        lastLocalEditRef.current.set(cell.id, Date.now());
                        updateCell(cell.id, { content: value });
                        if (collaborationEnabled) collab.pushCellText(cell.id, value);
                      }}
                      onRun={() => void runCell(cell)}
                      columns={datasetColumnsRef.current.map((c) => c.name)}
                      notebookId={doc.id}
                      datasetName={doc.dataset?.name}
                      ariaLabel={`Cell ${i + 1} (code)`}
                      placeholder={
                        cell.content.startsWith("%")
                          ? "Type a % command or /llm for the assistant…"
                          : "Write Python, or /llm for the assistant…"
                      }
                    />
                    <CursorOverlay
                      cellId={cell.id}
                      cellKind={cell.kind}
                      isCollaborative={doc?.accessMode !== "workspace" || true}
                      notebookId={doc.id ?? "/tmp"}
                      kernel={pyodideKernel}
                    />
                  </>
                ) : (
                  <textarea
                    value={cell.content}
                    onChange={(e) => updateCell(cell.id, { content: e.target.value })}
                    aria-label={`Cell ${i + 1} (markdown)`}
                    spellCheck
                    className="min-h-20 w-full resize-y bg-background px-3 py-2 text-sm leading-relaxed focus:outline-none"
                  />
                )}

                {/* Cell config panels for new cell types */}
                {cell.kind === "sql" && (
                  <div className="border-t border-line bg-surface px-3 py-2">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-caption text-muted">SQL + Jinja Query</label>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline" className="text-[10px]">
                          Jinja
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          dbt
                        </Badge>
                      </div>
                    </div>
                    {/* Jinja/dbt snippet helpers */}
                    <div className="mb-2 flex flex-wrap gap-1">
                      {[
                        { label: "ref()", snippet: "{{ ref('model_name') }}", title: "dbt model reference" },
                        {
                          label: "source()",
                          snippet: "{{ source('source_name', 'table_name') }}",
                          title: "dbt source reference",
                        },
                        {
                          label: "var()",
                          snippet: "{{ var('variable_name', 'default') }}",
                          title: "dbt project variable",
                        },
                        {
                          label: "if/endif",
                          snippet: "{% if condition %}\n  ...\n{% endif %}",
                          title: "Conditional block",
                        },
                        {
                          label: "for",
                          snippet: "{% for item in items %}\n  {{ item }}\n{% endfor %}",
                          title: "For loop",
                        },
                        { label: "set", snippet: "{% set my_var = 'value' %}", title: "Set variable" },
                        { label: "{{ var }}", snippet: "{{ variable_name }}", title: "Variable interpolation" },
                        {
                          label: "{{ var | default }}",
                          snippet: "{{ variable | default('fallback') }}",
                          title: "Variable with default",
                        },
                        {
                          label: "{{ var | sqlsafe }}",
                          snippet: "{{ column_name | sqlsafe }}",
                          title: "Safe identifier (bypass prepared statement)",
                        },
                        { label: "{{ arr | array }}", snippet: "{{ list_var | array }}", title: "Array parameter" },
                      ].map((s) => (
                        <button
                          key={s.label}
                          onClick={() => {
                            const currentQuery = cell.sqlConfig?.query ?? cell.content ?? "";
                            const newQuery =
                              currentQuery + (currentQuery && !currentQuery.endsWith("\n") ? "\n" : "") + s.snippet;
                            updateCell(cell.id, {
                              content: newQuery,
                              sqlConfig: { ...cell.sqlConfig, query: newQuery, datasetId: doc?.dataset?.id },
                            });
                          }}
                          className="rounded border border-line bg-background px-1.5 py-0.5 text-[10px] font-mono text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line hover:bg-surface-2 hover:text-foreground"
                          title={s.title}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                    {/* Jinja variable bindings */}
                    {extractJinjaVars(cell.sqlConfig?.query ?? cell.content ?? "").length > 0 && (
                      <div className="mb-2 rounded border border-accent/30 bg-accent/5 px-2 py-1.5" key="jinja-vars">
                        <p className="text-[10px] font-medium text-accent">Jinja variables detected:</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {extractJinjaVars(cell.sqlConfig?.query ?? cell.content ?? "").map((v) => (
                            <Badge key={v} variant="accent" className="text-[10px]">
                              {v}
                            </Badge>
                          ))}
                        </div>
                        <p className="mt-1 text-[10px] text-muted">Set values below before running.</p>
                      </div>
                    )}
                    <textarea
                      value={cell.sqlConfig?.query ?? cell.content}
                      onChange={(e) =>
                        updateCell(cell.id, {
                          content: e.target.value,
                          sqlConfig: { ...cell.sqlConfig, query: e.target.value, datasetId: doc?.dataset?.id },
                        })
                      }
                      className="min-h-20 w-full resize-y rounded-md border border-line bg-background px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                      placeholder="SELECT * FROM {{ ref('users') }} WHERE {{ var('status', 'active') }} LIMIT 100"
                      spellCheck={false}
                    />
                    {/* Jinja variable value inputs */}
                    {extractJinjaVars(cell.sqlConfig?.query ?? cell.content ?? "").length > 0 && (
                      <div className="mt-2 space-y-1.5" key="jinja-inputs">
                        <p className="text-[10px] font-medium text-muted">Variable values:</p>
                        <div className="grid grid-cols-2 gap-1.5">
                          {extractJinjaVars(cell.sqlConfig?.query ?? cell.content ?? "").map((varName) => (
                            <div key={varName} className="flex items-center gap-1.5">
                              <label className="w-24 truncate text-[10px] text-muted" title={varName}>
                                {varName}:
                              </label>
                              <input
                                type="text"
                                value={String(
                                  (cell.sqlConfig as unknown as Record<string, unknown>)?.[`jinja_${varName}`] ?? "",
                                )}
                                onChange={(e) => {
                                  const prev = (cell.sqlConfig as unknown as Record<string, unknown>) ?? {};
                                  const jinjaVars = {
                                    ...((prev.jinjaVars as Record<string, unknown>) ?? {}),
                                    [varName]: e.target.value,
                                  };
                                  updateCell(cell.id, {
                                    sqlConfig: {
                                      ...cell.sqlConfig,
                                      jinjaVars,
                                      [`jinja_${varName}`]: e.target.value,
                                      datasetId: doc?.dataset?.id,
                                    } as typeof cell.sqlConfig,
                                  });
                                }}
                                className="h-6 flex-1 rounded border border-line bg-background px-1.5 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-focus/60"
                                placeholder="value"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {cell.kind === "chart" && (
                  <div className="border-t border-line bg-surface px-3 py-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="text-xs text-muted">Type:</label>
                      <select
                        value={cell.chartConfig?.chartType ?? "bar"}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            chartConfig: {
                              ...cell.chartConfig,
                              chartType: e.target.value as ChartCellConfig["chartType"],
                            } as ChartCellConfig,
                          })
                        }
                        className="h-7 rounded border border-line bg-background px-1.5 text-xs"
                      >
                        {(["bar", "line", "scatter", "donut", "area", "heatmap", "histogram"] as const).map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                      <label className="text-xs text-muted">X:</label>
                      <select
                        value={cell.chartConfig?.xColumn ?? ""}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            chartConfig: { ...cell.chartConfig, xColumn: e.target.value } as ChartCellConfig,
                          })
                        }
                        className="h-7 rounded border border-line bg-background px-1.5 text-xs"
                      >
                        {datasetColumnsRef.current.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <label className="text-xs text-muted">Y:</label>
                      <select
                        value={cell.chartConfig?.yColumns?.[0] ?? ""}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            chartConfig: { ...cell.chartConfig, yColumns: [e.target.value] } as ChartCellConfig,
                          })
                        }
                        className="h-7 rounded border border-line bg-background px-1.5 text-xs"
                      >
                        {datasetColumnsRef.current.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <label className="text-xs text-muted">Title:</label>
                      <input
                        type="text"
                        value={cell.chartConfig?.title ?? ""}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            chartConfig: { ...cell.chartConfig, title: e.target.value } as ChartCellConfig,
                          })
                        }
                        className="h-7 w-40 rounded border border-line bg-background px-1.5 text-xs"
                        placeholder="Auto-generated"
                      />
                    </div>
                  </div>
                )}
                {cell.kind === "table-display" && (
                  <div className="border-t border-line bg-surface px-3 py-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="text-xs text-muted">Columns:</label>
                      <input
                        type="text"
                        value={cell.tableDisplayConfig?.columns?.join(", ") ?? ""}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            tableDisplayConfig: {
                              ...cell.tableDisplayConfig,
                              columns: e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            } as TableDisplayConfig,
                          })
                        }
                        className="h-7 w-48 rounded border border-line bg-background px-1.5 text-xs"
                        placeholder="All columns (comma-separated)"
                      />
                      <label className="text-xs text-muted">Limit:</label>
                      <input
                        type="number"
                        value={cell.tableDisplayConfig?.limit ?? 50}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            tableDisplayConfig: {
                              ...cell.tableDisplayConfig,
                              limit: parseInt(e.target.value) || 50,
                            } as TableDisplayConfig,
                          })
                        }
                        className="h-7 w-16 rounded border border-line bg-background px-1.5 text-xs"
                        min={1}
                        max={500}
                      />
                      <label className="text-xs text-muted">Sort:</label>
                      <select
                        value={cell.tableDisplayConfig?.sortBy ?? ""}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            tableDisplayConfig: {
                              ...cell.tableDisplayConfig,
                              sortBy: e.target.value || undefined,
                            } as TableDisplayConfig,
                          })
                        }
                        className="h-7 rounded border border-line bg-background px-1.5 text-xs"
                      >
                        <option value="">None</option>
                        {datasetColumnsRef.current.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <label className="flex items-center gap-1.5 text-xs text-muted">
                        <input
                          type="checkbox"
                          checked={cell.tableDisplayConfig?.showRowNumbers ?? true}
                          onChange={(e) =>
                            updateCell(cell.id, {
                              tableDisplayConfig: {
                                ...cell.tableDisplayConfig,
                                showRowNumbers: e.target.checked,
                              } as TableDisplayConfig,
                            })
                          }
                          className="size-3 accent-accent"
                        />
                        Row numbers
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-muted">
                        <input
                          type="checkbox"
                          checked={cell.tableDisplayConfig?.enableFilter ?? false}
                          onChange={(e) =>
                            updateCell(cell.id, {
                              tableDisplayConfig: {
                                ...cell.tableDisplayConfig,
                                enableFilter: e.target.checked,
                              } as TableDisplayConfig,
                            })
                          }
                          className="size-3 accent-accent"
                        />
                        Column filters
                      </label>
                    </div>
                    <p className="mt-1 text-caption text-muted">
                      Conditional formatting rules can be configured via the output panel after running.
                    </p>
                  </div>
                )}
                {cell.kind === "pivot" && (
                  <div className="border-t border-line bg-surface px-3 py-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="text-xs text-muted">Rows:</label>
                      <select
                        value={cell.pivotConfig?.rowColumns?.[0] ?? ""}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            pivotConfig: {
                              ...cell.pivotConfig,
                              rowColumns: [e.target.value].filter(Boolean),
                            } as PivotCellConfig,
                          })
                        }
                        className="h-7 rounded border border-line bg-background px-1.5 text-xs"
                      >
                        <option value="">Select…</option>
                        {datasetColumnsRef.current.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <label className="text-xs text-muted">Value:</label>
                      <select
                        value={cell.pivotConfig?.values?.[0]?.column ?? ""}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            pivotConfig: {
                              ...cell.pivotConfig,
                              values: [
                                {
                                  column: e.target.value,
                                  aggregation: cell.pivotConfig?.values?.[0]?.aggregation ?? "sum",
                                },
                              ],
                            } as PivotCellConfig,
                          })
                        }
                        className="h-7 rounded border border-line bg-background px-1.5 text-xs"
                      >
                        <option value="">Select…</option>
                        {datasetColumnsRef.current
                          .filter((c) => c.type === "number")
                          .map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                      <label className="text-xs text-muted">Agg:</label>
                      <select
                        value={cell.pivotConfig?.values?.[0]?.aggregation ?? "sum"}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            pivotConfig: {
                              ...cell.pivotConfig,
                              values: [
                                {
                                  column: cell.pivotConfig?.values?.[0]?.column ?? "",
                                  aggregation: e.target.value as PivotCellConfig["values"][0]["aggregation"],
                                },
                              ],
                            } as PivotCellConfig,
                          })
                        }
                        className="h-7 rounded border border-line bg-background px-1.5 text-xs"
                      >
                        {(["sum", "count", "avg", "min", "max"] as const).map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                {cell.kind === "map" && (
                  <div className="border-t border-line bg-surface px-3 py-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="text-xs text-muted">Lat:</label>
                      <select
                        value={cell.mapConfig?.latColumn ?? ""}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            mapConfig: { ...cell.mapConfig, latColumn: e.target.value } as MapCellConfig,
                          })
                        }
                        className="h-7 rounded border border-line bg-background px-1.5 text-xs"
                      >
                        {datasetColumnsRef.current.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <label className="text-xs text-muted">Lng:</label>
                      <select
                        value={cell.mapConfig?.lngColumn ?? ""}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            mapConfig: { ...cell.mapConfig, lngColumn: e.target.value } as MapCellConfig,
                          })
                        }
                        className="h-7 rounded border border-line bg-background px-1.5 text-xs"
                      >
                        {datasetColumnsRef.current.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <label className="text-xs text-muted">Size:</label>
                      <select
                        value={cell.mapConfig?.sizeColumn ?? ""}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            mapConfig: { ...cell.mapConfig, sizeColumn: e.target.value || undefined } as MapCellConfig,
                          })
                        }
                        className="h-7 rounded border border-line bg-background px-1.5 text-xs"
                      >
                        <option value="">None</option>
                        {datasetColumnsRef.current
                          .filter((c) => c.type === "number")
                          .map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                      <label className="text-xs text-muted">Color:</label>
                      <select
                        value={cell.mapConfig?.colorColumn ?? ""}
                        onChange={(e) =>
                          updateCell(cell.id, {
                            mapConfig: { ...cell.mapConfig, colorColumn: e.target.value || undefined } as MapCellConfig,
                          })
                        }
                        className="h-7 rounded border border-line bg-background px-1.5 text-xs"
                      >
                        <option value="">None</option>
                        {datasetColumnsRef.current.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                {cell.kind === "code" && (
                  <div className="flex items-center gap-2 border-t border-line bg-surface px-3 py-1.5">
                    <Button
                      size="xs"
                      onClick={() => void runCell(cell)}
                      loading={runningIds.has(cell.id)}
                      icon={<Play aria-hidden className="size-3" />}
                    >
                      Run
                    </Button>
                    {cell.ranAt && (
                      <span className="text-caption text-muted">ran {new Date(cell.ranAt).toLocaleTimeString()}</span>
                    )}
                    <span className="ml-auto text-caption text-muted">Ctrl/⌘ + Enter</span>
                  </div>
                )}
                {(cell.kind === "sql" ||
                  cell.kind === "chart" ||
                  cell.kind === "table-display" ||
                  cell.kind === "pivot" ||
                  cell.kind === "map") && (
                  <div className="flex items-center gap-2 border-t border-line bg-surface px-3 py-1.5">
                    <Button
                      size="xs"
                      onClick={() => void runCell(cell)}
                      loading={runningIds.has(cell.id)}
                      icon={<Play aria-hidden className="size-3" />}
                    >
                      Run
                    </Button>
                    {cell.ranAt && (
                      <span className="text-caption text-muted">ran {new Date(cell.ranAt).toLocaleTimeString()}</span>
                    )}
                  </div>
                )}
                {cell.output && <CellOutput output={cell.output} />}
              </li>
            ))}
          </ol>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => addCell("markdown")}
              icon={<FileText aria-hidden className="size-4" />}
            >
              Markdown
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => addCell("code")}
              icon={<ListPlus aria-hidden className="size-4" />}
            >
              Code
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => addCell("sql")}
              icon={<Table2 aria-hidden className="size-4" />}
              title="SQL cell — run SELECT queries"
            >
              SQL
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => addCell("chart")}
              icon={<LayoutGrid aria-hidden className="size-4" />}
              title="Chart cell — interactive visualization"
            >
              Chart
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => addCell("table-display")}
              icon={<Table2 aria-hidden className="size-4" />}
              title="Table cell — data with conditional formatting"
            >
              Table
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => addCell("pivot")}
              icon={<LayoutGrid aria-hidden className="size-4" />}
              title="Pivot cell — no-code pivot tables"
            >
              Pivot
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => addCell("map")}
              icon={<MapPin aria-hidden className="size-4" />}
              title="Map cell — geo visualization"
            >
              Map
            </Button>
            <div className="relative">
              <Button
                variant="secondary"
                size="sm"
                data-widget-trigger
                onClick={() => setWidgetMenuOpen((v) => !v)}
                aria-expanded={widgetMenuOpen}
                aria-haspopup="menu"
                aria-controls="widget-add-menu"
                icon={<Wand2 aria-hidden className="size-4" />}
              >
                Widget
              </Button>
              {widgetMenuOpen && (
                <div
                  id="widget-add-menu"
                  role="menu"
                  aria-label="Add input widget"
                  className="absolute bottom-full left-0 z-20 mb-1 w-52 overflow-hidden rounded-md border border-line bg-surface shadow-lg"
                >
                  {(Object.keys(WIDGET_KIND_LABELS) as NotebookWidgetKind[]).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      role="menuitem"
                      onClick={() => addWidgetCell(kind)}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-foreground hover:bg-surface-2"
                    >
                      <span>{WIDGET_KIND_LABELS[kind]}</span>
                      <span className="text-caption text-muted">{kind}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <Card>
          <EmptyState
            icon={NotebookPen}
            title="Open a notebook"
            description="Pick a notebook above or create a new one."
          />
        </Card>
      )}
    </div>
  );
}

function CellOutput({ output }: { output: NotebookCellOutput }) {
  if (output.type === "error") {
    return (
      <div role="alert" className="border-t border-danger/30 bg-danger/5 px-3 py-2.5 font-mono text-[13px] text-danger">
        {output.message}
      </div>
    );
  }
  if (output.type === "note") {
    return (
      <div className="border-t border-info/30 bg-info/5 px-3 py-2.5 text-sm">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <Sparkles aria-hidden className="size-4 text-info" /> {output.title}
        </p>
        <p className="mt-1 text-muted">{output.detail}</p>
      </div>
    );
  }
  if (output.type === "image") {
    return (
      <div className="border-t border-line px-3 py-3">
        <Image
          src={`data:${output.image.mimeType};base64,${output.image.data}`}
          alt="Python chart output"
          width={800}
          height={500}
          unoptimized
          className="h-auto max-w-full"
        />
      </div>
    );
  }
  if (output.type === "stats") {
    return (
      <div className="border-t border-line px-3 py-3">
        <p className="mb-2 text-caption font-medium text-foreground">{output.title}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
          {output.stats.map((s) => (
            <div key={s.label} className="text-sm">
              <dt className="text-caption text-muted">{s.label}</dt>
              <dd className="tabular-nums font-medium text-foreground" title={s.hint}>
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }
  if (output.type === "chart") {
    return (
      <div className="border-t border-line px-3 py-3">
        <p className="mb-1 text-sm font-medium text-foreground">{output.chart.title}</p>
        <p className="mb-2 text-caption text-muted">{output.chart.subtitle}</p>
        <ul className="flex flex-col gap-1">
          {output.chart.categories?.map((cat, i) => {
            const v = output.chart.series[0]?.data?.[i] ?? null;
            return (
              <li key={cat} className="flex items-center gap-2 text-sm">
                <span className="w-24 truncate text-muted">{cat}</span>
                <span
                  aria-hidden
                  className="h-3 flex-1 rounded-sm bg-accent/70"
                  style={{
                    width: `${Math.min(100, Math.max(2, ((v ?? 0) / maxOf(output.chart.series[0]?.data ?? []) || 1) * 100))}%`,
                    maxWidth: "60%",
                  }}
                />
                <span className="w-20 text-right tabular-nums text-foreground">
                  {v === null ? "—" : Number(v).toLocaleString()}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  if (output.type === "table") {
    return (
      <div className="thin-scroll border-t border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-caption text-muted">
            <tr>
              {output.columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-3 py-1.5 font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {output.rows.map((row, i) => (
              <tr key={i}>
                {output.columns.map((c, j) => (
                  <td key={c.key} className="whitespace-nowrap px-3 py-1.5 text-foreground">
                    {row[j] === null || row[j] === undefined ? "—" : String(row[j])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (output.type === "sql-result") {
    return (
      <div className="border-t border-line px-3 py-3">
        <div className="flex items-center gap-2 mb-2">
          <Table2 aria-hidden className="size-4 text-accent" />
          <span className="text-sm font-medium text-foreground">{output.title}</span>
          {output.truncated && <Badge variant="warning">truncated</Badge>}
        </div>
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-caption text-muted">
              <tr>
                {output.columns.map((c) => (
                  <th key={c.name} className="whitespace-nowrap px-3 py-1.5 font-medium">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {output.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((val, j) => (
                    <td key={j} className="whitespace-nowrap px-3 py-1.5 text-foreground">
                      {val === null || val === undefined ? "—" : String(val)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-caption text-muted">
          {output.engine} · {output.executionMs}ms · {output.note}
        </p>
      </div>
    );
  }
  if (output.type === "conditional-table") {
    return (
      <div className="thin-scroll border-t border-line overflow-x-auto">
        <div className="px-3 py-1.5">
          <span className="text-sm font-medium text-foreground">{output.title}</span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-caption text-muted">
            <tr>
              {output.columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-3 py-1.5 font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {output.rows.map((row, i) => (
              <tr key={i}>
                {output.columns.map((c, j) => {
                  const style = output.cellStyles[`${i}:${j}`];
                  return (
                    <td
                      key={c.key}
                      className="whitespace-nowrap px-3 py-1.5"
                      style={style ? { backgroundColor: style.bg, color: style.color } : undefined}
                    >
                      {row[j] === null || row[j] === undefined ? "—" : String(row[j])}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (output.type === "pivot-result") {
    return (
      <div className="thin-scroll border-t border-line overflow-x-auto">
        <div className="px-3 py-1.5">
          <span className="text-sm font-medium text-foreground">{output.title}</span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-caption text-muted">
            <tr>
              <th className="px-3 py-1.5 font-medium">Row</th>
              {output.columnHeaders.map((ch, i) => (
                <th key={i} className="whitespace-nowrap px-3 py-1.5 font-medium">
                  {ch}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {output.data.map((row, i) => (
              <tr key={i}>
                <td className="whitespace-nowrap px-3 py-1.5 font-medium text-foreground">{output.rowHeaders[i]}</td>
                {row.map((val, j) => (
                  <td key={j} className="whitespace-nowrap px-3 py-1.5 tabular-nums text-foreground">
                    {val === null || val === undefined
                      ? "—"
                      : typeof val === "number"
                        ? val.toLocaleString()
                        : String(val)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (output.type === "map-result") {
    return (
      <div className="border-t border-line px-3 py-3">
        <div className="flex items-center gap-2 mb-2">
          <MapPin aria-hidden className="size-4 text-accent" />
          <span className="text-sm font-medium text-foreground">{output.title}</span>
        </div>
        <div className="relative h-64 rounded-md border border-line bg-surface overflow-hidden">
          <div className="absolute inset-0 bg-background">
            {output.points.length > 0 && (
              <svg viewBox="-180 -90 360 180" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
                <rect x={-180} y={-90} width={360} height={180} fill="transparent" />
                {output.points.map((p, i) => {
                  const cx = p.lng;
                  const cy = -p.lat;
                  const r = Math.max(2, Math.min(8, (p.size ?? 1) * 0.1));
                  return (
                    <circle key={i} cx={cx} cy={cy} r={r} fill={p.color ?? "#5AA8AA"} opacity={0.7}>
                      <title>{p.label ? `${p.label} (${p.lat}, ${p.lng})` : `(${p.lat}, ${p.lng})`}</title>
                    </circle>
                  );
                })}
              </svg>
            )}
          </div>
        </div>
        <p className="mt-2 text-caption text-muted">
          {output.points.length} point{output.points.length !== 1 ? "s" : ""}
        </p>
      </div>
    );
  }
  return (
    <pre className="thin-scroll border-t border-line bg-background px-3 py-2.5 font-mono text-[13px] whitespace-pre-wrap text-foreground">
      {output.text}
    </pre>
  );
}

function maxOf(values: (number | null)[]): number {
  return Math.max(1, ...values.map((v) => (typeof v === "number" ? v : 0)));
}

/**
 * Extract Jinja variable names from a template string.
 * Matches patterns like {{ var_name }} and {{ var_name | filter }}.
 */
function extractJinjaVars(template: string): string[] {
  const vars = new Set<string>();
  const regex = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let match;
  while ((match = regex.exec(template)) !== null) {
    const name = match[1];
    // Skip Jinja built-in functions and keywords
    if (name && !["true", "false", "none", "null", "loop", "namespace", "range", "dict", "list"].includes(name)) {
      vars.add(name);
    }
  }
  return Array.from(vars).sort();
}
