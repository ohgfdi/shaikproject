/**
 * Phase 1.5 — Reproducibility & versioning.
 *
 * Pure helpers (no filesystem / prisma imports) so they stay unit-testable:
 *  - nextDatasetVersionNumber / nextAnalysisVersionNumber: monotonic numbering
 *  - computeChangeLog: dataset snapshot diff (rows added/removed/changed)
 *  - extractVersionMetrics: pull diff-able metrics out of an AnalysisResult
 *  - diffAnalysisMetrics: compare two versions' metrics (what moved, by how much)
 *  - analysisVersionIpynb / notebookIpynb: export to valid nbformat 4 JSON
 *
 * Filesystem snapshot writing lives in lib/server/versioning.ts (server-only).
 */

import { isTableOutput } from "@/lib/engine/notebook-output";
import type { AnalysisResult, NotebookCell, NotebookCellOutput, TableSpec } from "@/lib/types";

// ---------------------------------------------------------------------------
// Version numbering
// ---------------------------------------------------------------------------

/** Next monotonic version number given the highest existing one (-1 when none). */
export function nextVersionNumber(currentMax: number): number {
  return Math.max(0, Math.floor(currentMax)) + 1;
}

// ---------------------------------------------------------------------------
// Dataset snapshot diff
// ---------------------------------------------------------------------------

export interface VersionChangeLog {
  previousVersion: number | null;
  newVersion: number;
  previousRowCount: number;
  newRowCount: number;
  rowsAdded: number;
  rowsRemoved: number;
  /** rows with identical shape whose cell values differ */
  rowsChanged: number;
  comparedRows: number;
  truncated: boolean;
  note: string;
}

type Row = (string | number | boolean | null)[];

function rowKey(row: Row): string {
  return JSON.stringify(row);
}

/**
 * Diff the previous version's rows against the new rows. Multiset-aware:
 * duplicated rows are matched before being counted as added/removed.
 */
export function computeDatasetVersionChangeLog(
  previous: { version: number; rows: Row[] } | null,
  next: { version: number; rows: Row[] },
  opts: { note?: string; truncated?: boolean } = {},
): VersionChangeLog {
  const prevCounts = new Map<string, number>();
  if (previous) {
    for (const row of previous.rows) prevCounts.set(rowKey(row), (prevCounts.get(rowKey(row)) ?? 0) + 1);
  }
  const nextCounts = new Map<string, number>();
  for (const row of next.rows) nextCounts.set(rowKey(row), (nextCounts.get(rowKey(row)) ?? 0) + 1);

  let rowsAdded = 0;
  let rowsRemoved = 0;
  const shapes = new Set<string>();
  for (const row of next.rows) shapes.add(String(row.length));
  // For changed detection, align rows by position only when both sides have
  // the same shape; otherwise positional comparison is meaningless.
  let rowsChanged = 0;
  if (
    previous &&
    previous.rows.length > 0 &&
    shapes.size === 1 &&
    previous.rows.every((r) => r.length === next.rows[0]?.length)
  ) {
    const n = Math.min(previous.rows.length, next.rows.length);
    for (let i = 0; i < n; i++) {
      if (rowKey(previous.rows[i] as Row) !== rowKey(next.rows[i] as Row)) rowsChanged++;
    }
  }

  const allKeys = new Set([...prevCounts.keys(), ...nextCounts.keys()]);
  for (const key of allKeys) {
    const before = prevCounts.get(key) ?? 0;
    const after = nextCounts.get(key) ?? 0;
    if (after > before) rowsAdded += after - before;
    if (before > after) rowsRemoved += before - after;
  }

  const note =
    opts.note ??
    (previous
      ? `Snapshot v${next.version} vs v${previous.version}: +${rowsAdded} / -${rowsRemoved} rows` +
        (rowsChanged ? `, ${rowsChanged} changed` : "") +
        "."
      : `Initial snapshot v${next.version} (${next.rows.length} rows).`);

  return {
    previousVersion: previous ? previous.version : null,
    newVersion: next.version,
    previousRowCount: previous ? previous.rows.length : 0,
    newRowCount: next.rows.length,
    rowsAdded,
    rowsRemoved,
    rowsChanged,
    comparedRows: next.rows.length,
    truncated: opts.truncated ?? false,
    note,
  };
}

// ---------------------------------------------------------------------------
// Analysis metric extraction + diff
// ---------------------------------------------------------------------------

export interface VersionMetric {
  /** metric key, e.g. "stats.revenue.mean" or "charts.0.points" */
  key: string;
  label: string;
  value: number;
}

function pushMetric(out: VersionMetric[], key: string, label: string, value: number | undefined | null): void {
  if (typeof value === "number" && Number.isFinite(value)) out.push({ key, label, value });
}

/**
 * Parse a human-formatted metric value back into a number, or null when it is
 * not numeric. Handles thousands separators, currency symbols, percents, and
 * compact K/M suffixes — the inverse of the in-app `fmt` helpers.
 */
export function parseMetricNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === "n/a" || lower === "na" || lower === "—" || lower === "–" || lower === "null") return null;
  const match = s.replace(/[$€£,\s]/g, "").match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*([km])?\s*%?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const scale = (match[2] ?? "").toLowerCase();
  return scale === "k" ? value * 1_000 : scale === "m" ? value * 1_000_000 : value;
}

/**
 * Extract a flat, diff-able list of numeric metrics from an AnalysisResult:
 * top-level stats chips plus per-chart aggregate values and table summaries.
 */
export function extractVersionMetrics(result: AnalysisResult): VersionMetric[] {
  const out: VersionMetric[] = [];
  if (result.stats) {
    for (const [i, stat] of result.stats.entries()) {
      const value = parseMetricNumber(stat.value);
      if (value !== null) {
        out.push({ key: `stats.${i}`, label: stat.label, value });
      }
    }
  }
  result.charts.forEach((chart, ci) => {
    // Per-series aggregates — stable across chart kinds (data = category values,
    // points = scatter x/y pairs).
    const series = chart.series ?? [];
    series.forEach((s, si) => {
      const data = (s.data ?? []).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const points = (s.points ?? []).map((p) => p.y).filter((v) => typeof v === "number" && Number.isFinite(v));
      const values = data.length > 0 ? data : points;
      if (values.length === 0) return;
      const sum = values.reduce((a, v) => a + v, 0);
      pushMetric(out, `charts.${ci}.series.${si}.sum`, `${chart.title} — ${s.name} sum`, sum);
      pushMetric(out, `charts.${ci}.series.${si}.count`, `${chart.title} — ${s.name} points`, values.length);
      pushMetric(out, `charts.${ci}.series.${si}.first`, `${chart.title} — ${s.name} first`, values[0]);
      pushMetric(out, `charts.${ci}.series.${si}.last`, `${chart.title} — ${s.name} last`, values[values.length - 1]);
    });
  });
  (result.tables ?? []).forEach((table, ti) => {
    // Numeric summary of each table: total of numeric cells in the first 5 columns.
    (table.rows ?? []).slice(0, 200).forEach((row, ri) => {
      (table.columns ?? []).slice(0, 5).forEach((col, coli) => {
        const raw = (row as unknown[])[coli];
        const value = typeof raw === "number" ? raw : parseMetricNumber(String(raw ?? ""));
        if (value !== null) {
          pushMetric(out, `tables.${ti}.r${ri}.c${coli}`, `${table.title} — ${col.label} row ${ri + 1}`, value);
        }
      });
    });
  });
  return out;
}

export interface MetricDiff {
  key: string;
  label: string;
  before: number;
  after: number;
  delta: number;
  deltaPct: number | null; // null when before === 0
}

/**
 * Compare two versions' metric lists. Keys present on only one side are
 * reported with the missing side as 0 so the UI can flag them as new/removed.
 */
export function diffAnalysisMetrics(
  before: VersionMetric[],
  after: VersionMetric[],
): { changed: MetricDiff[]; added: VersionMetric[]; removed: VersionMetric[]; unchangedCount: number } {
  const beforeMap = new Map(before.map((m) => [m.key, m]));
  const afterMap = new Map(after.map((m) => [m.key, m]));
  const changed: MetricDiff[] = [];
  let unchangedCount = 0;
  for (const [key, afterMetric] of afterMap) {
    const beforeMetric = beforeMap.get(key);
    if (!beforeMetric) continue;
    const delta = afterMetric.value - beforeMetric.value;
    if (Math.abs(delta) < 1e-12) {
      unchangedCount++;
      continue;
    }
    changed.push({
      key,
      label: afterMetric.label,
      before: beforeMetric.value,
      after: afterMetric.value,
      delta,
      deltaPct: beforeMetric.value === 0 ? null : (delta / Math.abs(beforeMetric.value)) * 100,
    });
  }
  changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const added = after.filter((m) => !beforeMap.has(m.key));
  const removed = before.filter((m) => !afterMap.has(m.key));
  return { changed, added, removed, unchangedCount };
}

// ---------------------------------------------------------------------------
// nbformat 4 export
// ---------------------------------------------------------------------------

export type NbformatOutput =
  // nbformat 4 schema: `name` and (ename, evalue, traceback) are REQUIRED on
  // stream / error outputs — nbformat ≥ 5 warns and future versions hard-fail
  // without them.
  | { output_type: "stream"; name: string; text: string[] }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] }
  | { output_type: "display_data"; data: Record<string, string[]>; metadata: Record<string, unknown> }
  | {
      output_type: "execute_result";
      data: Record<string, string[]>;
      metadata: Record<string, unknown>;
      execution_count: number;
    };

export interface NbformatCell {
  cell_type: "code" | "markdown";
  metadata: Record<string, unknown>;
  source: string[];
  outputs?: NbformatOutput[];
  execution_count?: number | null;
}

export interface NbformatNotebook {
  nbformat: 4;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NbformatCell[];
}

function toSourceLines(text: string): string[] {
  const lines = text.split("\n");
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
}

/** Code-cell output in nbformat 4 shape, derived from a NotebookCellOutput. */
function cellOutputsToNbformat(output: NotebookCellOutput | null | undefined): NbformatCell["outputs"] {
  if (!output) return [];
  if (output.type === "image") {
    return [
      {
        output_type: "display_data",
        data: { [output.image.mimeType]: [output.image.data] },
        metadata: {},
      },
    ];
  }
  if (isTableOutput(output)) {
    const markdown = [
      `| ${output.columns.map((c) => c.label).join(" | ")} |`,
      `| ${output.columns.map(() => "---").join(" | ")} |`,
      ...output.rows.slice(0, 50).map((row) => `| ${row.map((cell) => String(cell ?? "")).join(" | ")} |`),
    ].join("\n");
    return [{ output_type: "display_data", data: { "text/markdown": toSourceLines(markdown) }, metadata: {} }];
  }
  const text =
    output.type === "text"
      ? output.text
      : output.type === "error"
        ? output.message
        : output.type === "note"
          ? `${output.title}\n${output.detail}`.trim()
          : output.type === "stats"
            ? output.stats.map((s) => `${s.label}: ${s.value}`).join("\n")
            : "";
  if (!text) return [];
  // Same mapping as lib/export/python.ts: stream outputs carry the required
  // `name` channel and error outputs the required ename/evalue/traceback trio.
  return [
    output.type === "error"
      ? {
          output_type: "error",
          ename: "Error",
          evalue: text.split("\n")[0] ?? text,
          traceback: toSourceLines(text),
        }
      : { output_type: "stream", name: "stdout", text: toSourceLines(text) },
  ];
}

/** Export a notebook's cells to valid nbformat 4 JSON (cells + outputs preserved). */
export function notebookIpynb(title: string, cells: NotebookCell[]): NbformatNotebook {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3 (Pyodide)", language: "python", name: "python3" },
      language_info: { name: "python", version: "3.12" },
      aerolexa: { title, exportedAt: new Date().toISOString(), source: "Ledgerly notebook export" },
    },
    cells: cells.map((cell) => {
      if (cell.kind === "markdown") {
        return { cell_type: "markdown", metadata: {}, source: toSourceLines(cell.content) } as NbformatCell;
      }
      const outputs = cellOutputsToNbformat(cell.output);
      return {
        cell_type: "code",
        metadata: cell.ranAt ? { aerolexa: { ranAt: cell.ranAt } } : {},
        source: toSourceLines(cell.content),
        outputs,
        execution_count: cell.ranAt ? 1 : null,
      } as NbformatCell;
    }),
  };
}

/**
 * Export an analysis result as a runnable Jupyter notebook: the analysis
 * methodology becomes markdown and every chart's data becomes pandas cells.
 */
export function analysisVersionIpynb(result: AnalysisResult, config: Record<string, unknown>): NbformatNotebook {
  const cells: NbformatCell[] = [];
  cells.push({
    cell_type: "markdown",
    metadata: {},
    source: toSourceLines(
      `# ${result.title}\n\nExported from Ledgerly — reproduces the “${result.kind}” analysis against the same dataset.`,
    ),
  });
  cells.push({
    cell_type: "code",
    metadata: {},
    source: toSourceLines(
      [
        "import pandas as pd",
        "",
        "# Load the dataset this analysis ran on (CSV path or connector snapshot).",
        'df = pd.read_csv("dataset.csv")  # ← point at your file',
        "df.head()",
      ].join("\n"),
    ),
    outputs: [],
    execution_count: null,
  });
  cells.push({
    cell_type: "markdown",
    metadata: {},
    source: toSourceLines(
      [
        "## Configuration",
        "",
        "```json",
        JSON.stringify(config, null, 2),
        "```",
        "",
        "## Methodology",
        "",
        `**${result.methodology.method}**`,
        "",
        ...result.methodology.steps.map((s) => `- ${s}`),
        "",
        ...result.methodology.assumptions.map((a) => `- Assumption: ${a}`),
      ].join("\n"),
    ),
  });
  for (const [ci, chart] of (result.charts ?? []).entries()) {
    const seriesLines: string[] = ["import json", "", `chart = json.loads(r'''${JSON.stringify(chart)}''')`];
    for (const [si, s] of (chart.series ?? []).entries()) {
      seriesLines.push(
        `series_${si} = pd.Series(chart["series"][${si}].get("data") or [p["y"] for p in chart["series"][${si}].get("points") or []])`,
      );
      seriesLines.push(`display(series_${si})  # ${s.name}`);
    }
    cells.push({
      cell_type: "markdown",
      metadata: {},
      source: toSourceLines(`## Chart ${ci + 1}: ${chart.title}`),
    });
    cells.push({
      cell_type: "code",
      metadata: {},
      source: toSourceLines(seriesLines.join("\n")),
      outputs: [],
      execution_count: null,
    });
  }
  for (const [ti, table] of (result.tables ?? []).entries()) {
    cells.push({
      cell_type: "markdown",
      metadata: {},
      source: toSourceLines(`## Table ${ti + 1}: ${table.title}`),
    });
    const columns = (table.columns ?? []).map((c) => c.label);
    cells.push({
      cell_type: "code",
      metadata: {},
      source: toSourceLines(
        [
          `table_${ti} = json.loads(r'''${JSON.stringify({ columns, rows: table.rows ?? [] })}''')`,
          `df_table_${ti} = pd.DataFrame(table_${ti}["rows"], columns=table_${ti}["columns"])`,
          `display(df_table_${ti})`,
        ].join("\n"),
      ),
      outputs: [],
      execution_count: null,
    });
  }
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python", version: "3.12" },
      aerolexa: { kind: result.kind, exportedAt: new Date().toISOString(), source: "Ledgerly analysis export" },
    },
    cells,
  };
}

// ---------------------------------------------------------------------------

export type { TableSpec };
