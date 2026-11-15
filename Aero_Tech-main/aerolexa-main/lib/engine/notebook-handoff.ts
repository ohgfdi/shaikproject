/**
 * Notebook SQL→Python handoff (ROADMAP 4.1's missing half).
 *
 * SQL cells already execute and render; the missing piece was handing their
 * RESULT SET to a downstream Python cell as a pandas DataFrame. The server
 * kernel (lib/engine/python/python-kernel.ts) accepts `extras` — named
 * { columns, rows } pairs materialized as `df_<name>` globals in the worker
 * (see worker-bootstrap.js). This module is the pure bridge between a
 * notebook's SQL-cell outputs and that payload:
 *
 *   - `handoffName`     — a SQL cell's outputVariable sanitized to a legal,
 *     collision-free Python identifier (`df_` prefix is added by the worker).
 *   - `sqlOutputToExtra`— sql-result → extra (typed columns + rows, capped).
 *   - `collectExtras`   — walk the notebook's cells in document order and
 *     build the extras payload from every SQL (or tabular) cell that ran.
 *
 * Deterministic and dependency-free so the whole handoff is unit-gated; the
 * run route only composes it.
 */

import { downstreamOf } from "@/lib/engine/notebook-widgets";
import type { NotebookCell, NotebookCellOutput } from "@/lib/types";

/** Largest extra handed to Python (rows) — Python cells run under a timeout, keep payloads sane. */
export const HANDOFF_ROW_CAP = 20_000;

/**
 * Sanitize a cell's outputVariable into a Python-safe identifier.
 * Empty/invalid input → null (the cell gets no handoff name).
 */
export function handoffName(outputVariable: string | undefined): string | null {
  if (!outputVariable) return null;
  const cleaned = outputVariable
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^([0-9])/, "v$1")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
  if (!cleaned || /^(df|__)$/i.test(cleaned)) return null;
  return cleaned;
}

/** Shape the Python worker accepts as an extra (worker-bootstrap.js). */
export interface PythonExtra {
  name: string;
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
}

/** Tabular cell outputs that can be handed to Python as a DataFrame. */
export type TabularOutput = Extract<NotebookCellOutput, { type: "sql-result" | "table" | "conditional-table" }>;

/** True when a cell output carries a tabular payload usable as a DataFrame. */
export function isTabularOutput(output: NotebookCellOutput | null | undefined): output is TabularOutput {
  if (!output) return false;
  return output.type === "sql-result" || output.type === "table" || output.type === "conditional-table";
}

/**
 * Convert one tabular cell output into a Python extra.
 * Rows beyond HANDOFF_ROW_CAP are dropped (reported via `truncated`), never
 * silently wrapped into a broken frame.
 */
export function sqlOutputToExtra(
  name: string,
  output: NotebookCellOutput,
): { extra: PythonExtra; truncated: boolean } | null {
  if (!isTabularOutput(output)) return null;
  const safeName = handoffName(name);
  if (!safeName) return null;

  if (output.type === "sql-result") {
    const rows = output.rows.slice(0, HANDOFF_ROW_CAP);
    return {
      extra: {
        name: safeName,
        columns: output.columns.map((c) => ({ name: c.name, type: String(c.type) })),
        rows: rows.map((r) => r.map((v) => (v === undefined ? null : v))),
      },
      truncated: output.rows.length > HANDOFF_ROW_CAP,
    };
  }
  // table / conditional-table: { key, label } columns + flat rows
  const rows = output.rows.slice(0, HANDOFF_ROW_CAP) as (string | number | boolean | null)[][];
  return {
    extra: {
      name: safeName,
      columns: output.columns.map((c) => ({ name: c.key, type: "string" })),
      rows: rows.map((r) => r.map((v) => (v === undefined ? null : v))),
    },
    truncated: output.rows.length > HANDOFF_ROW_CAP,
  };
}

/**
 * Collect the extras payload for a Python run: walk the notebook's cells in
 * document order and take every RAN tabular cell that declared an
 * outputVariable. Later cells with the same name win (last-write-wins
 * mirrors Python assignment semantics).
 */
export function collectExtras(cells: NotebookCell[]): { extras: PythonExtra[]; truncatedNames: string[] } {
  const byName = new Map<string, { extra: PythonExtra; truncated: boolean }>();
  for (const cell of cells) {
    const name = handoffName(cell.outputVariable);
    if (!name || !cell.output) continue;
    const converted = sqlOutputToExtra(name, cell.output);
    if (!converted) continue;
    byName.set(name, converted);
  }
  const extras: PythonExtra[] = [];
  const truncatedNames: string[] = [];
  for (const [name, { extra, truncated }] of byName) {
    extras.push(extra);
    if (truncated) truncatedNames.push(name);
  }
  return { extras, truncatedNames };
}

/**
 * Names of the extras a Python cell can reference, rendered for the model
 * prompt / UI hint: `df_<name>` DataFrames with their columns.
 */
export function describeExtras(extras: PythonExtra[]): string[] {
  return extras.map((e) => `df_${e.name} (${e.columns.map((c) => c.name).join(", ")})`);
}

// ---------------------------------------------------------------------------
// Reactive parameter cells (ROADMAP 4.3's server half)
// ---------------------------------------------------------------------------

/**
 * The re-run plan after a widget's value changes: every runnable cell
 * transitively downstream of it (lib/engine/notebook-widgets.ts
 * `downstreamOf` — output-variable refs, `{{variable}}` tokens and explicit
 * dependencies), in deterministic document order.
 *
 * The widget cell itself is deliberately NOT in the plan: a parameter cell has
 * no code to execute, and `downstreamOf` only emits runnable kinds, so
 * including it would be a guaranteed no-op. Re-rendering the changed value is
 * local state, not a run.
 *
 * The route returns this plan with every response; the client executes the
 * cell it came for, then re-runs the plan ids in order. Pure so the
 * ordering/coverage contract is unit-gated.
 */
export function reactiveRerunPlan(cells: NotebookCell[], widgetCellId: string): string[] {
  const widget = cells.find((c) => c.id === widgetCellId);
  if (!widget || widget.kind !== "widget") return [];
  return downstreamOf(cells, widgetCellId).map((c) => c.id);
}
