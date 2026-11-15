/**
 * SQL executor for notebook SQL cells.
 *
 * Wraps the prototype SQL engine to execute SELECT queries against dataset
 * rows in the notebook context. Used by the notebook run route for `sql`
 * cell type execution.
 *
 * Dependency-free + unit-tested.
 */

import { renderJinja, type DbtContext } from "@/lib/engine/jinja";
import type { NotebookCellOutput, ColumnDef } from "@/lib/types";

export interface SqlExecutionContext {
  datasetName: string;
  columns: ColumnDef[];
  rows: (string | number | boolean | null)[][];
  totalRows: number;
  rowLimit: number;
  /** Jinja template variables. */
  jinjaVars?: Record<string, unknown>;
  /** dbt context for ref/source/var macros. */
  dbt?: DbtContext;
  /** List of known dataset/table names for dbt ref resolution. */
  knownDatasets?: string[];
}

/**
 * Execute a SQL query against the dataset context.
 * For notebook SQL cells, this delegates to the notebook DSL's %rows-like
 * execution but wraps it in a SQL-like result format.
 */
export function executeSqlQuery(query: string, ctx: SqlExecutionContext): NotebookCellOutput {
  const trimmed = query.trim();

  if (!trimmed) {
    return {
      type: "error",
      message: "SQL cell is empty. Write a SELECT query to query your data.",
    };
  }

  // Render Jinja templates if the query contains Jinja syntax
  let renderedQuery = trimmed;
  const hasJinja = trimmed.includes("{{") || trimmed.includes("{%") || trimmed.includes("{%");
  if (hasJinja) {
    try {
      // Build dbt context with dataset-aware ref/source resolution
      const defaultDbt: DbtContext = {
        ref: (modelName: string) => {
          // Check if the model matches a known dataset
          if (ctx.knownDatasets?.includes(modelName)) return modelName;
          return modelName;
        },
        source: (sourceName: string, tableName: string) => `${sourceName}_${tableName}`,
        var: (varName: string, defaultVal?: unknown) => {
          return ctx.jinjaVars?.[varName] ?? defaultVal ?? "";
        },
      };

      renderedQuery = renderJinja(trimmed, {
        ...ctx.jinjaVars,
        ref: defaultDbt.ref,
        source: defaultDbt.source,
        var: defaultDbt.var,
        _dbt: ctx.dbt ?? defaultDbt,
      });
    } catch (err) {
      return {
        type: "error",
        message: `Jinja template error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Simple SQL parsing for common patterns
  const upperQuery = trimmed.toUpperCase();

  // Handle basic SELECT queries
  if (upperQuery.startsWith("SELECT")) {
    return executeSelectQuery(renderedQuery, ctx);
  }

  return {
    type: "error",
    message: `Only SELECT queries are supported. Found: "${trimmed.slice(0, 50)}${trimmed.length > 50 ? "…" : ""}"`,
  };
}

function executeSelectQuery(query: string, ctx: SqlExecutionContext): NotebookCellOutput {
  // Jinja rendering is already applied; use the raw query for SQL parsing

  // Parse SELECT columns
  const selectMatch = query.match(/SELECT\s+(.*?)\s+FROM/i);
  if (!selectMatch) {
    return { type: "error", message: "Invalid SELECT syntax. Use: SELECT columns FROM dataset" };
  }

  const selectExpr = selectMatch[1]!.trim();
  const isStar = selectExpr === "*";

  // Parse WHERE clause
  const whereMatch = query.match(/WHERE\s+(.*?)(?:\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)/i);

  // Parse GROUP BY
  const groupByMatch = query.match(/GROUP\s+BY\s+(.*?)(?:\s+HAVING|\s+ORDER\s+BY|\s+LIMIT|$)/i);

  // Parse ORDER BY
  const orderByMatch = query.match(/ORDER\s+BY\s+(.*?)(?:\s+LIMIT|$)/i);

  // Parse LIMIT
  const limitMatch = query.match(/LIMIT\s+(\d+)/i);

  const limit = limitMatch ? Math.min(parseInt(limitMatch[1]!, 10) || 100, 500) : 100;

  // Build result columns
  let resultColumns: { name: string; type: string }[];
  let rows: (string | number | boolean | null)[][];

  if (isStar) {
    resultColumns = ctx.columns;
    rows = ctx.rows;
  } else {
    // Parse individual column expressions
    const exprs = parseSelectExpressions(selectExpr);
    resultColumns = exprs.map((expr) => ({
      name: expr.alias || expr.name || expr.raw,
      type: "number", // default; will be refined below
    }));

    // Evaluate expressions against rows
    rows = ctx.rows.map((row) => {
      return exprs.map((expr) => evaluateExpression(expr, row, ctx.columns));
    });
  }

  // Apply WHERE filter
  if (whereMatch) {
    const whereClause = whereMatch[1]!.trim();
    rows = rows.filter((row) => evaluateWhereClause(whereClause, row, resultColumns));
  }

  // Apply GROUP BY
  if (groupByMatch) {
    const groupByCols = groupByMatch[1]!.split(",").map((s) => s.trim());
    rows = applyGroupBy(rows, resultColumns, groupByCols, selectExpr);
    resultColumns = deriveGroupByColumns(groupByCols, selectExpr, resultColumns);
  }

  // Apply ORDER BY
  if (orderByMatch) {
    const orderExpr = orderByMatch[1]!.trim();
    rows = applyOrderBy(rows, resultColumns, orderExpr);
  }

  // Apply LIMIT
  const truncated = rows.length > limit;
  const totalMatched = rows.length;
  rows = rows.slice(0, limit);

  // Determine column types from data
  resultColumns = resultColumns.map((col, i) => ({
    ...col,
    type: inferColumnType(rows.map((r) => r[i] ?? null)),
  }));

  return {
    type: "sql-result",
    title: `SQL result — ${rows.length.toLocaleString()} rows`,
    columns: resultColumns.map((c) => ({ name: c.name, type: c.type as "string" | "number" | "date" | "boolean" })),
    rows,
    rowCount: rows.length,
    totalMatched,
    truncated,
    engine: "notebook-sql",
    note: truncated
      ? `Results truncated at ${limit} rows. Use LIMIT to control the output.`
      : "Results from notebook SQL cell against active dataset.",
    executionMs: 0,
  };
}

interface SelectExpression {
  raw: string;
  name: string | null;
  alias: string | null;
  aggFn?: "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";
  aggArg?: string;
}

function parseSelectExpressions(expr: string): SelectExpression[] {
  const parts: SelectExpression[] = [];
  let depth = 0;
  let current = "";

  for (const char of expr) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(parseOneExpression(current.trim()));
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(parseOneExpression(current.trim()));
  return parts;
}

function parseOneExpression(raw: string): SelectExpression {
  // Check for alias (AS keyword)
  const asMatch = raw.match(/^(.+?)\s+AS\s+(\S+)$/i);
  const expr = asMatch ? asMatch[1]!.trim() : raw;
  const alias = asMatch ? asMatch[2]!.trim() : null;

  // Check for aggregation
  const aggMatch = expr.match(/^(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(\*|\S+)\s*\)$/i);
  if (aggMatch) {
    return {
      raw,
      name: alias || raw,
      alias,
      aggFn: aggMatch[1]!.toUpperCase() as "COUNT" | "SUM" | "AVG" | "MIN" | "MAX",
      aggArg: aggMatch[2],
    };
  }

  // Simple column reference
  return { raw: expr.trim(), name: alias || expr.trim(), alias };
}

function evaluateExpression(
  expr: SelectExpression,
  row: (string | number | boolean | null)[],
  columns: { name: string; type: string }[],
): string | number | boolean | null {
  if (expr.aggFn) {
    // Aggregation — handled at GROUP BY level; return raw for now
    return null;
  }

  // Simple column reference
  const colIdx = columns.findIndex((c) => c.name === expr.name || c.name === expr.raw);
  if (colIdx >= 0) return row[colIdx] ?? null;

  // Try numeric literal
  const num = Number(expr.raw);
  if (Number.isFinite(num)) return num;

  // Try string literal
  if (expr.raw.startsWith("'") && expr.raw.endsWith("'")) {
    return expr.raw.slice(1, -1);
  }

  return null;
}

function evaluateWhereClause(
  clause: string,
  row: (string | number | boolean | null)[],
  columns: { name: string; type: string }[],
): boolean {
  // Full boolean grammar (no more flat AND-split): OR < AND < NOT < ( … ) <
  // comparison. Parenthesized groups now evaluate correctly, e.g.
  // `(region = 'East' OR region = 'West') AND units > 3`.
  return parseOr(tokenizeWhere(clause), row, columns).value;
}

/* ------------------------------------------------------------------ */
/* WHERE boolean grammar (recursive descent, whitespace-insensitive)   */
/*                                                                     */
/*   or_expr  := and_expr ( OR and_expr )*                             */
/*   and_expr := not_expr ( AND not_expr )*                            */
/*   not_expr := NOT not_expr | primary                                */
/*   primary  := ( or_expr ) | condition                               */
/* ------------------------------------------------------------------ */

interface WhereToken {
  kind: "op" | "(" | ")" | "cond";
  /** op value: AND | OR | NOT; cond value: the raw comparison text. */
  text: string;
}

/** Tokenize a WHERE clause into parens, AND/OR/NOT and raw comparisons. */
function tokenizeWhere(clause: string): WhereToken[] {
  const tokens: WhereToken[] = [];
  let buf = "";

  const flushCond = () => {
    const text = buf.trim();
    buf = "";
    if (text !== "") tokens.push({ kind: "cond", text });
  };

  // Split on words/parens while respecting quoted literals.
  let i = 0;
  let quote: string | null = null;
  while (i < clause.length) {
    const ch = clause[i]!;
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      i++;
      continue;
    }
    if (ch === "(") {
      flushCond();
      tokens.push({ kind: "(", text: "(" });
      i++;
      continue;
    }
    if (ch === ")") {
      flushCond();
      tokens.push({ kind: ")", text: ")" });
      i++;
      continue;
    }
    // Word boundary check for AND / OR / NOT
    if (/\s/.test(ch)) {
      const rest = clause.slice(i);
      const word = /^(AND|OR|NOT)(\s|$|\()/i.exec(rest);
      if (word) {
        flushCond();
        tokens.push({ kind: "op", text: word[1]!.toUpperCase() });
        i += word[1]!.length;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flushCond();
  return tokens;
}

interface ParseResult {
  value: boolean;
  next: number;
}

function parseOr(
  tokens: WhereToken[],
  row: (string | number | boolean | null)[],
  columns: { name: string; type: string }[],
  pos = 0,
): ParseResult {
  let acc = parseAnd(tokens, row, columns, pos);
  let p = acc.next;
  while (p < tokens.length && tokens[p]!.kind === "op" && tokens[p]!.text === "OR") {
    const rhs = parseAnd(tokens, row, columns, p + 1);
    acc = { value: acc.value || rhs.value, next: rhs.next };
    p = rhs.next;
  }
  return { value: acc.value, next: p };
}

function parseAnd(
  tokens: WhereToken[],
  row: (string | number | boolean | null)[],
  columns: { name: string; type: string }[],
  pos = 0,
): ParseResult {
  let acc = parseNot(tokens, row, columns, pos);
  let p = acc.next;
  while (p < tokens.length && tokens[p]!.kind === "op" && tokens[p]!.text === "AND") {
    const rhs = parseNot(tokens, row, columns, p + 1);
    acc = { value: acc.value && rhs.value, next: rhs.next };
    p = rhs.next;
  }
  return { value: acc.value, next: p };
}

function parseNot(
  tokens: WhereToken[],
  row: (string | number | boolean | null)[],
  columns: { name: string; type: string }[],
  pos = 0,
): ParseResult {
  if (pos < tokens.length && tokens[pos]!.kind === "op" && tokens[pos]!.text === "NOT") {
    const inner = parseNot(tokens, row, columns, pos + 1);
    return { value: !inner.value, next: inner.next };
  }
  return parsePrimary(tokens, row, columns, pos);
}

function parsePrimary(
  tokens: WhereToken[],
  row: (string | number | boolean | null)[],
  columns: { name: string; type: string }[],
  pos = 0,
): ParseResult {
  if (pos >= tokens.length) {
    throw new Error("WHERE clause ended unexpectedly — check for an incomplete condition.");
  }
  const tok = tokens[pos]!;
  if (tok.kind === "(") {
    const inner = parseOr(tokens, row, columns, pos + 1);
    const close = tokens[inner.next];
    if (!close || close.kind !== ")") {
      throw new Error("WHERE clause has an unclosed parenthesis.");
    }
    return { value: inner.value, next: inner.next + 1 };
  }
  if (tok.kind === "cond") {
    const negate = /^NOT\s+/i.test(tok.text);
    const condText = negate ? tok.text.slice(4).trim() : tok.text;
    const cond = splitConditions(condText)[0];
    if (!cond) throw new Error(`WHERE could not parse the condition “${tok.text}”.`);
    const result = evaluateCondition(cond, row, columns);
    return { value: negate ? !result : result, next: pos + 1 };
  }
  throw new Error(`WHERE clause has an unexpected token near “${tok.text}”.`);
}

interface ParsedCondition {
  left: string;
  op: string;
  right: string;
  negate: boolean;
}

function splitConditions(clause: string): ParsedCondition[] {
  const conditions: ParsedCondition[] = [];
  // Single-condition splitter (the boolean OR/AND/parens grammar above
  // handles composition; this only decomposes one comparison).
  const parts = clause.split(/\s+(?:AND|OR)\s+/i);

  for (const part of parts) {
    if (part.toUpperCase() === "AND" || part.toUpperCase() === "OR") continue;

    let negate = false;
    let cond = part.trim();
    if (cond.toUpperCase().startsWith("NOT ")) {
      negate = true;
      cond = cond.slice(4).trim();
    }

    // Parse comparison
    const ops = ["!=", "<>", ">=", "<=", "=", "<", ">", "LIKE", "IS NOT NULL", "IS NULL"];
    let foundOp = "";
    let left = "";
    let right = "";

    for (const op of ops) {
      const idx = cond.toUpperCase().indexOf(op);
      if (idx >= 0) {
        foundOp = op;
        left = cond.slice(0, idx).trim();
        right = cond.slice(idx + op.length).trim();
        break;
      }
    }

    if (foundOp) {
      conditions.push({ left, op: foundOp, right, negate });
    }
  }

  return conditions;
}

function evaluateCondition(
  cond: ParsedCondition,
  row: (string | number | boolean | null)[],
  columns: { name: string; type: string }[],
): boolean {
  const leftIdx = columns.findIndex((c) => c.name === cond.left);
  const leftVal = leftIdx >= 0 ? row[leftIdx] : null;

  if (cond.op === "IS NULL") return leftVal === null || leftVal === undefined;
  if (cond.op === "IS NOT NULL") return leftVal !== null && leftVal !== undefined;

  const rightVal = parseWhereValue(cond.right);

  if (cond.op === "=") return leftVal === rightVal || String(leftVal) === String(rightVal);
  if (cond.op === "!=" || cond.op === "<>") return leftVal !== rightVal && String(leftVal) !== String(rightVal);
  if (cond.op === "LIKE") {
    const pattern = String(rightVal).replace(/%/g, ".*").replace(/_/g, ".");
    return new RegExp(`^${pattern}$`, "i").test(String(leftVal ?? ""));
  }

  const leftNum = Number(leftVal);
  const rightNum = Number(rightVal);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
    switch (cond.op) {
      case "<":
        return leftNum < rightNum;
      case "<=":
        return leftNum <= rightNum;
      case ">":
        return leftNum > rightNum;
      case ">=":
        return leftNum >= rightNum;
    }
  }

  return false;
}

function parseWhereValue(val: string): string | number | boolean | null {
  const trimmed = val.trim();
  if (trimmed.toUpperCase() === "NULL") return null;
  if (trimmed.toUpperCase() === "TRUE") return true;
  if (trimmed.toUpperCase() === "FALSE") return false;
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  const num = Number(trimmed);
  if (Number.isFinite(num)) return num;
  return trimmed;
}

function applyGroupBy(
  rows: (string | number | boolean | null)[][],
  columns: { name: string; type: string }[],
  groupByCols: string[],
  selectExpr: string,
): (string | number | boolean | null)[][] {
  const groups = new Map<string, (string | number | boolean | null)[][]>();

  for (const row of rows) {
    const key = groupByCols
      .map((col) => {
        const idx = columns.findIndex((c) => c.name === col);
        return idx >= 0 ? String(row[idx] ?? "(null)") : "";
      })
      .join("||");
    const arr = groups.get(key) ?? [];
    arr.push(row);
    groups.set(key, arr);
  }

  const result: (string | number | boolean | null)[][] = [];
  const exprs = parseSelectExpressions(selectExpr);

  for (const [, groupRows] of groups) {
    const resultRow: (string | number | boolean | null)[] = [];
    for (const expr of exprs) {
      if (expr.aggFn) {
        resultRow.push(evaluateAggregation(expr.aggFn, expr.aggArg!, groupRows, columns));
      } else {
        const idx = columns.findIndex((c) => c.name === expr.name || c.name === expr.raw);
        resultRow.push(idx >= 0 ? (groupRows[0]![idx] ?? null) : null);
      }
    }
    result.push(resultRow);
  }

  return result;
}

function deriveGroupByColumns(
  groupByCols: string[],
  _selectExpr: string,
  originalColumns: { name: string; type: string }[],
): { name: string; type: string }[] {
  // In GROUP BY mode, result columns are: group-by columns + aggregate columns
  return groupByCols.map((col) => {
    const found = originalColumns.find((c) => c.name === col);
    return found ?? { name: col, type: "string" };
  });
}

function evaluateAggregation(
  fn: string,
  arg: string,
  rows: (string | number | boolean | null)[][],
  columns: { name: string; type: string }[],
): number | null {
  if (fn === "COUNT" && (arg === "*" || arg === "*")) {
    return rows.length;
  }

  const colIdx = columns.findIndex((c) => c.name === arg);
  if (colIdx < 0) return null;

  const values = rows.map((r) => Number(r[colIdx])).filter((n) => Number.isFinite(n));

  if (values.length === 0) return null;

  switch (fn) {
    case "SUM":
      return values.reduce((a, b) => a + b, 0);
    case "AVG":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "MIN":
      return Math.min(...values);
    case "MAX":
      return Math.max(...values);
    default:
      return null;
  }
}

function applyOrderBy(
  rows: (string | number | boolean | null)[][],
  columns: { name: string; type: string }[],
  orderExpr: string,
): (string | number | boolean | null)[][] {
  const parts = orderExpr.split(/\s+/);
  const colName = parts[0];
  const desc = parts[1]?.toUpperCase() === "DESC";
  const colIdx = columns.findIndex((c) => c.name === colName);

  if (colIdx < 0) return rows;

  return [...rows].sort((a, b) => {
    const av = a[colIdx];
    const bv = b[colIdx];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return desc ? bv - av : av - bv;
    }
    const cmp = String(av).localeCompare(String(bv));
    return desc ? -cmp : cmp;
  });
}

function inferColumnType(values: (string | number | boolean | null)[]): string {
  let numCount = 0;
  let dateCount = 0;
  let boolCount = 0;
  let strCount = 0;

  for (const val of values) {
    if (val === null || val === undefined) continue;
    if (typeof val === "boolean") {
      boolCount++;
      continue;
    }
    if (typeof val === "number") {
      numCount++;
      continue;
    }
    const s = String(val);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) dateCount++;
    else strCount++;
  }

  const total = numCount + dateCount + boolCount + strCount;
  if (total === 0) return "string";
  if (numCount / total > 0.8) return "number";
  if (dateCount / total > 0.8) return "date";
  if (boolCount / total > 0.8) return "boolean";
  return "string";
}
