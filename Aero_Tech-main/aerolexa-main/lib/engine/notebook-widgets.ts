/**
 * Notebook widget variable substitution (pure, dependency-free).
 *
 * Widget cells bind a named variable. Code cells reference it with
 * `{{variable}}`. Before execution the reference is replaced with the
 * widget's current value:
 *
 *   - DSL cells (content starting with `%`) get the raw value, so
 *     `%kpi {{metric}}` becomes `%kpi revenue`.
 *   - Python cells get a literal, so
 *     `region = {{region}}` becomes `region = "East"` and
 *     `start = {{range.min}}` … wait — date ranges are substituted as one
 *     token: `{{period}}` becomes `{"min": "2023-01-01", "max": "2023-02-01"}`.
 *
 * Tokens that don't resolve are left untouched so a missing widget surfaces
 * as a normal "column not found" style error instead of silent deletion.
 */

import type { NotebookCell, NotebookWidgetValue } from "@/lib/types";

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Render a widget value as a SQL literal for SQL cells.
 * Numbers stay bare; strings are single-quoted with internal quotes escaped;
 * ranges substitute to a SQL-safe delimited pair (the caller is expected to
 * use them against BETWEEN-style predicates); null becomes NULL.
 */
export function widgetSqlLiteral(value: NotebookWidgetValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  return `${sqlQuote(String(value.min))} AND ${sqlQuote(String(value.max))}`;
}

function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Render a widget value as a raw (unquoted) token for DSL commands. */
export function widgetRaw(value: NotebookWidgetValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return `${String(value.min)}..${String(value.max)}`;
}

/** Render a widget value as a JavaScript/Python literal for code cells. */
export function widgetLiteral(value: NotebookWidgetValue): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify({
    min: typeof value.min === "number" ? value.min : String(value.min),
    max: typeof value.max === "number" ? value.max : String(value.max),
  });
}

/**
 * Substitute `{{variable}}` tokens in cell content from the widget values map.
 * `values` maps variable name → NotebookWidgetValue.
 */
export function substituteWidgetVariables(
  content: string,
  values: Record<string, NotebookWidgetValue>,
  mode: "dsl" | "literal" | "sql" = content.trimStart().startsWith("%") ? "dsl" : "literal",
): string {
  return content.replace(TOKEN_RE, (match, name: string) => {
    if (!(name in values)) return match; // unresolved → leave the token visible
    const value = values[name] as NotebookWidgetValue | undefined;
    if (value === undefined) return match;
    if (mode === "dsl") return widgetRaw(value);
    if (mode === "sql") return widgetSqlLiteral(value);
    return widgetLiteral(value);
  });
}

/** Collect the current widget values of a notebook's widget cells. */
export function widgetValuesFromCells(cells: NotebookCell[]): Record<string, NotebookWidgetValue> {
  const values: Record<string, NotebookWidgetValue> = {};
  for (const cell of cells) {
    if (cell.kind === "widget" && cell.widget) {
      values[cell.widget.variable] = cell.widget.value ?? null;
    }
  }
  return values;
}

/** Does this code cell reference any widget variable? */
export function referencesWidgetVariable(content: string): boolean {
  return TOKEN_RE.test(content);
}

/**
 * The set of cells transitively downstream of `sourceCellId` — every runnable
 * cell that (directly or through other cells) references the source's output
 * variable, reads the same widget variable, or declares it as a dependency.
 * Deterministic breadth-first walk over the explicit + implicit edges.
 */
export function downstreamOf(
  cells: NotebookCell[],
  sourceCellId: string,
  opts?: { changedVariable?: string },
): NotebookCell[] {
  const RUNNABLE = new Set(["code", "sql", "chart", "table-display", "pivot", "map"]);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const outputVarOf = new Map<string, string>();
  for (const c of cells) {
    if (c.outputVariable) outputVarOf.set(c.outputVariable, c.id);
  }

  const directDepends = (cell: NotebookCell, targetId: string): boolean => {
    if (cell.dependencies?.some((d) => d.dependsOn === targetId)) return true;
    const outVar = byId.get(targetId)?.outputVariable;
    if (outVar) {
      // Output-variable references: $var (code/DSL) or {{var}} (widgets/SQL).
      const text = cell.kind === "sql" ? `${cell.content}\n${cell.sqlConfig?.query ?? ""}` : cell.content;
      if (text.includes(`$${outVar}`) || text.includes(`{{${outVar}}}`)) return true;
      // SQL cells may consume another cell's dataset via its output name.
      if (cell.kind === "sql" && cell.sqlConfig?.datasetId === outVar) return true;
    }
    return false;
  };

  const touchesVariable = (cell: NotebookCell, variable: string): boolean =>
    cell.content.includes(`{{${variable}}}`) || cell.dependencies?.some((d) => d.variable === variable) === true;

  const out: NotebookCell[] = [];
  const queued = new Set<string>([sourceCellId]);
  const queue: string[] = [sourceCellId];
  for (let i = 0; i < queue.length; i++) {
    const currentId = queue[i]!;
    const current = byId.get(currentId);
    const changedVariable = current?.kind === "widget" ? current.widget?.variable : current?.outputVariable;
    for (const cell of cells) {
      if (!RUNNABLE.has(cell.kind) || queued.has(cell.id)) continue;
      const isDownstream =
        directDepends(cell, currentId) ||
        (changedVariable ? touchesVariable(cell, changedVariable) : false) ||
        (opts?.changedVariable && currentId === sourceCellId ? touchesVariable(cell, opts.changedVariable) : false);
      if (isDownstream) {
        queued.add(cell.id);
        queue.push(cell.id);
        out.push(cell);
      }
    }
  }
  // Document order for deterministic re-run sequencing.
  const order = new Map(cells.map((c, i) => [c.id, i]));
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}
