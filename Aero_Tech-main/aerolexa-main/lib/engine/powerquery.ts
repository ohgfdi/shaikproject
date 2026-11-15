/**
 * Power Query–style transformation engine ("Applied Steps" pipeline).
 *
 * Semantics: each step is a pure function (rows, columns) -> (rows, columns)
 * applied in order. Every step is deterministic; no LLM, no sampling. Numbers
 * use JS doubles exactly like Excel/Power Query, so results are bit-identical
 * across reruns and provable in unit tests against hand-computed answers.
 *
 * Security: literal-only expressions (no eval, no Function constructor).
 * Custom columns parse a restricted arithmetic/comparison grammar below.
 */
import type { ColumnDef, ColType } from "@/lib/types";

export type PQValue = string | number | boolean | null;
export type PQRow = PQValue[];

export interface PQColumn extends ColumnDef {
  /** Origin bookkeeping so the step list can explain provenance. */
  origin?: "source" | "derived";
}

export interface PQStepBase {
  id: string;
  /** Human label shown in the Applied Steps bar. */
  label: string;
}

export type PQStep =
  | (PQStepBase & { kind: "removeColumns"; columns: string[] })
  | (PQStepBase & { kind: "renameColumn"; from: string; to: string })
  | (PQStepBase & { kind: "changeType"; column: string; to: ColType; errors?: "keep" | "null" })
  | (PQStepBase & { kind: "removeBlankRows" })
  | (PQStepBase & { kind: "removeDuplicates"; columns: string[] })
  | (PQStepBase & { kind: "filterRows"; column: string; op: PQFilterOp; value?: PQValue })
  | (PQStepBase & { kind: "sortRows"; column: string; direction: "asc" | "desc" })
  | (PQStepBase & { kind: "fillDown"; column: string })
  | (PQStepBase & { kind: "replaceValues"; column: string; find: PQValue; replace: PQValue })
  | (PQStepBase & { kind: "trimText"; column: string })
  | (PQStepBase & { kind: "uppercase"; column: string })
  | (PQStepBase & { kind: "lowercase"; column: string })
  | (PQStepBase & {
      idx: string;
      label: string;
      kind: "splitColumn";
      column: string;
      separator: string;
      names?: string[];
    })
  | (PQStepBase & { kind: "groupBy"; groupBy: string; aggregations: PQAggSpec[] })
  | (PQStepBase & { kind: "addCustomColumn"; name: string; expression: string })
  | (PQStepBase & { kind: "addIndexColumn"; name: string; start: number })
  | (PQStepBase & { kind: "unpivot"; valueColumns: string[]; nameValue: string; nameValueColumn: string })
  | (PQStepBase & { kind: "pivot"; attributeColumn: string; valueColumn: string; aggregation: PQAggFn })
  | (PQStepBase & { kind: "mergeColumns"; columns: string[]; separator: string; name: string })
  | (PQStepBase & { kind: "topN"; column: string | null; n: number; direction: "top" | "bottom" })
  | (PQStepBase & { kind: "keepRange"; column: string; min: number; max: number });

export type PQAggFn =
  "sum" | "avg" | "count" | "countDistinct" | "min" | "max" | "median" | "stddev" | "first" | "last";

export interface PQAggSpec {
  column: string | null; // null => count rows
  fn: PQAggFn;
  as: string;
}

export type PQFilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "notContains"
  | "beginsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty";

export interface PQTable {
  columns: PQColumn[];
  rows: PQRow[];
}

// ---------------------------------------------------------------------------
// Literal expression mini-parser for "Add Custom Column"
// Grammar: numbers, strings, [Column] refs, + - * / %, ( ), comparisons,
// and the functions ABS, ROUND, IF, COALESCE, LENGTH, UPPER, LOWER.
// ---------------------------------------------------------------------------

type Token = { t: "num" | "str" | "col" | "id" | "op"; v: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      tokens.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          out += src[j + 1];
          j += 2;
          continue;
        }
        out += src[j];
        j++;
      }
      if (j >= src.length) throw new PQError(`Unterminated string literal in expression: ${src}`);
      tokens.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    if (c === "[") {
      const close = src.indexOf("]", i);
      if (close < 0) throw new PQError(`Missing ] for column reference in: ${src}`);
      tokens.push({ t: "col", v: src.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      tokens.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>", "!=", "&&", "||"].includes(two)) {
      tokens.push({ t: "op", v: two === "!=" ? "<>" : two });
      i += 2;
      continue;
    }
    if ("+-*/%(),<>".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new PQError(`Unexpected character “${c}” in expression: ${src}`);
  }
  return tokens;
}

export class PQError extends Error {}

interface ExprCtx {
  row: PQRow;
  columns: PQColumn[];
  colIndex: Map<string, number>;
}

/** Recursive-descent evaluator. Throws PQError on malformed input. */
class ExprParser {
  private pos = 0;
  constructor(
    private tokens: Token[],
    private ctx: ExprCtx,
  ) {}

  parse(): PQValue {
    const v = this.orExpr();
    if (this.pos < this.tokens.length) throw new PQError(`Unexpected trailing input in expression`);
    return v;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private orExpr(): PQValue {
    let left = this.andExpr();
    while (this.peek()?.t === "op" && this.peek()!.v === "||") {
      this.pos++;
      const right = this.andExpr();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private andExpr(): PQValue {
    let left = this.cmpExpr();
    while (this.peek()?.t === "op" && this.peek()!.v === "&&") {
      this.pos++;
      const right = this.cmpExpr();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private cmpExpr(): PQValue {
    let left = this.addExpr();
    while (this.peek()?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(this.peek()!.v)) {
      const op = this.peek()!.v;
      this.pos++;
      const right = this.addExpr();
      left = compare(op, left, right);
    }
    return left;
  }

  private addExpr(): PQValue {
    let left = this.mulExpr();
    while (this.peek()?.t === "op" && (this.peek()!.v === "+" || this.peek()!.v === "-")) {
      const op = this.peek()!.v;
      this.pos++;
      const right = this.mulExpr();
      if (op === "+" && (typeof left === "string" || typeof right === "string")) {
        left = `${left ?? ""}${right ?? ""}`;
      } else {
        const a = toNum(left);
        const b = toNum(right);
        // Power Query semantics: null propagates through arithmetic.
        if (a === null || b === null) left = null;
        else left = op === "+" ? a + b : a - b;
      }
    }
    return left;
  }

  private mulExpr(): PQValue {
    let left = this.unary();
    while (this.peek()?.t === "op" && ["*", "/", "%"].includes(this.peek()!.v)) {
      const op = this.peek()!.v;
      this.pos++;
      const right = this.unary();
      const a = toNum(left);
      const b = toNum(right);
      if (a === null || b === null) left = null;
      else left = op === "*" ? a * b : op === "/" ? a / b : a % b;
    }
    return left;
  }

  private unary(): PQValue {
    const tok = this.peek();
    if (tok?.t === "op" && tok.v === "-") {
      this.pos++;
      const v = this.unary();
      const n = toNum(v);
      if (n === null) throw new PQError(`Cannot negate non-numeric value`);
      return -n;
    }
    if (tok?.t === "op" && tok.v === "(") {
      this.pos++;
      const v = this.orExpr();
      if (this.peek()?.t === "op" && this.peek()!.v === ")") this.pos++;
      return v;
    }
    if (tok?.t === "num") {
      this.pos++;
      return Number(tok.v);
    }
    if (tok?.t === "str") {
      this.pos++;
      return tok.v;
    }
    if (tok?.t === "col") {
      this.pos++;
      const idx = this.ctx.colIndex.get(tok.v);
      if (idx === undefined) throw new PQError(`Unknown column [${tok.v}]`);
      return this.ctx.row[idx] ?? null;
    }
    if (tok?.t === "id") {
      this.pos++;
      const name = tok.v.toUpperCase();
      if (name === "TRUE") return true;
      if (name === "FALSE") return false;
      if (name === "NULL") return null;
      if (this.peek()?.t === "op" && this.peek()!.v === "(") {
        this.pos++;
        const args: PQValue[] = [];
        const first = this.peek();
        if (first && !(first.t === "op" && first.v === ")")) {
          args.push(this.orExpr());
          while (this.peek()?.t === "op" && this.peek()!.v === ",") {
            this.pos++;
            args.push(this.orExpr());
          }
        }
        if (this.peek()?.t === "op" && this.peek()!.v === ")") this.pos++;
        return callFn(name, args, this.ctx);
      }
      throw new PQError(`Unknown identifier “${tok.v}”`);
    }
    throw new PQError(`Unexpected end of expression`);
  }
}

function callFn(name: string, args: PQValue[], _ctx: ExprCtx): PQValue {
  switch (name) {
    case "ABS":
      return Math.abs(num1(args));
    case "ROUND": {
      const digits = args.length > 1 ? (toNum(args[1]) ?? 0) : 0;
      const f = Math.pow(10, digits);
      return Math.round((toNum(args[0]) ?? 0) * f) / f;
    }
    case "IF":
      return truthy(args[0] ?? null) ? (args[1] ?? null) : (args[2] ?? null);
    case "COALESCE":
      return args.find((a) => a !== null && a !== undefined) ?? null;
    case "LENGTH":
      return String(args[0] ?? "").length;
    case "UPPER":
      return String(args[0] ?? "").toUpperCase();
    case "LOWER":
      return String(args[0] ?? "").toLowerCase();
    default:
      throw new PQError(`Unknown function ${name}()`);
  }
}

function num1(args: PQValue[]): number {
  const n = toNum(args[0]);
  if (n === null) throw new PQError(`Expected numeric argument`);
  return n;
}

function truthy(v: PQValue): boolean {
  return v === true || (typeof v === "number" && v !== 0) || (typeof v === "string" && v.length > 0);
}

function toNum(v: PQValue | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function compare(op: string, a: PQValue, b: PQValue): boolean {
  if (a === null || b === null) return op === "<>";
  const an = typeof a === "number" ? a : null;
  const bn = typeof b === "number" ? b : null;
  if (an !== null && bn !== null) {
    switch (op) {
      case "=":
        return an === bn;
      case "<>":
        return an !== bn;
      case "<":
        return an < bn;
      case ">":
        return an > bn;
      case "<=":
        return an <= bn;
      case ">=":
        return an >= bn;
    }
  }
  const as = String(a);
  const bs = String(b);
  switch (op) {
    case "=":
      return as === bs;
    case "<>":
      return as !== bs;
    case "<":
      return as < bs;
    case ">":
      return as > bs;
    case "<=":
      return as <= bs;
    case ">=":
      return as >= bs;
  }
  return false;
}

export function evaluateCustomExpression(expr: string, row: PQRow, columns: PQColumn[]): PQValue {
  const colIndex = new Map(columns.map((c, i) => [c.name, i] as const));
  const tokens = tokenize(expr);
  if (tokens.length === 0) throw new PQError(`Empty expression`);
  return new ExprParser(tokens, { row, columns, colIndex }).parse();
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregateValues(values: PQValue[], fn: PQAggFn): PQValue {
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== "");
  switch (fn) {
    case "count":
      return values.length;
    case "countDistinct":
      return new Set(nonNull.map((v) => String(v))).size;
    case "sum":
      return nonNull.reduce<number>((s, v) => s + (toNum(v) ?? 0), 0);
    case "avg": {
      const nums = nonNull.map(toNum).filter((n): n is number => n !== null);
      return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
    }
    case "min": {
      if (!nonNull.length) return null;
      const nums = nonNull.map(toNum).filter((n): n is number => n !== null);
      if (nums.length) return Math.min(...nums);
      return nonNull.reduce((a, b) => (String(a) <= String(b) ? a : b));
    }
    case "max": {
      if (!nonNull.length) return null;
      const nums = nonNull.map(toNum).filter((n): n is number => n !== null);
      if (nums.length) return Math.max(...nums);
      return nonNull.reduce((a, b) => (String(a) >= String(b) ? a : b));
    }
    case "median": {
      const nums = nonNull
        .map(toNum)
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b);
      if (!nums.length) return null;
      const mid = Math.floor(nums.length / 2);
      return nums.length % 2 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2;
    }
    case "stddev": {
      const nums = nonNull.map(toNum).filter((n): n is number => n !== null);
      if (nums.length < 2) return null;
      const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
      const variance = nums.reduce((s, n) => s + (n - mean) ** 2, 0) / (nums.length - 1);
      return Math.sqrt(variance);
    }
    case "first":
      return nonNull[0] ?? null;
    case "last":
      return nonNull[nonNull.length - 1] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Step application
// ---------------------------------------------------------------------------

function coerce(value: PQValue, to: ColType): PQValue {
  if (value === null || value === "") return null;
  switch (to) {
    case "number":
      return toNum(value);
    case "boolean": {
      if (typeof value === "boolean") return value;
      const s = String(value).toLowerCase();
      if (["true", "1", "yes"].includes(s)) return true;
      if (["false", "0", "no"].includes(s)) return false;
      return null;
    }
    case "date": {
      if (typeof value === "string") return value.slice(0, 10);
      return String(value);
    }
    default:
      return String(value);
  }
}

function indexOrThrow(columns: PQColumn[], name: string): number {
  const idx = columns.findIndex((c) => c.name === name);
  if (idx < 0) throw new PQError(`Column “${name}” not found. Available: ${columns.map((c) => c.name).join(", ")}`);
  return idx;
}

/** Apply one step. Pure: returns new table, never mutates the input. */
export function applyStep(table: PQTable, step: PQStep): PQTable {
  const { columns, rows } = table;
  switch (step.kind) {
    case "removeColumns": {
      const drop = new Set(step.columns);
      const keepIdx = columns.map((c, i) => (drop.has(c.name) ? -1 : i)).filter((i) => i >= 0);
      return {
        columns: keepIdx.map((i) => columns[i]!),
        rows: rows.map((r) => keepIdx.map((i) => r[i] ?? null)),
      };
    }
    case "renameColumn": {
      if (!columns.some((c) => c.name === step.from)) throw new PQError(`Column “${step.from}” not found`);
      return {
        columns: columns.map((c) => (c.name === step.from ? { ...c, name: step.to } : c)),
        rows,
      };
    }
    case "changeType": {
      const idx = indexOrThrow(columns, step.column);
      const newCols = columns.map((c, i) => (i === idx ? { ...c, type: step.to } : c));
      const keepErrors = step.errors === "keep";
      return {
        columns: newCols,
        rows: rows.map((r) =>
          r.map((v, i) => {
            if (i !== idx) return v;
            const out = coerce(v, step.to);
            // errors: "keep" preserves the original value when coercion fails.
            return out === null && v !== null && v !== "" && keepErrors ? v : out;
          }),
        ),
      };
    }
    case "removeBlankRows": {
      return {
        columns,
        rows: rows.filter((r) => r.some((v) => v !== null && v !== undefined && v !== "")),
      };
    }
    case "removeDuplicates": {
      const idxs = step.columns.length ? step.columns.map((n) => indexOrThrow(columns, n)) : columns.map((_, i) => i);
      const seen = new Set<string>();
      const out: PQRow[] = [];
      for (const r of rows) {
        const key = idxs.map((i) => String(r[i] ?? "")).join("\u0000");
        if (!seen.has(key)) {
          seen.add(key);
          out.push(r);
        }
      }
      return { columns, rows: out };
    }
    case "filterRows": {
      const idx = indexOrThrow(columns, step.column);
      return {
        columns,
        rows: rows.filter((r) => {
          const v = r[idx] ?? null;
          switch (step.op) {
            case "eq":
              return String(v) === String(step.value);
            case "neq":
              return String(v) !== String(step.value);
            case "gt":
              return compareNum(v, step.value) > 0;
            case "gte":
              return compareNum(v, step.value) >= 0;
            case "lt":
              return compareNum(v, step.value) < 0;
            case "lte":
              return compareNum(v, step.value) <= 0;
            case "contains":
              return String(v ?? "").includes(String(step.value));
            case "notContains":
              return !String(v ?? "").includes(String(step.value));
            case "beginsWith":
              return String(v ?? "").startsWith(String(step.value));
            case "endsWith":
              return String(v ?? "").endsWith(String(step.value));
            case "isEmpty":
              return v === null || v === "" || v === undefined;
            case "isNotEmpty":
              return !(v === null || v === "" || v === undefined);
          }
        }),
      };
    }
    case "sortRows": {
      const idx = indexOrThrow(columns, step.column);
      const sorted = [...rows].sort((a, b) => {
        const av = a[idx],
          bv = b[idx];
        if (av === null) return 1;
        if (bv === null) return -1;
        const an = toNum(av),
          bn = toNum(bv);
        let cmp: number;
        if (an !== null && bn !== null) cmp = an - bn;
        else cmp = String(av).localeCompare(String(bv));
        return step.direction === "asc" ? cmp : -cmp;
      });
      return { columns, rows: sorted };
    }
    case "fillDown": {
      const idx = indexOrThrow(columns, step.column);
      let carry: PQValue = null;
      return {
        columns,
        rows: rows.map((r) => {
          const v = r[idx];
          const out = [...r];
          if (v === null || v === undefined || v === "") {
            out[idx] = carry;
          } else {
            carry = v;
          }
          return out;
        }),
      };
    }
    case "replaceValues": {
      const idx = indexOrThrow(columns, step.column);
      return {
        columns,
        rows: rows.map((r) => {
          const out = [...r];
          if (out[idx] !== null && String(out[idx]) === String(step.find)) out[idx] = step.replace;
          return out;
        }),
      };
    }
    case "trimText": {
      const idx = indexOrThrow(columns, step.column);
      return {
        columns,
        rows: rows.map((r) => {
          const o = [...r];
          if (typeof o[idx] === "string") o[idx] = (o[idx] as string).trim();
          return o;
        }),
      };
    }
    case "uppercase": {
      const idx = indexOrThrow(columns, step.column);
      return {
        columns,
        rows: rows.map((r) => {
          const o = [...r];
          if (typeof o[idx] === "string") o[idx] = (o[idx] as string).toUpperCase();
          return o;
        }),
      };
    }
    case "lowercase": {
      const idx = indexOrThrow(columns, step.column);
      return {
        columns,
        rows: rows.map((r) => {
          const o = [...r];
          if (typeof o[idx] === "string") o[idx] = (o[idx] as string).toLowerCase();
          return o;
        }),
      };
    }
    case "splitColumn": {
      const idx = indexOrThrow(columns, step.column);
      const src = columns[idx]!;
      const names = step.names ?? [1, 2].map((n) => `${src.name}.${n}`);
      const outCols: PQColumn[] = [...columns];
      outCols.splice(
        idx + 1,
        0,
        ...names.map((n) => ({ name: n, type: "string" as ColType, origin: "derived" as const })),
      );
      return {
        columns: outCols,
        rows: rows.map((r) => {
          const parts = String(r[idx] ?? "").split(step.separator);
          const o = [...r];
          o.splice(idx + 1, 0, ...names.map((_, i) => parts[i] ?? null));
          return o;
        }),
      };
    }
    case "groupBy": {
      const gIdx = indexOrThrow(columns, step.groupBy);
      const aggIdxs = step.aggregations.map((a) => (a.column ? indexOrThrow(columns, a.column) : -1));
      const groups = new Map<string, { key: PQValue; rows: PQRow[] }>();
      for (const r of rows) {
        const key = String(r[gIdx] ?? "");
        let g = groups.get(key);
        if (!g) {
          g = { key: r[gIdx] ?? null, rows: [] };
          groups.set(key, g);
        }
        g.rows.push(r);
      }
      const outCols: PQColumn[] = [
        { name: columns[gIdx]!.name, type: columns[gIdx]!.type, origin: "source" },
        ...step.aggregations.map((a) => ({
          name: a.as,
          type: (["sum", "avg", "min", "max", "median", "stddev", "count", "countDistinct"].includes(a.fn)
            ? "number"
            : "string") as ColType,
          origin: "derived" as const,
        })),
      ];
      const outRows: PQRow[] = [...groups.values()].map((g) => [
        g.key,
        ...step.aggregations.map((a, ai) =>
          aggregateValues(
            g.rows.map((r) => (a.column && aggIdxs[ai]! >= 0 ? (r[aggIdxs[ai]!] ?? null) : null)),
            a.fn,
          ),
        ),
      ]);
      return { columns: outCols, rows: outRows };
    }
    case "addCustomColumn": {
      const out: PQColumn[] = [...columns, { name: step.name, type: "number" as ColType, origin: "derived" }];
      return {
        columns: out,
        rows: rows.map((r) => [...r, evaluateCustomExpression(step.expression, r, columns)]),
      };
    }
    case "addIndexColumn": {
      return {
        columns: [...columns, { name: step.name, type: "number" as ColType, origin: "derived" }],
        rows: rows.map((r, i) => [...r, step.start + i]),
      };
    }
    case "mergeColumns": {
      const idxs = step.columns.map((n) => indexOrThrow(columns, n));
      return {
        columns: [...columns, { name: step.name, type: "string" as ColType, origin: "derived" }],
        rows: rows.map((r) => [...r, idxs.map((i) => (r[i] === null ? "" : String(r[i]))).join(step.separator)]),
      };
    }
    case "topN": {
      if (!step.column) {
        return { columns, rows: step.direction === "top" ? rows.slice(0, step.n) : rows.slice(-step.n) };
      }
      const idx = indexOrThrow(columns, step.column);
      const sorted = [...rows].sort((a, b) => {
        const an = toNum(a[idx]) ?? 0;
        const bn = toNum(b[idx]) ?? 0;
        return step.direction === "top" ? bn - an : an - bn;
      });
      return { columns, rows: sorted.slice(0, step.n) };
    }
    case "keepRange": {
      const idx = indexOrThrow(columns, step.column);
      return {
        columns,
        rows: rows.filter((r) => {
          const n = toNum(r[idx]);
          return n !== null && n >= step.min && n <= step.max;
        }),
      };
    }
    case "unpivot": {
      const valueIdxs = step.valueColumns.map((n) => indexOrThrow(columns, n));
      const keepIdxs = columns.map((_, i) => i).filter((i) => !valueIdxs.includes(i));
      const outCols: PQColumn[] = [
        ...keepIdxs.map((i) => columns[i]!),
        { name: step.nameValue, type: "string" as ColType, origin: "derived" as const },
        { name: step.nameValueColumn, type: "number" as ColType, origin: "derived" as const },
      ];
      const outRows: PQRow[] = [];
      for (const r of rows) {
        for (const vi of valueIdxs) {
          outRows.push([...keepIdxs.map((i) => r[i] ?? null), columns[vi]!.name, toNum(r[vi])]);
        }
      }
      return { columns: outCols, rows: outRows };
    }
    case "pivot": {
      const attrIdx = indexOrThrow(columns, step.attributeColumn);
      const valIdx = indexOrThrow(columns, step.valueColumn);
      const keepIdxs = columns.map((_, i) => i).filter((i) => i !== attrIdx && i !== valIdx);
      const attrValues: PQValue[] = [];
      for (const r of rows) {
        const k = String(r[attrIdx] ?? "");
        if (!attrValues.some((v) => String(v) === k)) attrValues.push(r[attrIdx] ?? null);
      }
      const groups = new Map<string, PQRow[]>();
      for (const r of rows) {
        const key = keepIdxs.map((i) => String(r[i] ?? "")).join("\u0000");
        let g = groups.get(key);
        if (!g) {
          g = [];
          groups.set(key, g);
        }
        g.push(r);
      }
      const outCols: PQColumn[] = [
        ...keepIdxs.map((i) => columns[i]!),
        ...attrValues.map((a) => ({ name: String(a), type: "number" as ColType, origin: "derived" as const })),
      ];
      const outRows: PQRow[] = [...groups.entries()].map(([key, grp]) => {
        const base = key.split("\u0000").map((s) => (s === "" ? null : s));
        const cells = attrValues.map((a) => {
          const matching = grp.filter((r) => String(r[attrIdx]) === String(a));
          return aggregateValues(
            matching.map((r) => r[valIdx] ?? null),
            step.aggregation,
          );
        });
        return [...base, ...cells];
      });
      return { columns: outCols, rows: outRows };
    }
    default:
      throw new PQError(`Unsupported step kind`);
  }
}

/** Numeric comparator for filter ops; non-numerics fall back to string compare. */
function compareNum(a: PQValue, b: PQValue | undefined): number {
  const an = toNum(a);
  const bn = b === undefined || b === null ? null : toNum(b);
  if (an === null || bn === null) return String(a ?? "").localeCompare(String(b ?? ""));
  return an === bn ? 0 : an < bn ? -1 : 1;
}

export function applySteps(table: PQTable, steps: PQStep[]): PQTable {
  let current = table;
  for (const step of steps) {
    current = applyStep(current, step);
  }
  return current;
}

/** Human-readable description for the Applied Steps bar / audit trail. */
export function describeStep(step: PQStep): string {
  switch (step.kind) {
    case "removeColumns":
      return `Removed columns ${step.columns.join(", ")}`;
    case "renameColumn":
      return `Renamed “${step.from}” to “${step.to}”`;
    case "changeType":
      return `Changed type of “${step.column}” to ${step.to}`;
    case "removeBlankRows":
      return `Removed blank rows`;
    case "removeDuplicates":
      return `Removed duplicates on ${step.columns.join(", ") || "all columns"}`;
    case "filterRows":
      return `Filtered rows where ${step.column} ${step.op} ${step.value ?? ""}`.trim();
    case "sortRows":
      return `Sorted by ${step.column} ${step.direction === "asc" ? "ascending" : "descending"}`;
    case "fillDown":
      return `Filled down “${step.column}”`;
    case "replaceValues":
      return `Replaced ${JSON.stringify(step.find)} with ${JSON.stringify(step.replace)} in “${step.column}”`;
    case "trimText":
      return `Trimmed “${step.column}”`;
    case "uppercase":
      return `Uppercased “${step.column}”`;
    case "lowercase":
      return `Lowercased “${step.column}”`;
    case "splitColumn":
      return `Split “${step.column}” by “${step.separator}”`;
    case "groupBy":
      return `Grouped by “${step.groupBy}” with ${step.aggregations.map((a) => `${a.fn}(${a.column ?? "rows"}) as ${a.as}`).join(", ")}`;
    case "addCustomColumn":
      return `Added custom column “${step.name}” = ${step.expression}`;
    case "addIndexColumn":
      return `Added index column “${step.name}”`;
    case "unpivot":
      return `Unpivoted ${step.valueColumns.length} value columns`;
    case "pivot":
      return `Pivoted “${step.attributeColumn}” with ${step.aggregation}(${step.valueColumn})`;
    case "mergeColumns":
      return `Merged ${step.columns.join(" + ")} into “${step.name}”`;
    case "topN":
      return `Kept ${step.direction} ${step.n} rows${step.column ? ` by ${step.column}` : ""}`;
    case "keepRange":
      return `Kept rows where ${step.column} between ${step.min} and ${step.max}`;
  }
}
