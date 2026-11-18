/**
 * DAX-style measure engine (single-table model).
 *
 * Implements a real subset of DAX with filter-context semantics — every value
 * is computed from the actual dataset rows, never simulated:
 *  - Aggregations: SUM, AVERAGE, MIN, MAX, COUNT, COUNTROWS, DISTINCTCOUNT
 *  - Iterators:    SUMX, AVERAGEX, MINX, MAXX, COUNTX, RANKX
 *  - Filter:       CALCULATE (incl. context transition), FILTER, ALL,
 *                  ALLEXCEPT, VALUES, SELECTEDVALUE, HASONEVALUE
 *  - Variables:    VAR name = expr … RETURN expr (eager, per-context)
 *  - Tables:       CALCULATETABLE, TOPN (tie-inclusive), TREATAS (as a
 *                  CALCULATE filter), the IN { … } operator
 *  - Time intel:   TOTALYTD/TOTALQTD/TOTALMTD, DATESYTD/QTD/MTD,
 *                  SAMEPERIODLASTYEAR, DATEADD, PARALLELPERIOD,
 *                  PREVIOUSMONTH/QUARTER/YEAR, NEXTDAY/MONTH/QUARTER/YEAR,
 *                  DATESBETWEEN, DATESINPERIOD
 *  - Logic/maths:  IF, SWITCH, AND, OR, NOT, XOR, COALESCE, DIVIDE, ABS,
 *                  ROUND, ROUNDUP, ROUNDDOWN, INT, MOD, SIGN, FLOOR,
 *                  CEILING, SQRT, POWER, EXP, LN, LOG, BLANK
 *  - Text:         LEN, LEFT, RIGHT, MID, UPPER, LOWER, TRIM, CONCATENATE,
 *                  CONCATENATEX, SUBSTITUTE, CONTAINSSTRING
 *  - Stats:        MEDIAN, PRODUCT, COUNTBLANK, STDEV.P, STDEV.S, VAR.P, VAR.S
 *  - Lookup/info:  LOOKUPVALUE, ISNUMBER, ISTEXT, ISLOGICAL
 *
 * Dates must be ISO "YYYY-MM-DD" strings for the time-intelligence family;
 * lexicographic order then equals chronological order.
 *
 * This is a subset of DAX, not the whole language — anything unsupported
 * raises a DaxError naming the problem (no silent wrong answers).
 */
import type { SqlValue } from "@/lib/types";

export type DaxValue = SqlValue;

export interface DaxModel {
  columns: string[];
  rows: DaxValue[][];
  /**
   * Multi-table materialization support. When a star model has been flattened
   * into one row set, dimension columns are exposed under qualified names like
   * "DimCustomer.Segment". `colAliases` maps an unambiguous PLAIN dimension
   * column name to its qualified form so unqualified `[Segment]` still works;
   * a name that collides with a fact column (or two dimensions) is omitted and
   * MUST be written table-qualified — exactly like DAX.
   */
  colAliases?: Record<string, string>;
  /**
   * Continuous date calendar (auto date dimension). Time-intelligence functions
   * that scan the full period use `calendar.dates` instead of only the dates a
   * sparse fact happens to contain, so SAMEPERIODLASTYEAR / PREVIOUS* / NEXT*
   * see the true prior periods (ROADMAP 2.4).
   */
  calendar?: { dateColumn: string; dates: string[] };
}

export class DaxError extends Error {}

/** Filter for one column: null means "no filter (ALL)". */
export interface DaxFilter {
  column: string;
  values: string[] | null;
}

type FilterCtx = Map<string, Set<string> | null>;

interface RowCtx {
  rowIdx: number;
  /** When iterating a single-column table, only these columns transition. */
  transitionColumns?: string[] | null;
}

interface DateSet {
  kind: "dateset";
  column: string;
  dates: string[];
}

interface TableVal {
  kind: "table";
  /** When non-null this is a single-column table over that column. */
  column: string | null;
  rowIdx: number[];
  /** Inline list table ({1,2,3}) — values not backed by model rows. */
  literal?: DaxValue[];
}

type Expr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "col"; name: string; table?: string }
  | { k: "list"; items: Expr[] }
  | { k: "idref"; name: string }
  | { k: "in"; e: Expr; list: Expr[] }
  | { k: "var"; decls: { name: string; expr: Expr }[]; body: Expr }
  | { k: "func"; name: string; args: Expr[] }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "un"; op: string; e: Expr };

/** VAR/RETURN variable scope (keys lower-cased — DAX identifiers are case-insensitive). */
type Vars = Map<string, DaxValue>;
const NO_VARS: Vars = new Map();

// ---------------------------------------------------------------------------
// Tokenizer + parser
// ---------------------------------------------------------------------------

type Tok = { t: "num" | "str" | "col" | "id" | "op"; v: string; table?: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9.eE]/.test(src[j]!)) {
        // stop scientific notation unless well-formed
        if ((src[j] === "e" || src[j] === "E") && !/[0-9+-]/.test(src[j + 1] ?? "")) break;
        if ((src[j] === "e" || src[j] === "E") && /[+-]/.test(src[j + 1] ?? "")) j++;
        j++;
      }
      out.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '"' && src[j + 1] === '"') {
          s += '"';
          j += 2;
          continue;
        } // DAX escaped quote
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new DaxError(`Unterminated string in: ${src}`);
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      // 'Table'[Column] — keep the table name so multi-table models can
      // resolve the reference against the right table (single-table models
      // still accept and ignore it, for DAX source compatibility).
      const close = src.indexOf("'", i + 1);
      if (close < 0) throw new DaxError(`Unterminated table name in: ${src}`);
      const table = src.slice(i + 1, close).trim();
      i = close + 1;
      if (src[i] === "[") {
        const end = src.indexOf("]", i);
        if (end < 0) throw new DaxError(`Missing ] after column reference in: ${src}`);
        out.push({ t: "col", v: src.slice(i + 1, end), table });
        i = end + 1;
      } else if (table.length > 0) {
        // Bare table name ('Orders' as a table expression) — future work;
        // surface an honest parse error rather than a wrong value.
        throw new DaxError(`Table references like '${table}' need a column: write '${table}'[Column].`);
      }
      continue;
    }
    if (c === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) throw new DaxError(`Missing ] after column reference in: ${src}`);
      out.push({ t: "col", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>", "&&", "||"].includes(two)) {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/&()=<>,{}".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new DaxError(`Unexpected character “${c}” in: ${src}`);
  }
  return out;
}

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  parseExpr(): Expr {
    const e = this.expr();
    if (this.pos < this.toks.length)
      throw new DaxError(`Unexpected trailing input near token ${this.toks[this.pos]?.v}`);
    return e;
  }

  /** Expression body without the trailing-input check (VAR bodies recurse here). */
  private expr(): Expr {
    // A leading RETURN without VAR declarations is accepted so malformed
    // measures surface a useful evaluation error instead of a parse error.
    if (this.peek()?.t === "id" && this.peek()!.v.toUpperCase() === "RETURN") this.pos++;
    if (this.peek()?.t === "id" && this.peek()!.v.toUpperCase() === "VAR") return this.varExpr();
    let e = this.or();
    if (this.peek()?.t === "id" && this.peek()!.v.toUpperCase() === "IN") {
      this.pos++;
      e = { k: "in", e, list: this.listLiteral() };
    }
    return e;
  }

  private listLiteral(): Expr[] {
    if (!this.isOp("{")) throw new DaxError(`Expected { … } after IN.`);
    this.pos++;
    const list: Expr[] = [];
    while (!this.isOp("}")) {
      list.push(this.or());
      if (this.isOp(",")) {
        this.pos++;
        continue;
      }
      break;
    }
    if (!this.isOp("}")) throw new DaxError(`Missing closing } in IN list.`);
    this.pos++;
    return list;
  }

  /** Inline list { a, b, c } — a single-column literal table (TREATAS source). */
  private inlineList(): Expr {
    this.pos++; // consume {
    const items: Expr[] = [];
    while (!this.isOp("}")) {
      items.push(this.or());
      if (this.isOp(",")) {
        this.pos++;
        continue;
      }
      break;
    }
    if (!this.isOp("}")) throw new DaxError(`Missing closing } in list.`);
    this.pos++;
    return { k: "list", items };
  }

  /** VAR name = expr [, VAR name2 = expr2]… RETURN body */
  private varExpr(): Expr {
    this.pos++; // consume VAR
    const decls: { name: string; expr: Expr }[] = [];
    for (;;) {
      const nameTok = this.peek();
      if (!nameTok || nameTok.t !== "id") throw new DaxError(`Expected a variable name after VAR.`);
      if (["RETURN", "VAR"].includes(nameTok.v.toUpperCase()))
        throw new DaxError(`Expected a variable name after VAR, got “${nameTok.v}”.`);
      this.pos++;
      if (!this.isOp("=")) throw new DaxError(`Expected = after VAR ${nameTok.v}.`);
      this.pos++;
      decls.push({ name: nameTok.v, expr: this.expr() });
      const next = this.peek();
      if (next?.t === "id" && next.v.toUpperCase() === "VAR") {
        this.pos++;
        continue;
      }
      break;
    }
    const ret = this.peek();
    if (!ret || ret.t !== "id" || ret.v.toUpperCase() !== "RETURN")
      throw new DaxError(`Expected RETURN after VAR declaration(s).`);
    this.pos++;
    return { k: "var", decls, body: this.expr() };
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private isOp(v: string): boolean {
    return this.peek()?.t === "op" && this.peek()!.v === v;
  }

  private or(): Expr {
    let l = this.and();
    while (this.isOp("||")) {
      this.pos++;
      l = { k: "bin", op: "||", l, r: this.and() };
    }
    return l;
  }

  private and(): Expr {
    let l = this.not();
    while (this.isOp("&&")) {
      this.pos++;
      l = { k: "bin", op: "&&", l, r: this.not() };
    }
    return l;
  }

  private not(): Expr {
    if (this.peek()?.t === "id" && this.peek()!.v.toUpperCase() === "NOT") {
      this.pos++;
      return { k: "un", op: "!", e: this.not() };
    }
    return this.cmp();
  }

  private cmp(): Expr {
    let l = this.concat();
    while (this.peek()?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(this.peek()!.v)) {
      const op = this.peek()!.v;
      this.pos++;
      l = { k: "bin", op, l, r: this.concat() };
    }
    return l;
  }

  private concat(): Expr {
    let l = this.add();
    while (this.isOp("&")) {
      this.pos++;
      l = { k: "bin", op: "&", l, r: this.add() };
    }
    return l;
  }

  private add(): Expr {
    let l = this.mul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.peek()!.v;
      this.pos++;
      l = { k: "bin", op, l, r: this.mul() };
    }
    return l;
  }

  private mul(): Expr {
    let l = this.unary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = this.peek()!.v;
      this.pos++;
      l = { k: "bin", op, l, r: this.unary() };
    }
    return l;
  }

  private unary(): Expr {
    if (this.isOp("-")) {
      this.pos++;
      return { k: "un", op: "-", e: this.unary() };
    }
    return this.atom();
  }

  private atom(): Expr {
    const tok = this.peek();
    if (!tok) throw new DaxError(`Unexpected end of expression`);
    if (tok.t === "num") {
      this.pos++;
      return { k: "num", v: Number(tok.v) };
    }
    if (tok.t === "str") {
      this.pos++;
      return { k: "str", v: tok.v };
    }
    if (tok.t === "col") {
      this.pos++;
      return { k: "col", name: tok.v, table: tok.table };
    }
    if (tok.t === "id") {
      this.pos++;
      const upper = tok.v.toUpperCase();
      if (upper === "TRUE" || upper === "FALSE") {
        // Accept the DAX-style no-arg call syntax TRUE() / FALSE().
        if (this.isOp("(")) {
          this.pos++;
          if (!this.isOp(")")) throw new DaxError(`${upper}() takes no arguments.`);
          this.pos++;
        }
        return { k: "bool", v: upper === "TRUE" };
      }
      if (this.isOp("(")) {
        this.pos++;
        // DAX allows empty argument slots, e.g. RANKX(t, e, , ASC) — the
        // blank arg is meaningful ("use the outer value"). Parse args with
        // optional slots and normalise blank slots to a NULL literal.
        const args: Expr[] = [];
        if (!this.isOp(")")) {
          for (;;) {
            if (this.isOp(",")) {
              args.push({ k: "str", v: "" });
              continue;
            }
            if (this.isOp(")")) break;

            args.push(this.expr());
            if (this.isOp(",")) {
              this.pos++;
              continue;
            }
            break;
          }
        }
        if (!this.isOp(")")) throw new DaxError(`Missing ) after ${tok.v}(…`);
        this.pos++;
        return { k: "func", name: upper, args };
      }
      // Interval-unit keywords (DATESINPERIOD(…, MONTH), TOPN order, …) are
      // bare identifiers in DAX — treat them as their own name string.
      const upperUnit = tok.v.toUpperCase();
      if (["YEAR", "QUARTER", "MONTH", "DAY", "WEEK"].includes(upperUnit)) {
        return { k: "str", v: upperUnit };
      }
      // Bare identifier: a VAR reference. Evaluated from the variable scope;
      // unknown names raise a clear DaxError at evaluation time.
      return { k: "idref", name: tok.v };
    }
    if (tok.t === "op" && tok.v === "(") {
      this.pos++;
      // Full expr() — parenthesized VAR/RETURN blocks are legal in DAX.
      const e = this.expr();
      if (!this.isOp(")")) throw new DaxError(`Missing closing )`);
      this.pos++;
      return e;
    }
    if (tok.t === "op" && tok.v === "{") return this.inlineList();
    throw new DaxError(`Unexpected token “${tok.v}”`);
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function isBlank(v: DaxValue): boolean {
  return v === null || v === undefined || v === "";
}

function numOf(v: DaxValue, ctx: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  throw new DaxError(`${ctx}: expected a number, got ${JSON.stringify(v)}`);
}

function daxEquals(a: DaxValue, b: DaxValue): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b);
  // numeric strings compare numerically ("10" = 10 → TRUE, like DAX coercion)
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && String(a).trim() !== "" && String(b).trim() !== "") return an === bn;
  return String(a) === String(b);
}

class Evaluator {
  readonly colIndex: Map<string, number>;
  /** Stack of VAR scopes — evaluation is synchronous DFS, so the top of the
   * stack is always the lexically-enclosing scope. */
  private varStack: Vars[] = [];

  constructor(readonly model: DaxModel) {
    this.colIndex = new Map(model.columns.map((c, i) => [c, i] as const));
  }

  /** Resolve an unqualified column name through the model's alias map. */
  private resolvePlain(name: string): string {
    return this.model.colAliases?.[name] ?? name;
  }

  /** Resolve a column name to its index (throws with available columns). */
  colIdxOrThrow(name: string): number {
    const resolved = this.resolvePlain(name);
    const idx = this.colIndex.get(resolved);
    if (idx === undefined)
      throw new DaxError(`Column “[${name}]” not found. Available: ${this.model.columns.join(", ")}`);
    return idx;
  }

  /** Rows visible under the filter context. */
  private visibleRows(fc: FilterCtx): number[] {
    const active = [...fc.entries()].filter(([, set]) => set !== null);
    if (active.length === 0) return this.model.rows.map((_, i) => i);
    const checks = active.map(([col, set]) => {
      const idx = this.colIdxOrThrow(col);
      const allowed = set as Set<string>;
      // BLANK (null / "") normalizes to "" so a filter value of "" — the
      // category key used for blank cells, e.g. Power BI's "(Blank)" slicer
      // entry on orphan star rows — matches them.
      return (row: DaxValue[]) => {
        const v = row[idx] ?? null;
        return allowed.has(isBlank(v) ? "" : String(v));
      };
    });
    const out: number[] = [];
    outer: for (let i = 0; i < this.model.rows.length; i++) {
      for (const check of checks) if (!check(this.model.rows[i]!)) continue outer;
      out.push(i);
    }
    return out;
  }

  private cell(rowIdx: number, colName: string): DaxValue {
    const idx = this.colIdxOrThrow(colName);
    return this.model.rows[rowIdx]![idx] ?? null;
  }

  private withContextTransition(fc: FilterCtx, rc: RowCtx): FilterCtx {
    // DAX context transition: the row context becomes filters. When iterating
    // a single-column table (VALUES/ALL(col)), only that column transitions —
    // matching DAX semantics for one-column row contexts.
    const out: FilterCtx = new Map(fc);
    const cols = rc.transitionColumns ?? this.model.columns;
    for (const col of cols) {
      const v = this.cell(rc.rowIdx, col);
      out.set(col, isBlank(v) ? new Set() : new Set([String(v)]));
    }
    return out;
  }

  eval(expr: Expr, fc: FilterCtx, rc: RowCtx | null): DaxValue {
    switch (expr.k) {
      case "num":
        return expr.v;
      case "str":
        return expr.v;
      case "bool":
        return expr.v;
      case "col": {
        if (!rc) {
          // Column in a filter-only context: valid only via SELECTEDVALUE etc.
          throw new DaxError(
            `Column “[${expr.name}]” cannot be used here without a row context (wrap it in CALCULATE, an iterator, or SELECTEDVALUE).`,
          );
        }
        return this.cell(rc.rowIdx, expectColumnRef(expr));
      }
      case "un": {
        if (expr.op === "-") return -numOf(this.eval(expr.e, fc, rc), "Unary minus");
        const v = this.eval(expr.e, fc, rc);
        return !(v === true || (typeof v === "number" && v !== 0));
      }
      case "list":
        throw new DaxError(
          `A table value ({ … }) cannot be used as a scalar — use it inside TREATAS, COUNTROWS or IN.`,
        );
      case "idref": {
        const v = this.varStack[this.varStack.length - 1] ?? NO_VARS;
        const val = v.get(expr.name.toLowerCase());
        if (val === undefined) {
          throw new DaxError(
            `Unknown identifier “${expr.name}” — functions need parentheses and VAR names must be declared before RETURN.`,
          );
        }
        return val;
      }
      case "in": {
        const v = this.eval(expr.e, fc, rc);
        for (const item of expr.list) {
          if (daxEquals(v, this.eval(item, fc, rc))) return true;
        }
        return false;
      }
      case "var": {
        // Push the scope BEFORE evaluating declarations so later variables can
        // reference earlier ones (DAX sequential-evaluation semantics).
        const scope: Vars = new Map(this.varStack[this.varStack.length - 1] ?? NO_VARS);
        this.varStack.push(scope);
        try {
          for (const d of expr.decls) scope.set(d.name.toLowerCase(), this.eval(d.expr, fc, rc));
          return this.eval(expr.body, fc, rc);
        } finally {
          this.varStack.pop();
        }
      }
      case "bin":
        return this.evalBinary(expr, fc, rc);
      case "func":
        return this.evalFunc(expr, fc, rc);
    }
  }

  private evalBinary(expr: Extract<Expr, { k: "bin" }>, fc: FilterCtx, rc: RowCtx | null): DaxValue {
    const { op, l, r } = expr;
    if (op === "&&") return truthy(this.eval(l, fc, rc)) && truthy(this.eval(r, fc, rc));
    if (op === "||") return truthy(this.eval(l, fc, rc)) || truthy(this.eval(r, fc, rc));
    const a = this.eval(l, fc, rc);
    const b = this.eval(r, fc, rc);
    switch (op) {
      case "=":
        return daxEquals(a, b);
      case "<>":
        return !daxEquals(a, b);
      case "<":
      case ">":
      case "<=":
      case ">=": {
        if (isBlank(a) || isBlank(b)) return false;
        const an = typeof a === "number" ? a : Number(a);
        const bn = typeof b === "number" ? b : Number(b);
        if (!Number.isNaN(an) && !Number.isNaN(bn) && String(a).trim() !== "" && String(b).trim() !== "") {
          if (op === "<") return an < bn;
          if (op === ">") return an > bn;
          if (op === "<=") return an <= bn;
          return an >= bn;
        }
        const as = String(a);
        const bs = String(b);
        if (op === "<") return as < bs;
        if (op === ">") return as > bs;
        if (op === "<=") return as <= bs;
        return as >= bs;
      }
      case "&":
        return `${a ?? ""}${b ?? ""}`;
      case "+":
        return numOf(a, "+") + numOf(b, "+");
      case "-":
        return numOf(a, "-") - numOf(b, "-");
      case "*":
        return numOf(a, "*") * numOf(b, "*");
      case "/": {
        const d = numOf(b, "/");
        if (d === 0)
          throw new DaxError("Division by zero — use DIVIDE(numerator, denominator [, alternate]) for a safe result.");
        return numOf(a, "/") / d;
      }
    }
    throw new DaxError(`Unsupported operator ${op}`);
  }

  /**
   * Evaluate a GROUPBY extension column marked with CURRENTGROUP() (real DAX
   * semantics, replacing the old scalar-0 placeholder).
   *
   * DAX requires CURRENTGROUP() to be the table argument of an aggregator
   * (SUMX(CURRENTGROUP(), [Amount]), COUNTX(CURRENTGROUP(), 1), AVERAGEX…).
   * Semantics here: evaluate the wrapper as an ITERATOR whose table is the
   * group's own rows — i.e. run the inner expression once per row of the
   * group and aggregate. A bare (unwrapped) CURRENTGROUP() is an error, per
   * the DAX spec.
   */
  private evalCurrentGroupExpr(expr: Expr, fc: FilterCtx, groupRowIdx: number[]): DaxValue {
    const cg = expr.k === "func" && expr.args.length >= 1 ? expr.args[0]! : null;
    const isCgTable = cg !== null && cg.k === "func" && cg.name === "CURRENTGROUP" && cg.args.length === 0;
    if (expr.k !== "func" || !isCgTable) {
      throw new DaxError(
        'GROUPBY extension columns must use CURRENTGROUP() as the table argument of an aggregator, e.g. "Total", SUMX(CURRENTGROUP(), [Amount]).',
      );
    }
    const wrapper = expr.name.toUpperCase();
    const inner = expr.args[1]!;
    if (!inner) {
      throw new DaxError(`${expr.name}: an aggregation over CURRENTGROUP() needs an expression argument.`);
    }
    const values: DaxValue[] = [];
    for (const rowIdx of groupRowIdx) {
      const v = this.eval(inner, fc, { rowIdx, transitionColumns: null });
      if (!isBlank(v)) values.push(v);
    }
    switch (wrapper) {
      case "SUMX":
        return values.reduce<number>((s, v) => s + numOf(v, wrapper), 0);
      case "AVERAGEX":
        return values.length ? values.reduce<number>((s, v) => s + numOf(v, wrapper), 0) / values.length : null;
      case "MINX":
        return values.length ? Math.min(...values.map((v) => numOf(v, wrapper))) : null;
      case "MAXX":
        return values.length ? Math.max(...values.map((v) => numOf(v, wrapper))) : null;
      case "COUNTX":
        return values.length;
      default:
        throw new DaxError(
          `${expr.name} is not supported over CURRENTGROUP() — use SUMX, AVERAGEX, MINX, MAXX or COUNTX.`,
        );
    }
  }

  // -- table expressions ----------------------------------------------------

  private evalTable(expr: Expr, fc: FilterCtx, rc: RowCtx | null): TableVal {
    switch (expr.k) {
      case "func": {
        switch (expr.name) {
          case "ALL": {
            if (expr.args.length === 0)
              return { kind: "table", column: null, rowIdx: this.model.rows.map((_, i) => i) };
            const col = expectColumnRef(expr.args[0]!);
            const idx = this.colIdxOrThrow(col);
            // ALL(col) returns the distinct (non-blank) values of the column.
            const seen = new Set<string>();
            const rows: number[] = [];
            for (let i = 0; i < this.model.rows.length; i++) {
              const v = this.model.rows[i]![idx] ?? null;
              if (isBlank(v)) continue;
              const key = String(v);
              if (!seen.has(key)) {
                seen.add(key);
                rows.push(i);
              }
            }
            return { kind: "table", column: col, rowIdx: rows };
          }
          case "VALUES": {
            const col = expectColumnRef(expr.args[0]!);
            const idx = this.colIdxOrThrow(col);
            const seen = new Set<string>();
            const rows: number[] = [];
            for (const i of this.visibleRows(fc)) {
              const v = this.model.rows[i]![idx] ?? null;
              const key = isBlank(v) ? "" : String(v);
              if (!seen.has(key)) {
                seen.add(key);
                rows.push(i);
              }
            }
            return { kind: "table", column: col, rowIdx: rows };
          }
          case "FILTER": {
            const base = this.evalTable(expr.args[0]!, fc, rc);
            const kept: number[] = [];
            for (const rowIdx of base.rowIdx) {
              const rowCtx: RowCtx = { rowIdx, transitionColumns: base.column ? [base.column] : null };
              const keep = truthy(this.eval(expr.args[1]!, fc, rowCtx));
              if (keep) kept.push(rowIdx);
            }
            return { kind: "table", column: base.column, rowIdx: kept };
          }
          case "DATESYTD":
          case "DATESQTD":
          case "DATESMTD":
          case "NEXTDAY":
          case "NEXTMONTH":
          case "NEXTQUARTER":
          case "NEXTYEAR":
          case "DATESBETWEEN":
          case "DATESINPERIOD":
          case "FIRSTDATE":
          case "LASTDATE":
          case "STARTOFMONTH":
          case "STARTOFQUARTER":
          case "STARTOFYEAR":
          case "ENDOFMONTH":
          case "ENDOFQUARTER":
          case "ENDOFYEAR": {
            const ds = this.timeIntelSet(expr.name, expr.args, fc);
            const idx = this.colIdxOrThrow(ds.column);
            const rows: number[] = [];
            const want = new Set(ds.dates);
            for (let i = 0; i < this.model.rows.length; i++) {
              const v = this.model.rows[i]![idx] ?? null;
              if (typeof v === "string" && want.has(v)) rows.push(i);
            }
            return { kind: "table", column: ds.column, rowIdx: rows };
          }
          case "CALCULATETABLE": {
            // CALCULATETABLE(T, f1, …) evaluates T in the modified filter
            // context: each filter argument is applied to a copy of the
            // incoming context, then the table expression sees it.
            const [tableExpr, ...filterArgs] = expr.args;
            const inner: FilterCtx = new Map(fc);
            for (const f of filterArgs) this.applyFilterArg(inner, f, fc, rc);
            return this.evalTable(tableExpr!, inner, rc);
          }
          case "TOPN": {
            // TOPN(n, table, orderBy [, isAsc [, orderBy2, isAsc2 …]]) —
            // DAX tie semantics: rows equal to the boundary value are ALL kept.
            const n = Math.trunc(numOf(this.eval(expr.args[0]!, fc, rc), "TOPN n"));
            const base = this.evalTable(expr.args[1]!, fc, rc);
            if (n <= 0 || base.rowIdx.length === 0) return { kind: "table", column: base.column, rowIdx: [] };
            const orderPairs: { expr: Expr; asc: boolean }[] = [];
            for (let i = 2; i < expr.args.length; i += 2) {
              const ascArg = expr.args[i + 1];
              orderPairs.push({
                expr: expr.args[i]!,
                asc: ascArg ? numOf(this.eval(ascArg, fc, rc), "TOPN order") === 1 : false,
              });
            }
            if (orderPairs.length === 0) throw new DaxError("TOPN needs an order-by expression.");
            const compareKeys = (a: string, b: string): number => {
              // Numeric when both sides are numeric ("9" < "10" numerically,
              // but "9" > "10" lexicographically — DAX sorts by value).
              const an = a.trim() !== "" ? Number(a) : NaN;
              const bn = b.trim() !== "" ? Number(b) : NaN;
              if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
              return a < b ? -1 : a > b ? 1 : 0;
            };
            const scored = base.rowIdx.map((rowIdx) => {
              const rowCtx: RowCtx = { rowIdx, transitionColumns: base.column ? [base.column] : null };
              const key = orderPairs.map((p) => {
                const v = this.eval(p.expr, fc, rowCtx);
                return isBlank(v) ? "" : String(v);
              });
              return { rowIdx, key };
            });
            scored.sort((a, b) => {
              for (let i = 0; i < orderPairs.length; i++) {
                const asc = orderPairs[i]!.asc;
                const cmp = compareKeys(a.key[i]!, b.key[i]!);
                if (cmp !== 0) return asc ? cmp : -cmp;
              }
              return 0;
            });
            const kept = scored.slice(0, n);
            // Tie-inclusive (DAX): rows beyond n that tie the boundary value
            // are kept too — the union of the first n rows and their ties.
            const boundary = kept[kept.length - 1]!.key;
            const rows: number[] = [];
            for (let i = 0; i < scored.length; i++) {
              if (i < n || scored[i]!.key.every((k, j) => compareKeys(k, boundary[j]!) === 0)) {
                rows.push(scored[i]!.rowIdx);
              }
            }
            return { kind: "table", column: base.column, rowIdx: rows };
          }
          // -- SUMMARIZE ---------------------------------------------------------
          case "SUMMARIZE": {
            // SUMMARIZE(table, groupBy1, groupBy2..., name1, expr1, name2, expr2...)
            const table = this.evalTable(expr.args[0]!, fc, rc);
            if (table.rowIdx.length === 0) return { kind: "table", column: null, rowIdx: [] };
            // Parse groupBy columns (until first name/expr pair)
            const groupByCols: string[] = [];
            const addCols: { name: string; expr: Expr }[] = [];
            let i = 1;
            // Group by columns come first (column references)
            while (i < expr.args.length && expr.args[i]!.k === "col") {
              groupByCols.push(expectColumnRef(expr.args[i]!));
              i++;
            }
            // Then name/expr pairs
            while (i + 1 < expr.args.length) {
              const nameArg = expr.args[i]!;
              const exprArg = expr.args[i + 1]!;
              if (nameArg.k !== "str") throw new DaxError("SUMMARIZE: column name must be a string literal.");
              addCols.push({ name: nameArg.v, expr: exprArg });
              i += 2;
            }
            // Group rows by groupBy columns
            const groups = new Map<string, number[]>(); // key -> row indices
            const groupByIndices = groupByCols.map((c) => this.colIdxOrThrow(c));
            for (const rowIdx of table.rowIdx) {
              const keyParts = groupByIndices.map((idx) => {
                const v = this.model.rows[rowIdx]![idx] ?? null;
                return isBlank(v) ? "" : String(v);
              });
              const key = keyParts.join("|");
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key)!.push(rowIdx);
            }
            // Build result rows
            const resultRows: DaxValue[][] = [];
            for (const rowIndices of groups.values()) {
              const firstRowIdx = rowIndices[0]!;
              const row: DaxValue[] = [];
              // Group by values
              for (const idx of groupByIndices) {
                row.push(this.model.rows[firstRowIdx]![idx] ?? null);
              }
              // Added columns - evaluate in the group context
              for (const ac of addCols) {
                const groupFc = new Map(fc);
                for (let j = 0; j < groupByCols.length; j++) {
                  const col = groupByCols[j]!;
                  const val = this.model.rows[firstRowIdx]![this.colIdxOrThrow(col)] ?? null;
                  groupFc.set(col, new Set([isBlank(val) ? "" : String(val)]));
                }
                const v = this.eval(ac.expr, groupFc, null);
                row.push(v);
              }
              resultRows.push(row);
            }
            // Return as a table with literal values (not backed by model rows)
            return {
              kind: "table",
              column: null,
              rowIdx: [],
              literal: resultRows.flat(),
            };
          }
          // -- ADDCOLUMNS --------------------------------------------------------
          case "ADDCOLUMNS": {
            // ADDCOLUMNS(table, name1, expr1, name2, expr2...)
            const table = this.evalTable(expr.args[0]!, fc, rc);
            const addCols: { name: string; expr: Expr }[] = [];
            for (let i = 1; i + 1 < expr.args.length; i += 2) {
              const nameArg = expr.args[i]!;
              const exprArg = expr.args[i + 1]!;
              if (nameArg.k !== "str") throw new DaxError("ADDCOLUMNS: column name must be a string literal.");
              addCols.push({ name: nameArg.v, expr: exprArg });
            }
            if (table.literal) {
              // Literal tables carry no row index to reconstruct from — the
              // projected shape cannot be recovered, so the result is empty.
              return { kind: "table", column: null, rowIdx: [], literal: [] };
            }
            // Model-backed table
            const resultRows: DaxValue[][] = [];
            for (const rowIdx of table.rowIdx) {
              const row: DaxValue[] = [];
              // Original columns
              if (table.column) {
                const v = this.model.rows[rowIdx]![this.colIdxOrThrow(table.column)] ?? null;
                row.push(v);
              } else {
                for (const col of this.model.columns) {
                  row.push(this.model.rows[rowIdx]![this.colIdxOrThrow(col)] ?? null);
                }
              }
              // Added columns
              const rowFc = new Map(fc);
              if (rc) {
                for (const col of this.model.columns) {
                  const v = this.model.rows[rowIdx]![this.colIdxOrThrow(col)] ?? null;
                  rowFc.set(col, new Set([isBlank(v) ? "" : String(v)]));
                }
              }
              for (const ac of addCols) {
                const v = this.eval(ac.expr, rowFc, rc ? { rowIdx } : null);
                row.push(v);
              }
              resultRows.push(row);
            }
            return {
              kind: "table",
              column: null,
              rowIdx: [],
              literal: resultRows.flat(),
            };
          }
          // -- SELECTCOLUMNS -----------------------------------------------------
          case "SELECTCOLUMNS": {
            // SELECTCOLUMNS(table, name1, expr1, name2, expr2...)
            const table = this.evalTable(expr.args[0]!, fc, rc);
            const selectCols: { name: string; expr: Expr }[] = [];
            for (let i = 1; i + 1 < expr.args.length; i += 2) {
              const nameArg = expr.args[i]!;
              const exprArg = expr.args[i + 1]!;
              if (nameArg.k !== "str") throw new DaxError("SELECTCOLUMNS: column name must be a string literal.");
              selectCols.push({ name: nameArg.v, expr: exprArg });
            }
            const resultRows: DaxValue[][] = [];
            for (const rowIdx of table.rowIdx) {
              const rowFc = new Map(fc);
              if (rc) {
                for (const col of this.model.columns) {
                  const v = this.model.rows[rowIdx]![this.colIdxOrThrow(col)] ?? null;
                  rowFc.set(col, new Set([isBlank(v) ? "" : String(v)]));
                }
              }
              const row: DaxValue[] = [];
              for (const sc of selectCols) {
                const v = this.eval(sc.expr, rowFc, rc ? { rowIdx } : null);
                row.push(v);
              }
              resultRows.push(row);
            }
            return {
              kind: "table",
              column: null,
              rowIdx: [],
              literal: resultRows.flat(),
            };
          }
          // -- CROSSJOIN ---------------------------------------------------------
          case "CROSSJOIN": {
            // CROSSJOIN(table1, table2, ...)
            const tables = expr.args.map((a) => this.evalTable(a, fc, rc));
            if (tables.length < 2) throw new DaxError("CROSSJOIN needs at least two tables.");
            const resultRows: DaxValue[][] = [];
            // An arrow, not a `function`: a plain function has no `this`, and
            // aliasing `this` just to reach the row store is the kind of
            // indirection that outlives its reason. The arrow keeps `this`
            // lexical from the enclosing method, and a `const` is fine for the
            // self-reference because the recursive call happens after init.
            const crossJoin = (remaining: TableVal[], current: DaxValue[]): void => {
              if (remaining.length === 0) {
                resultRows.push(current);
                return;
              }
              const [t, ...rest] = remaining;
              if (!t) return;
              for (const rowIdx of t.rowIdx) {
                const rowVals: DaxValue[] = [];
                if (t.column) {
                  rowVals.push(this.model.rows[rowIdx]![this.colIdxOrThrow(t.column)] ?? null);
                } else if (t.literal) {
                  // Literal table - need to reconstruct from flat array
                  // Simplified: assume single value per row
                  rowVals.push(t.literal[rowIdx] ?? null);
                }
                crossJoin(rest, [...current, ...rowVals]);
              }
            };
            crossJoin(tables, []);
            return {
              kind: "table",
              column: null,
              rowIdx: [],
              literal: resultRows.flat(),
            };
          }
          // -- GENERATE / GENERATEALL --------------------------------------------
          case "GENERATE":
          case "GENERATEALL": {
            // GENERATE(table1, table2) - cross join where table2 is evaluated per row of table1
            const table1 = this.evalTable(expr.args[0]!, fc, rc);
            const table2Expr = expr.args[1]!;
            const isGenerateAll = expr.name === "GENERATEALL";
            const resultRows: DaxValue[][] = [];
            for (const rowIdx1 of table1.rowIdx) {
              const rowFc = new Map(fc);
              if (table1.column) {
                const v = this.model.rows[rowIdx1]![this.colIdxOrThrow(table1.column)] ?? null;
                rowFc.set(table1.column, new Set([isBlank(v) ? "" : String(v)]));
              } else {
                for (const col of this.model.columns) {
                  const v = this.model.rows[rowIdx1]![this.colIdxOrThrow(col)] ?? null;
                  rowFc.set(col, new Set([isBlank(v) ? "" : String(v)]));
                }
              }
              const rowCtx = rc ? { rowIdx: rowIdx1, transitionColumns: table1.column ? [table1.column] : null } : null;
              const table2 = this.evalTable(table2Expr, rowFc, rowCtx);
              if (table2.rowIdx.length === 0 && !isGenerateAll) continue;
              for (const rowIdx2 of table2.rowIdx) {
                const row: DaxValue[] = [];
                // Table1 columns
                if (table1.column) {
                  row.push(this.model.rows[rowIdx1]![this.colIdxOrThrow(table1.column)] ?? null);
                } else {
                  for (const col of this.model.columns) {
                    row.push(this.model.rows[rowIdx1]![this.colIdxOrThrow(col)] ?? null);
                  }
                }
                // Table2 columns
                if (table2.column) {
                  row.push(this.model.rows[rowIdx2]![this.colIdxOrThrow(table2.column)] ?? null);
                } else if (table2.literal) {
                  // Simplified
                  row.push(table2.literal[rowIdx2] ?? null);
                }
                resultRows.push(row);
              }
            }
            return {
              kind: "table",
              column: null,
              rowIdx: [],
              literal: resultRows.flat(),
            };
          }
          // -- NATURALINNERJOIN / NATURALLEFTOUTERJOIN ---------------------------
          case "NATURALINNERJOIN":
          case "NATURALLEFTOUTERJOIN": {
            // Join on common column names
            const left = this.evalTable(expr.args[0]!, fc, rc);
            const right = this.evalTable(expr.args[1]!, fc, rc);
            // Find common columns
            const leftCols = left.column ? [left.column] : this.model.columns;
            const rightCols = right.column ? [right.column] : this.model.columns;
            const commonCols = leftCols.filter((c) => rightCols.includes(c));
            if (commonCols.length === 0) throw new DaxError("NATURAL JOIN requires at least one common column name.");
            const isLeftOuter = expr.name === "NATURALLEFTOUTERJOIN";
            const rightIdxMap = new Map<string, number[]>();
            const rightCommonIndices = commonCols.map((c) => this.colIdxOrThrow(c));
            for (const rowIdx of right.rowIdx) {
              const key = rightCommonIndices
                .map((idx) => {
                  const v = this.model.rows[rowIdx]![idx] ?? null;
                  return isBlank(v) ? "" : String(v);
                })
                .join("|");
              if (!rightIdxMap.has(key)) rightIdxMap.set(key, []);
              rightIdxMap.get(key)!.push(rowIdx);
            }
            const resultRows: DaxValue[][] = [];
            const leftCommonIndices = commonCols.map((c) => this.colIdxOrThrow(c));
            for (const rowIdx1 of left.rowIdx) {
              const key = leftCommonIndices
                .map((idx) => {
                  const v = this.model.rows[rowIdx1]![idx] ?? null;
                  return isBlank(v) ? "" : String(v);
                })
                .join("|");
              const matches = rightIdxMap.get(key) ?? [];
              if (matches.length === 0) {
                if (isLeftOuter) {
                  // Left outer - include left row with BLANK for right columns
                  const row: DaxValue[] = [];
                  for (const col of leftCols) row.push(this.model.rows[rowIdx1]![this.colIdxOrThrow(col)] ?? null);
                  for (const col of rightCols) if (!commonCols.includes(col)) row.push(null);
                  resultRows.push(row);
                }
              } else {
                for (const rowIdx2 of matches) {
                  const row: DaxValue[] = [];
                  for (const col of leftCols) row.push(this.model.rows[rowIdx1]![this.colIdxOrThrow(col)] ?? null);
                  for (const col of rightCols)
                    if (!commonCols.includes(col)) row.push(this.model.rows[rowIdx2]![this.colIdxOrThrow(col)] ?? null);
                  resultRows.push(row);
                }
              }
            }
            return {
              kind: "table",
              column: null,
              rowIdx: [],
              literal: resultRows.flat(),
            };
          }
          // -- UNION / INTERSECT / EXCEPT ----------------------------------------
          case "UNION":
          case "INTERSECT":
          case "EXCEPT": {
            const left = this.evalTable(expr.args[0]!, fc, rc);
            const right = this.evalTable(expr.args[1]!, fc, rc);
            // Both tables must have same column structure
            const leftCols = left.column ? [left.column] : this.model.columns;
            const rightCols = right.column ? [right.column] : this.model.columns;
            if (leftCols.length !== rightCols.length)
              throw new DaxError(`${name} requires tables with the same number of columns.`);
            // For simplicity, use literal representation
            const leftRows: DaxValue[][] = [];
            for (const rowIdx of left.rowIdx) {
              const row: DaxValue[] = [];
              for (const col of leftCols) row.push(this.model.rows[rowIdx]![this.colIdxOrThrow(col)] ?? null);
              leftRows.push(row);
            }
            const rightRows: DaxValue[][] = [];
            for (const rowIdx of right.rowIdx) {
              const row: DaxValue[] = [];
              for (const col of rightCols) row.push(this.model.rows[rowIdx]![this.colIdxOrThrow(col)] ?? null);
              rightRows.push(row);
            }
            const rowKey = (row: DaxValue[]) => row.map((v) => (isBlank(v) ? "" : String(v))).join("|");
            let resultRows: DaxValue[][];
            if (expr.name === "UNION") {
              const seen = new Set<string>();
              resultRows = [];
              for (const r of [...leftRows, ...rightRows]) {
                const k = rowKey(r);
                if (!seen.has(k)) {
                  seen.add(k);
                  resultRows.push(r);
                }
              }
            } else if (expr.name === "INTERSECT") {
              const rightKeys = new Set(rightRows.map(rowKey));
              resultRows = leftRows.filter((r) => rightKeys.has(rowKey(r)));
            } else {
              // EXCEPT
              const rightKeys = new Set(rightRows.map(rowKey));
              resultRows = leftRows.filter((r) => !rightKeys.has(rowKey(r)));
            }
            return {
              kind: "table",
              column: null,
              rowIdx: [],
              literal: resultRows.flat(),
            };
          }
          // -- ROW ---------------------------------------------------------------
          case "ROW": {
            // ROW(name1, expr1, name2, expr2...) - single row table
            const cols: { name: string; expr: Expr }[] = [];
            for (let i = 0; i + 1 < expr.args.length; i += 2) {
              const nameArg = expr.args[i]!;
              const exprArg = expr.args[i + 1]!;
              if (nameArg.k !== "str") throw new DaxError("ROW: column name must be a string literal.");
              cols.push({ name: nameArg.v, expr: exprArg });
            }
            const row: DaxValue[] = [];
            for (const c of cols) row.push(this.eval(c.expr, fc, rc));
            return {
              kind: "table",
              column: null,
              rowIdx: [],
              literal: row,
            };
          }
          // -- DATATABLE ---------------------------------------------------------
          case "DATATABLE": {
            // DATATABLE(col1, type1, col2, type2, ..., { {val1, val2...}, ... })
            // Simplified: last arg is a list of lists
            if (expr.args.length < 3) throw new DaxError("DATATABLE requires at least one column and data.");
            const dataArg = expr.args[expr.args.length - 1]!;
            if (dataArg.k !== "list") throw new DaxError("DATATABLE: data must be a list of rows { {..}, {..} }");
            const numCols = (expr.args.length - 1) / 2;
            const colNames: string[] = [];
            for (let i = 0; i < numCols; i++) {
              const nameArg = expr.args[i * 2]!;
              if (nameArg.k !== "str") throw new DaxError("DATATABLE: column names must be string literals.");
              colNames.push(nameArg.v);
            }
            const resultRows: DaxValue[][] = [];
            for (const rowExpr of dataArg.items) {
              if (rowExpr.k !== "list") throw new DaxError("DATATABLE: each row must be a list.");
              const row: DaxValue[] = [];
              for (const cellExpr of rowExpr.items) {
                row.push(this.eval(cellExpr, fc, rc));
              }
              resultRows.push(row);
            }
            return {
              kind: "table",
              column: null,
              rowIdx: [],
              literal: resultRows.flat(),
            };
          }
          // -- GROUPBY -----------------------------------------------------------
          case "GROUPBY": {
            // GROUPBY(table, groupBy1, groupBy2..., name1, CURRENTGROUP(), expr1...)
            const table = this.evalTable(expr.args[0]!, fc, rc);
            const groupByCols: string[] = [];
            const addCols: { name: string; expr: Expr; isCurrentGroup: boolean }[] = [];
            let i = 1;
            while (i < expr.args.length && expr.args[i]!.k === "col") {
              groupByCols.push(expectColumnRef(expr.args[i]!));
              i++;
            }
            while (i + 1 < expr.args.length) {
              const nameArg = expr.args[i]!;
              const exprArg = expr.args[i + 1]!;
              if (nameArg.k !== "str") throw new DaxError("GROUPBY: column name must be a string literal.");
              // CURRENTGROUP() is a marker: the extension column's expression
              // is evaluated PER GROUP over that group's rows (real DAX
              // semantics — the grouped table, not a scalar 0).
              const isCG = exprArg.k === "func" && exprArg.name === "CURRENTGROUP" && exprArg.args.length === 0;
              addCols.push({ name: nameArg.v, expr: exprArg, isCurrentGroup: isCG });
              i += 2;
            }
            // Group rows
            const groups = new Map<string, number[]>();
            const groupByIndices = groupByCols.map((c) => this.colIdxOrThrow(c));
            for (const rowIdx of table.rowIdx) {
              const key = groupByIndices
                .map((idx) => {
                  const v = this.model.rows[rowIdx]![idx] ?? null;
                  return isBlank(v) ? "" : String(v);
                })
                .join("|");
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key)!.push(rowIdx);
            }
            const resultRows: DaxValue[][] = [];
            for (const rowIndices of groups.values()) {
              const firstRowIdx = rowIndices[0]!;
              const row: DaxValue[] = [];
              for (const idx of groupByIndices) row.push(this.model.rows[firstRowIdx]![idx] ?? null);
              for (const ac of addCols) {
                const groupFc = new Map(fc);
                for (let j = 0; j < groupByCols.length; j++) {
                  const col = groupByCols[j]!;
                  const val = this.model.rows[firstRowIdx]![this.colIdxOrThrow(col)] ?? null;
                  groupFc.set(col, new Set([isBlank(val) ? "" : String(val)]));
                }
                if (ac.isCurrentGroup) {
                  // Real CURRENTGROUP semantics: the extension expression is
                  // an AGGREGATION over this group's rows. `CURRENTGROUP()`
                  // must be wrapped in an aggregator (SUMX/COUNTX/AVERAGEX…)
                  // — evaluate that wrapper with the row context bound to
                  // each of the group's rows in turn.
                  row.push(this.evalCurrentGroupExpr(ac.expr, groupFc, rowIndices));
                } else {
                  const v = this.eval(ac.expr, groupFc, null);
                  row.push(v);
                }
              }
              resultRows.push(row);
            }
            return {
              kind: "table",
              column: null,
              rowIdx: [],
              literal: resultRows.flat(),
            };
          }
        }
        throw new DaxError(`${expr.name} cannot be used as a table argument here.`);
      }
      case "col": {
        // Bare column used as table (iterator over that column's visible values)
        const name = expectColumnRef(expr);
        const idx = this.colIdxOrThrow(name);
        return {
          kind: "table",
          column: name,
          rowIdx: this.visibleRows(fc).filter((i) => !isBlank(this.model.rows[i]![idx] ?? null)),
        };
      }
      case "list": {
        // Inline literal table — column name null so downstream can't treat it
        // as a model column; values stored on `literal`.
        return { kind: "table", column: null, rowIdx: [], literal: expr.items.map((it) => this.eval(it, fc, rc)) };
      }
      default:
        throw new DaxError(`Expected a table expression (ALL / VALUES / FILTER / a column).`);
    }
  }

  // -- filter arguments for CALCULATE ---------------------------------------

  public applyFilterArg(target: FilterCtx, arg: Expr, fc: FilterCtx, rc: RowCtx | null): void {
    if (arg.k === "func") {
      switch (arg.name) {
        case "ALL": {
          if (arg.args.length === 0) {
            target.clear();
            return;
          }
          for (const a of arg.args) target.set(expectColumnRef(a), null);
          return;
        }
        case "ALLEXCEPT": {
          const keep = new Set(arg.args.slice(1).map(expectColumnRef));
          target.clear();
          for (const col of this.model.columns) if (!keep.has(col)) target.set(col, null);
          return;
        }
        case "DATESYTD":
        case "DATESQTD":
        case "DATESMTD":
        case "NEXTDAY":
        case "NEXTMONTH":
        case "NEXTQUARTER":
        case "NEXTYEAR":
        case "DATESBETWEEN":
        case "DATESINPERIOD":
        case "SAMEPERIODLASTYEAR":
        case "DATEADD":
        case "PARALLELPERIOD":
        case "PREVIOUSMONTH":
        case "PREVIOUSQUARTER":
        case "PREVIOUSYEAR":
        case "FIRSTDATE":
        case "LASTDATE":
        case "STARTOFMONTH":
        case "STARTOFQUARTER":
        case "STARTOFYEAR":
        case "ENDOFMONTH":
        case "ENDOFQUARTER":
        case "ENDOFYEAR": {
          const ds = this.timeIntelSet(arg.name, arg.args, fc);
          target.set(ds.column, new Set(ds.dates));
          return;
        }
        case "TREATAS": {
          // TREATAS(tableExpr, [Col1], [Col2]…) — apply the table's values as
          // filters on the referenced columns. Single-column tables only in
          // this engine (the TableVal representation carries one column).
          const t = this.evalTable(arg.args[0]!, fc, rc);
          const cols = arg.args.slice(1).map(expectColumnRef);
          if (t.literal) {
            const values = new Set(t.literal.map((v) => String(v ?? "")));
            for (const col of cols) target.set(col, values);
            return;
          }
          if (!t.column)
            throw new DaxError(
              "TREATAS needs a single-column table expression (ALL(col), VALUES(col), FILTER over a column, { … }).",
            );
          const idx = this.colIdxOrThrow(t.column);
          const values = new Set(t.rowIdx.map((i) => String(this.model.rows[i]![idx] ?? "")));
          for (const col of cols) target.set(col, values);
          return;
        }
      }
    }
    // VALUES(col) as a CALCULATE filter keeps the current visible values.
    if (arg.k === "func" && arg.name === "VALUES") {
      const col = expectColumnRef(arg.args[0]!);
      const t = this.evalTable(arg, fc, rc);
      const idx = this.colIdxOrThrow(col);
      target.set(col, new Set(t.rowIdx.map((i) => String(this.model.rows[i]![idx]))));
      return;
    }
    // FILTER(table, predicate) as a CALCULATE filter: apply the predicate row
    // by row over the base table and keep the surviving values per column.
    if (arg.k === "func" && arg.name === "FILTER" && arg.args.length === 2) {
      const base = this.evalTable(arg.args[0]!, fc, rc);
      const kept: number[] = [];
      for (const rowIdx of base.rowIdx) {
        if (truthy(this.eval(arg.args[1]!, fc, { rowIdx, transitionColumns: base.column ? [base.column] : null })))
          kept.push(rowIdx);
      }
      if (base.column) {
        const idx = this.colIdxOrThrow(base.column);
        target.set(base.column, new Set(kept.map((i) => String(this.model.rows[i]![idx] ?? ""))));
      } else {
        // Table over all columns: intersect every column's filter.
        for (const col of this.model.columns) {
          const idx = this.colIdxOrThrow(col);
          const values = new Set(kept.map((i) => String(this.model.rows[i]![idx] ?? "")));
          const existing = target.get(col);
          target.set(col, existing ? new Set([...existing].filter((v) => values.has(v))) : values);
        }
      }
      return;
    }
    // [Col] IN { … } as a CALCULATE filter (parsed as { k: "in" }).
    if (arg.k === "in") {
      const colExpr = arg.e.k === "col" ? arg.e : null;
      if (!colExpr) throw new DaxError(`IN as a CALCULATE filter must be [Column] IN { … }.`);
      const values = new Set(arg.list.map((it) => String(this.eval(it, fc, rc) ?? "")));
      target.set(expectColumnRef(colExpr), values);
      return;
    }
    // Boolean predicate over one column: [Col] = "x", [Col] <> "x", [Col] > 5 …
    // Multiple filter args on the same column intersect (DAX AND semantics).
    const pred = this.extractColumnPredicate(arg, fc, rc);
    if (pred) {
      const existing = target.get(pred.column) ?? null;
      if (existing) {
        target.set(pred.column, new Set([...existing].filter((v) => pred.values.has(v))));
      } else {
        target.set(pred.column, pred.values);
      }
      return;
    }
    throw new DaxError(
      `Unsupported CALCULATE filter argument — use [Column] = value, ALL(col), ALLEXCEPT(…), VALUES(col) or a time-intelligence function.`,
    );
  }

  private extractColumnPredicate(
    arg: Expr,
    _fc: FilterCtx,
    rc: RowCtx | null,
  ): { column: string; values: Set<string> } | null {
    if (arg.k !== "bin" || !["=", "<>", ">", "<", ">=", "<="].includes(arg.op)) return null;
    const colExpr = arg.l.k === "col" ? arg.l : arg.r.k === "col" ? arg.r : null;
    if (!colExpr) return null;
    const other = colExpr === arg.l ? arg.r : arg.l;
    if (other.k !== "num" && other.k !== "str" && other.k !== "bool") return null;
    const literal: DaxValue = other.k === "num" ? other.v : other.k === "str" ? other.v : other.v;
    const col = expectColumnRef(colExpr);
    const idx = this.colIdxOrThrow(col);
    if (rc) {
      throw new DaxError(
        `Boolean filter arguments like [${col}] ${arg.op} … cannot be used inside a row context — wrap the condition in FILTER(…) instead.`,
      );
    }
    const values = new Set<string>();
    const asNum = (v: DaxValue): number | null => {
      if (typeof v === "number") return v;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
      return null;
    };
    for (const row of this.model.rows) {
      const v = row[idx] ?? null;
      if (arg.op === "=" && daxEquals(v, literal)) values.add(String(v));
      else if (arg.op === "<>" && !daxEquals(v, literal)) values.add(String(v));
      else if (["<", ">", "<=", ">="].includes(arg.op)) {
        const n1 = asNum(v);
        const n2 = asNum(literal);
        let ok: boolean;
        if (n1 !== null && n2 !== null) {
          ok = arg.op === "<" ? n1 < n2 : arg.op === ">" ? n1 > n2 : arg.op === "<=" ? n1 <= n2 : n1 >= n2;
        } else {
          // Lexicographic fallback — correct for ISO dates (YYYY-MM-DD).
          const s1 = String(v ?? "");
          const s2 = String(literal ?? "");
          ok = arg.op === "<" ? s1 < s2 : arg.op === ">" ? s1 > s2 : arg.op === "<=" ? s1 <= s2 : s1 >= s2;
        }
        if (ok) values.add(String(v));
      }
    }
    return { column: col, values };
  }

  // -- time intelligence ------------------------------------------------------

  private dateColumnOf(args: Expr[]): string {
    return expectColumnRef(args[0]!);
  }

  private visibleDates(col: string, fc: FilterCtx): string[] {
    const idx = this.colIdxOrThrow(col);
    const dates: string[] = [];
    for (const i of this.visibleRows(fc)) {
      const v = this.model.rows[i]![idx] ?? null;
      if (typeof v === "string" && ISO_DATE.test(v)) dates.push(v.slice(0, 10));
      else if (v !== null && v !== "")
        throw new DaxError(
          `Time intelligence requires ISO dates (YYYY-MM-DD) in “[${col}]”; found ${JSON.stringify(v)}. Convert the column to date first.`,
        );
    }
    if (!dates.length) throw new DaxError(`Column “[${col}]” has no visible dates for the current filter context.`);
    dates.sort();
    return dates;
  }

  private allDatesInColumn(col: string): string[] {
    // Auto date dimension: when this column has a continuous calendar, scan
    // the FULL period so sparse facts still line up for SPLY / PREVIOUS* / NEXT*.
    if (this.model.calendar && this.model.calendar.dateColumn === this.resolvePlain(col)) {
      return this.model.calendar.dates;
    }
    const idx = this.colIdxOrThrow(col);
    const set = new Set<string>();
    for (const row of this.model.rows) {
      const v = row[idx] ?? null;
      if (typeof v === "string" && ISO_DATE.test(v)) set.add(v.slice(0, 10));
    }
    return [...set].sort();
  }

  private timeIntelSet(fn: string, args: Expr[], fc: FilterCtx): DateSet {
    const col = this.dateColumnOf(args);
    const visible = this.visibleDates(col, fc);
    const latest = visible[visible.length - 1]!;
    const shift = (d: string, years: number, months = 0): string => {
      const [y, m, day] = d.split("-").map(Number);
      const total = (y! + years) * 12 + (m! - 1) + months;
      const ny = Math.floor(total / 12);
      const nm = ((total % 12) + 12) % 12;
      const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
      return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(day!, lastDay)).padStart(2, "0")}`;
    };
    const monthKey = (d: string) => d.slice(0, 7);
    switch (fn) {
      case "DATESYTD": {
        const year = latest.slice(0, 4);
        return { kind: "dateset", column: col, dates: visible.filter((d) => d.startsWith(year)) };
      }
      case "DATESQTD": {
        const q = Math.floor((Number(latest.slice(5, 7)) - 1) / 3); // 0..3
        const startMonth = q * 3 + 1;
        const prefix = `${latest.slice(0, 4)}-${String(startMonth).padStart(2, "0")}`;
        return { kind: "dateset", column: col, dates: visible.filter((d) => d >= prefix && d <= latest) };
      }
      case "DATESMTD":
        return {
          kind: "dateset",
          column: col,
          dates: visible.filter((d) => monthKey(d) === monthKey(latest) && d <= latest),
        };
      case "SAMEPERIODLASTYEAR": {
        // Match by shifted month key so fact tables with sparse dates still
        // line up (DAX aligns periods, not individual dates).
        const wanted = new Set(visible.map((d) => shift(d, -1).slice(0, 7)));
        return {
          kind: "dateset",
          column: col,
          dates: this.allDatesInColumn(col).filter((d) => wanted.has(d.slice(0, 7))),
        };
      }
      case "PREVIOUSYEAR":
        return {
          kind: "dateset",
          column: col,
          dates: this.allDatesInColumn(col).filter((d) => d.slice(0, 4) === String(Number(latest.slice(0, 4)) - 1)),
        };
      case "PREVIOUSQUARTER": {
        const q = Math.floor((Number(latest.slice(5, 7)) - 1) / 3);
        const shifted = shift(latest, 0, -3);
        const year = shifted.slice(0, 4);
        const startMonth = q * 3 + 1; // same quarter index, previous year-month block
        const prefix = `${year}-${String(startMonth).padStart(2, "0")}`;
        const endPrefix = `${year}-${String(startMonth + 2).padStart(2, "0")}`;
        return {
          kind: "dateset",
          column: col,
          dates: this.allDatesInColumn(col).filter((d) => d >= prefix && d <= `${endPrefix}-31`),
        };
      }
      case "PREVIOUSMONTH": {
        const prevKey = monthKey(shift(latest, 0, -1));
        return {
          kind: "dateset",
          column: col,
          dates: this.allDatesInColumn(col).filter((d) => monthKey(d) === prevKey),
        };
      }
      case "NEXTDAY":
      case "NEXTMONTH":
      case "NEXTQUARTER":
      case "NEXTYEAR": {
        // DAX semantics: NEXTDAY anchors on the LAST visible date and returns
        // the single following day; NEXTMONTH/QUARTER/YEAR anchor on the FIRST
        // visible date and return the FULL following period.
        const first = visible[0]!;
        const nextDay = new Date(
          Date.UTC(Number(latest.slice(0, 4)), Number(latest.slice(5, 7)) - 1, Number(latest.slice(8, 10)) + 1),
        )
          .toISOString()
          .slice(0, 10);
        if (fn === "NEXTDAY") return { kind: "dateset", column: col, dates: [nextDay] };
        if (fn === "NEXTMONTH") {
          const target = monthKey(shift(first, 0, 1));
          return {
            kind: "dateset",
            column: col,
            dates: this.allDatesInColumn(col).filter((d) => monthKey(d) === target),
          };
        }
        if (fn === "NEXTQUARTER") {
          const anchor = shift(first, 0, 3);
          const q = Math.floor((Number(anchor.slice(5, 7)) - 1) / 3);
          const startMonth = q * 3 + 1;
          const prefix = `${anchor.slice(0, 4)}-${String(startMonth).padStart(2, "0")}`;
          const endPrefix = `${anchor.slice(0, 4)}-${String(startMonth + 2).padStart(2, "0")}`;
          return {
            kind: "dateset",
            column: col,
            dates: this.allDatesInColumn(col).filter((d) => d >= prefix && d <= `${endPrefix}-31`),
          };
        }
        const targetYear = String(Number(first.slice(0, 4)) + 1);
        return {
          kind: "dateset",
          column: col,
          dates: this.allDatesInColumn(col).filter((d) => d.slice(0, 4) === targetYear),
        };
      }
      case "DATESBETWEEN": {
        // DATESBETWEEN(dates, start, end) — inclusive bounds.
        const start = String(this.eval(args[1]!, fc, null));
        const end = String(this.eval(args[2]!, fc, null));
        return {
          kind: "dateset",
          column: col,
          dates: this.allDatesInColumn(col).filter((d) => d >= start.slice(0, 10) && d <= end.slice(0, 10)),
        };
      }
      case "DATESINPERIOD": {
        // DATESINPERIOD(dates, start, amount, unit) — amount may be negative.
        const start = String(this.eval(args[1]!, fc, null)).slice(0, 10);
        const n = Math.trunc(numOf(this.eval(args[2]!, fc, null), "DATESINPERIOD amount"));
        const unitRaw = String(this.eval(args[3]!, fc, null)).toLowerCase();
        const unitMonths = unitRaw.startsWith("year")
          ? 12
          : unitRaw.startsWith("quarter")
            ? 3
            : unitRaw.startsWith("month")
              ? 1
              : 0;
        if (!unitRaw.startsWith("day") && unitMonths === 0)
          throw new DaxError(`DATESINPERIOD unit must be day, month, quarter or year — got “${unitRaw}”.`);
        const endDate = unitMonths
          ? shift(start, 0, unitMonths * n)
          : new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)) + n))
              .toISOString()
              .slice(0, 10);
        const [lo, hi] = n >= 0 ? [start, endDate] : [endDate, start];
        return { kind: "dateset", column: col, dates: this.allDatesInColumn(col).filter((d) => d >= lo && d <= hi) };
      }
      case "DATEADD":
      case "PARALLELPERIOD": {
        const n = args[1] ? Math.trunc(numOf(this.eval(args[1], fc, null), "DATEADD interval")) : 0;
        const unit = (args[2] ? String(this.eval(args[2], fc, null)) : "month").toLowerCase();
        if (!["year", "years", "quarter", "quarters", "month", "months", "day", "days"].includes(unit))
          throw new DaxError(`DATEADD unit must be year, quarter, month or day — got “${unit}”.`);
        if (unit.startsWith("day")) {
          const step = (d: string, days: number) => {
            const t = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
            return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
          };
          return { kind: "dateset", column: col, dates: visible.map((d) => step(d, n)) };
        }
        const months = unit.startsWith("year") ? n * 12 : unit.startsWith("quarter") ? n * 3 : n;
        if (fn === "PARALLELPERIOD") {
          // Returns the full period containing the shifted date.
          const shifted = shift(latest, 0, months);
          if (unit.startsWith("year"))
            return {
              kind: "dateset",
              column: col,
              dates: this.allDatesInColumn(col).filter((d) => d.slice(0, 4) === shifted.slice(0, 4)),
            };
          if (unit.startsWith("quarter")) {
            const q = Math.floor((Number(shifted.slice(5, 7)) - 1) / 3);
            const startMonth = q * 3 + 1;
            const prefix = `${shifted.slice(0, 4)}-${String(startMonth).padStart(2, "0")}`;
            const end = `${shifted.slice(0, 4)}-${String(startMonth + 2).padStart(2, "0")}`;
            return {
              kind: "dateset",
              column: col,
              dates: this.allDatesInColumn(col).filter((d) => d >= prefix && d <= `${end}-31`),
            };
          }
          return {
            kind: "dateset",
            column: col,
            dates: this.allDatesInColumn(col).filter((d) => monthKey(d) === monthKey(shifted)),
          };
        }
        return { kind: "dateset", column: col, dates: visible.map((d) => shift(d, 0, months)) };
      }
      // Date-boundary sets: FIRSTDATE/LASTDATE (min/max visible date) and the
      // STARTOF*/ENDOF* families (first/last date of the period containing the
      // latest visible date). Each returns a single-date set on the date
      // column, so wrapping in CALCULATE/COUNTROWS behaves like real DAX.
      case "FIRSTDATE":
        return { kind: "dateset", column: col, dates: [visible[0]!] };
      case "LASTDATE":
        return { kind: "dateset", column: col, dates: [latest] };
      case "STARTOFMONTH":
      case "STARTOFQUARTER":
      case "STARTOFYEAR": {
        const q = Math.floor((Number(latest.slice(5, 7)) - 1) / 3);
        const startMonth = q * 3 + 1;
        const boundary =
          fn === "STARTOFMONTH"
            ? `${monthKey(latest)}-01`
            : fn === "STARTOFQUARTER"
              ? `${latest.slice(0, 4)}-${String(startMonth).padStart(2, "0")}-01`
              : `${latest.slice(0, 4)}-01-01`;
        // The boundary date itself must exist in the data for the set to bind;
        // fall back to the earliest visible date at-or-after the boundary.
        const atOrAfter = this.allDatesInColumn(col).filter((d) => d >= boundary);
        return { kind: "dateset", column: col, dates: atOrAfter.length ? [atOrAfter[0]!] : [] };
      }
      case "ENDOFMONTH":
      case "ENDOFQUARTER":
      case "ENDOFYEAR": {
        const q = Math.floor((Number(latest.slice(5, 7)) - 1) / 3);
        const endMonth = q * 3 + 3;
        const boundary =
          fn === "ENDOFMONTH"
            ? `${monthKey(latest)}-31`
            : fn === "ENDOFQUARTER"
              ? `${latest.slice(0, 4)}-${String(endMonth).padStart(2, "0")}-31`
              : `${latest.slice(0, 4)}-12-31`;
        // Latest visible date at-or-before the period's calendar end.
        const atOrBefore = this.allDatesInColumn(col).filter((d) => d <= boundary);
        return { kind: "dateset", column: col, dates: atOrBefore.length ? [atOrBefore[atOrBefore.length - 1]!] : [] };
      }
    }
    throw new DaxError(`Unknown time-intelligence function ${fn}`);
  }

  // -- functions --------------------------------------------------------------

  private aggOverRows(
    fn: string,
    rows: number[],
    colName: string | null,
    valueExpr: Expr | null,
    fc: FilterCtx,
    _rc: RowCtx | null,
  ): DaxValue {
    const values: DaxValue[] = [];
    for (const rowIdx of rows) {
      if (valueExpr) {
        const v = this.eval(valueExpr, fc, { rowIdx });
        if (!isBlank(v)) values.push(v);
      } else if (colName) {
        const idx = this.colIdxOrThrow(colName);
        const v = this.model.rows[rowIdx]![idx] ?? null;
        if (!isBlank(v)) values.push(v);
      } else {
        values.push(1);
      }
    }
    switch (fn) {
      case "SUM":
        return values.reduce<number>((s, v) => s + numOf(v, "SUM"), 0);
      case "AVERAGE": {
        if (!values.length) return null;
        return values.reduce<number>((s, v) => s + numOf(v, "AVERAGE"), 0) / values.length;
      }
      case "MIN": {
        if (!values.length) return null;
        return values.reduce((m, v) =>
          typeof v === "number" && typeof m === "number" ? Math.min(m, v) : String(v) < String(m) ? v : m,
        );
      }
      case "MAX": {
        if (!values.length) return null;
        return values.reduce((m, v) =>
          typeof v === "number" && typeof m === "number" ? Math.max(m, v) : String(v) > String(m) ? v : m,
        );
      }
      case "COUNT":
      case "COUNTX":
        return values.length;
      case "DISTINCTCOUNT":
        return new Set(values.map((v) => String(v))).size;
    }
    throw new DaxError(`Unknown aggregation ${fn}`);
  }

  private evalFunc(expr: Extract<Expr, { k: "func" }>, fc: FilterCtx, rc: RowCtx | null): DaxValue {
    const { name, args } = expr;
    const arg = (i: number): DaxValue => (args[i] ? this.eval(args[i]!, fc, rc) : null);

    switch (name) {
      // -- aggregations ------------------------------------------------------
      case "SUM":
      case "AVERAGE":
      case "MIN":
      case "MAX":
      case "COUNT":
      case "DISTINCTCOUNT": {
        // Aggregation inside a row context triggers context transition
        // (implicit CALCULATE), scoped to the iterated column when applicable.
        if (rc) return this.eval(expr, this.withContextTransition(fc, rc), null);
        const col = expectColumnRef(args[0]!);
        const rows = this.visibleRows(fc);
        return this.aggOverRows(name, rows, col, null, fc, rc);
      }
      case "COUNTROWS": {
        const t = this.evalTable(args[0]!, fc, rc);
        return t.rowIdx.length;
      }
      // -- iterators -----------------------------------------------------------
      case "SUMX":
      case "AVERAGEX":
      case "MINX":
      case "MAXX":
      case "COUNTX": {
        const t = this.evalTable(args[0]!, fc, rc);
        const values: DaxValue[] = [];
        for (const rowIdx of t.rowIdx) {
          const v = this.eval(args[1]!, fc, { rowIdx, transitionColumns: t.column ? [t.column] : null });
          if (!isBlank(v)) values.push(v);
        }
        switch (name) {
          case "SUMX":
            return values.reduce<number>((s, v) => s + numOf(v, name), 0);
          case "AVERAGEX":
            return values.length ? values.reduce<number>((s, v) => s + numOf(v, name), 0) / values.length : null;
          case "MINX":
            return values.length ? Math.min(...values.map((v) => numOf(v, name))) : null;
          case "MAXX":
            return values.length ? Math.max(...values.map((v) => numOf(v, name))) : null;
          case "COUNTX":
            return values.length;
        }
        return null;
      }
      case "RANKX": {
        // RANKX(table, expr [, value [, order]]) — DAX order: 0/default descending.
        // The score expression is evaluated per table row with full context
        // transition so nested aggregations (SUM etc.) see each row's slice.
        const t = this.evalTable(args[0]!, fc, rc);
        const scores: number[] = [];
        for (const rowIdx of t.rowIdx) {
          // Single-column tables transition only that column (region total,
          // not per-row amounts).
          const v = this.eval(args[1]!, fc, { rowIdx, transitionColumns: t.column ? [t.column] : null });
          if (!isBlank(v)) scores.push(numOf(v, "RANKX"));
        }
        // Default value: the score expression in the current context (DAX uses
        // the measure evaluated in the surrounding filter/row context).
        const value =
          args[2] && !isBlank(arg(2))
            ? numOf(arg(2)!, "RANKX value")
            : rc
              ? numOf(this.eval(args[1]!, this.withContextTransition(fc, rc), null), "RANKX value")
              : numOf(this.eval(args[1]!, fc, null), "RANKX value");
        if (value === null) throw new DaxError("RANKX needs a row context or an explicit value argument.");
        const asc = args[3] ? numOf(arg(3)!, "RANKX order") === 1 : false;
        // DAX "skip" tie semantics: rank = position among DISTINCT scores.
        const distinctSorted = [...new Set(scores)].sort((a, b) => (asc ? a - b : b - a));
        const rank = distinctSorted.indexOf(value);
        return rank < 0 ? null : rank + 1;
      }
      // -- CALCULATE ----------------------------------------------------------
      case "CALCULATE": {
        const [valueExpr, ...filterArgs] = args;
        let inner: FilterCtx = new Map(fc);
        if (rc) inner = this.withContextTransition(inner, rc);
        for (const f of filterArgs) this.applyFilterArg(inner, f, fc, rc);
        return this.eval(valueExpr!, inner, null);
      }
      // -- context helpers ----------------------------------------------------
      case "SELECTEDVALUE": {
        const col = expectColumnRef(args[0]!);
        const t = this.evalTable({ k: "func", name: "VALUES", args: [{ k: "col", name: col }] }, fc, rc);
        if (t.rowIdx.length === 1) return this.cell(t.rowIdx[0]!, col);
        return args[1] ? arg(1) : null;
      }
      case "HASONEVALUE": {
        const col = expectColumnRef(args[0]!);
        const t = this.evalTable({ k: "func", name: "VALUES", args: [{ k: "col", name: col }] }, fc, rc);
        return t.rowIdx.length === 1;
      }
      case "DISTINCTCOUNTNOBLANK": {
        const col = expectColumnRef(args[0]!);
        const rows = this.visibleRows(fc);
        const idx = this.colIdxOrThrow(col);
        const set = new Set<string>();
        for (const i of rows) {
          const v = this.model.rows[i]![idx] ?? null;
          if (!isBlank(v)) set.add(String(v));
        }
        return set.size;
      }
      case "RELATED": {
        // On a materialized star model the related table's columns are joined
        // onto the fact row, so RELATED('Dim'[Col]) is that row's value —
        // null (BLANK) on orphan rows. Requires a row context, like DAX.
        if (!rc)
          throw new DaxError(
            "RELATED() needs a row context — call it inside an iterator, FILTER, or CALCULATE over a table.",
          );
        const col = expectColumnRef(args[0]!);
        return this.cell(rc.rowIdx, col);
      }
      // -- statistical aggregations ------------------------------------------
      case "MEDIAN":
      case "PRODUCT":
      case "COUNTBLANK":
      case "STDEV.P":
      case "STDEV.S":
      case "VAR.P":
      case "VAR.S": {
        const col = expectColumnRef(args[0]!);
        const rows = this.visibleRows(fc);
        const idx = this.colIdxOrThrow(col);
        if (name === "COUNTBLANK") {
          let blanks = 0;
          for (const i of rows) if (isBlank(this.model.rows[i]![idx] ?? null)) blanks++;
          return blanks;
        }
        const nums: number[] = [];
        for (const i of rows) {
          const v = this.model.rows[i]![idx] ?? null;
          if (!isBlank(v)) nums.push(numOf(v, name));
        }
        if (name === "PRODUCT") return nums.length ? nums.reduce((a, b) => a * b, 1) : null;
        if (!nums.length) return null;
        if (name === "MEDIAN") {
          const s = [...nums].sort((a, b) => a - b);
          const mid = Math.floor(s.length / 2);
          return s.length % 2 ? s[mid]! : (s[mid! - 1]! + s[mid]!) / 2;
        }
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        if (name === "VAR.P") return nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
        if (name === "VAR.S")
          return nums.length > 1 ? nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1) : null;
        const varP = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
        if (name === "STDEV.P") return Math.sqrt(varP);
        // STDEV.S: sample stdev (n-1 denominator); needs ≥ 2 values.
        return nums.length > 1 ? Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1)) : null;
      }
      // -- logic --------------------------------------------------------------
      case "TOTALYTD":
      case "TOTALQTD":
      case "TOTALMTD":
        return this.totalYtdLike(name, expr, fc, rc);
      case "IF":
        return truthy(arg(0)) ? arg(1) : args.length > 2 ? arg(2) : null;
      case "SWITCH": {
        const v = arg(0);
        for (let i = 1; i + 1 < args.length; i += 2) {
          if (daxEquals(v, this.eval(args[i]!, fc, rc))) return arg(i + 1);
        }
        return args.length % 2 === 0 ? arg(args.length - 1) : null;
      }
      case "AND":
        return truthy(arg(0)) && truthy(arg(1));
      case "OR":
        return truthy(arg(0)) || truthy(arg(1));
      case "NOT":
        return !truthy(arg(0));
      case "ISBLANK":
        return isBlank(arg(0));
      // -- maths --------------------------------------------------------------
      case "DIVIDE": {
        const num = arg(0);
        const den = arg(1);
        const d = isBlank(den) ? 0 : numOf(den, "DIVIDE");
        if (d === 0) return args.length > 2 ? arg(2) : null;
        return numOf(num, "DIVIDE") / d;
      }
      case "XOR":
        return truthy(arg(0)) !== truthy(arg(1));
      case "COALESCE": {
        for (let i = 0; i < args.length; i++) {
          const v = arg(i);
          if (!isBlank(v)) return v;
        }
        return null;
      }
      case "LOOKUPVALUE": {
        // LOOKUPVALUE(resultCol, searchCol, searchValue [, searchCol2, val2 …])
        // First matching row wins; no match (or a BLANK result) → alternate or BLANK.
        const resultCol = expectColumnRef(args[0]!);
        const resIdx = this.colIdxOrThrow(resultCol);
        const pairs: { col: string; value: DaxValue }[] = [];
        for (let i = 1; i + 1 < args.length; i += 2) {
          pairs.push({ col: expectColumnRef(args[i]!), value: arg(i + 1) });
        }
        if (!pairs.length) throw new DaxError("LOOKUPVALUE needs at least one search column/value pair.");
        for (const row of this.model.rows) {
          let match = true;
          for (const p of pairs) {
            const idx = this.colIndex.get(p.col);
            if (idx === undefined) throw new DaxError(`Column “[${p.col}]” not found.`);
            if (!daxEquals(row[idx] ?? null, p.value)) {
              match = false;
              break;
            }
          }
          if (match) {
            const v = row[resIdx] ?? null;
            if (!isBlank(v)) return v;
          }
        }
        // LOOKUPVALUE(result, s1, v1 [, s2, v2 …] [, alternate]): the alternate
        // is present when the arg count is even (result + pairs + alternate).
        return args.length % 2 === 0 && args.length >= 4 ? arg(args.length - 1) : null;
      }
      case "ISNUMBER":
        return (
          typeof arg(0) === "number" ||
          (typeof arg(0) === "string" && String(arg(0)).trim() !== "" && Number.isFinite(Number(arg(0))))
        );
      case "ISTEXT":
        return typeof arg(0) === "string";
      case "ISLOGICAL":
        return typeof arg(0) === "boolean";
      // -- existence / membership ----------------------------------------------
      case "ISEMPTY": {
        // ISEMPTY(tableExpr) — TRUE when the table expression has no rows in
        // the current filter context.
        const t = this.evalTable(args[0]!, fc, rc);
        return t.rowIdx.length === 0;
      }
      case "CONTAINS": {
        // CONTAINS(table, col, value [, col2, value2 …]) — TRUE when at least
        // one row of the table matches ALL the column/value pairs.
        const t = this.evalTable(args[0]!, fc, rc);
        const pairs: { col: string; value: DaxValue }[] = [];
        for (let i = 1; i + 1 < args.length; i += 2) {
          pairs.push({ col: expectColumnRef(args[i]!), value: arg(i + 1) });
        }
        if (!pairs.length) throw new DaxError("CONTAINS needs at least one column/value pair.");
        for (const rowIdx of t.rowIdx) {
          let match = true;
          for (const p of pairs) {
            if (!daxEquals(this.cell(rowIdx, p.col), p.value)) {
              match = false;
              break;
            }
          }
          if (match) return true;
        }
        return false;
      }
      // -- maths ---------------------------------------------------------------
      case "ABS":
        return Math.abs(numOf(arg(0), "ABS"));
      case "ROUND": {
        const f = Math.pow(10, args[1] ? numOf(arg(1), "ROUND digits") : 0);
        return Math.round(numOf(arg(0), "ROUND") * f) / f;
      }
      case "ROUNDUP": {
        const f = Math.pow(10, args[1] ? numOf(arg(1), "ROUNDUP digits") : 0);
        return (
          (numOf(arg(0), "ROUNDUP") * f >= 0
            ? Math.ceil(numOf(arg(0), "ROUNDUP") * f)
            : Math.floor(numOf(arg(0), "ROUNDUP") * f)) / f
        );
      }
      case "ROUNDDOWN":
      case "TRUNC": {
        const f = Math.pow(10, args[1] ? numOf(arg(1), "ROUNDDOWN digits") : 0);
        return Math.trunc(numOf(arg(0), "ROUNDDOWN") * f) / f;
      }
      case "INT":
        return Math.floor(numOf(arg(0), "INT"));
      case "MOD": {
        const d = numOf(arg(1), "MOD");
        if (d === 0) throw new DaxError("MOD: divisor must not be zero.");
        const a = numOf(arg(0), "MOD");
        return ((a % d) + d) % d; // DAX MOD keeps the divisor's sign
      }
      case "SIGN":
        return Math.sign(numOf(arg(0), "SIGN"));
      case "FLOOR": {
        const f = args[1] ? numOf(arg(1), "FLOOR significance") : 1;
        if (f === 0) return 0;
        return Math.floor(numOf(arg(0), "FLOOR") / f) * f;
      }
      case "CEILING": {
        const f = args[1] ? numOf(arg(1), "CEILING significance") : 1;
        if (f === 0) return 0;
        return Math.ceil(numOf(arg(0), "CEILING") / f) * f;
      }
      case "SQRT": {
        const v = numOf(arg(0), "SQRT");
        if (v < 0) throw new DaxError("SQRT of a negative number is an error in DAX.");
        return Math.sqrt(v);
      }
      case "POWER":
        return Math.pow(numOf(arg(0), "POWER"), numOf(arg(1), "POWER"));
      case "EXP":
        return Math.exp(numOf(arg(0), "EXP"));
      case "LN": {
        const v = numOf(arg(0), "LN");
        if (v <= 0) throw new DaxError("LN requires a positive number.");
        return Math.log(v);
      }
      case "LOG": {
        const v = numOf(arg(0), "LOG");
        const base = args[1] ? numOf(arg(1), "LOG base") : 10;
        if (v <= 0 || base <= 0 || base === 1)
          throw new DaxError("LOG requires a positive number and a positive base ≠ 1.");
        return Math.log(v) / Math.log(base);
      }
      case "PI":
        return Math.PI;
      // -- text ----------------------------------------------------------------
      case "LEN":
        return String(arg(0) ?? "").length;
      case "LEFT":
        return String(arg(0) ?? "").slice(0, args[1] ? Math.max(0, Math.trunc(numOf(arg(1), "LEFT"))) : 1);
      case "RIGHT": {
        const s = String(arg(0) ?? "");
        const n = args[1] ? Math.max(0, Math.trunc(numOf(arg(1), "RIGHT"))) : 1;
        return n === 0 ? "" : s.slice(-n);
      }
      case "MID": {
        const s = String(arg(0) ?? "");
        const start = Math.max(1, Math.trunc(numOf(arg(1), "MID start")));
        const n = Math.max(0, Math.trunc(numOf(arg(2), "MID length")));
        return s.substr(start - 1, n);
      }
      case "UPPER":
        return String(arg(0) ?? "").toUpperCase();
      case "LOWER":
        return String(arg(0) ?? "").toLowerCase();
      case "TRIM":
        return String(arg(0) ?? "")
          .trim()
          .replace(/\s+/g, " ");
      case "CONCATENATE":
        return `${arg(0) ?? ""}${arg(1) ?? ""}`;
      case "SUBSTITUTE": {
        const s = String(arg(0) ?? "");
        const oldS = String(arg(1) ?? "");
        const newS = String(arg(2) ?? "");
        if (oldS === "") return s;
        if (!args[3]) return s.split(oldS).join(newS);
        // Replace ONLY the nth occurrence (DAX instance_num, 1-based).
        const n = Math.trunc(numOf(arg(3), "SUBSTITUTE instance"));
        const parts = s.split(oldS);
        if (n < 1 || n >= parts.length) return s;
        return parts.map((p, i) => (i === 0 ? p : i === n ? newS + p : oldS + p)).join("");
      }
      case "CONTAINSSTRING":
        return String(arg(1) ?? "").length === 0 || String(arg(0) ?? "").includes(String(arg(1) ?? ""));
      case "CONCATENATEX": {
        const t = this.evalTable(args[0]!, fc, rc);
        const parts: string[] = [];
        for (const rowIdx of t.rowIdx) {
          const v = this.eval(args[1]!, fc, { rowIdx, transitionColumns: t.column ? [t.column] : null });
          if (!isBlank(v)) parts.push(String(v));
        }
        const delim = args[2] ? String(arg(2)) : "";
        return parts.join(delim);
      }
      case "BLANK":
        return null;
      default:
        throw new DaxError(`Function ${name}() is not supported. See SUPPORTED_DAX_FUNCTIONS for the full list.`);
    }
  }

  /** TOTALYTD(expr, dateCol) = CALCULATE(expr, DATESYTD(dateCol)) */
  private totalYtdLike(fn: string, expr: Extract<Expr, { k: "func" }>, fc: FilterCtx, rc: RowCtx | null): DaxValue {
    const valueExpr = expr.args[0]!;
    const kind = fn.replace("TOTAL", "DATES"); // TOTALYTD -> DATESYTD
    const inner: FilterCtx = new Map(fc);
    this.applyFilterArg(inner, { k: "func", name: kind, args: expr.args.slice(1) }, fc, rc);
    return this.eval(valueExpr, inner, null);
  }
}

// TOTALYTD family routed through evalFunc via a small shim below.

function expectColumnRef(expr: Expr): string {
  if (expr.k !== "col") throw new DaxError(`Expected a column reference like [Column].`);
  // 'Table'[Column] materializes as the qualified column "Table.Column"; an
  // unqualified [Column] stays plain and resolves through the model's aliases.
  return expr.table && expr.table.length > 0 ? `${expr.table}.${expr.name}` : expr.name;
}

function truthy(v: DaxValue): boolean {
  return v === true || (typeof v === "number" && v !== 0) || (typeof v === "string" && v !== "");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateMeasure(dax: string): string[] {
  const errors: string[] = [];
  try {
    const ast = new Parser(tokenize(dax)).parseExpr();
    // Walk for obviously-invalid constructs without a model.
    const walk = (e: Expr): void => {
      if (e.k === "func") {
        for (const a of e.args) walk(a);
      } else if (e.k === "bin") {
        walk(e.l);
        walk(e.r);
      } else if (e.k === "un") walk(e.e);
    };
    walk(ast);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return errors;
}

/**
 * Evaluate a DAX measure against a model with an optional incoming filter.
 * `filters` map column -> allowed values (empty array means "no rows match",
 * omit the column entirely for no filter).
 */
export function evaluateMeasure(model: DaxModel, dax: string, filters: DaxFilter[] = []): DaxValue {
  if (!model.rows.length) return null;
  const ast = new Parser(tokenize(dax)).parseExpr();
  const ev = new Evaluator(model);
  const fc: FilterCtx = new Map();
  for (const f of filters) {
    fc.set(f.column, f.values === null ? null : new Set(f.values));
  }
  // Handle TOTAL* family at top level.
  if (ast.k === "func" && ast.name.startsWith("TOTAL")) {
    const kind = ast.name.replace("TOTAL", "DATES");
    const inner: FilterCtx = new Map(fc);
    ev.applyFilterArg(inner, { k: "func", name: kind, args: ast.args.slice(1) }, fc, null);
    return ev.eval(ast.args[0]!, inner, null);
  }
  return ev.eval(ast, fc, null);
}

/** Evaluate a measure broken out by one column (matrix / chart series). */
export function evaluateMeasureByCategory(
  model: DaxModel,
  dax: string,
  categoryColumn: string,
  filters: DaxFilter[] = [],
): { category: string; value: DaxValue }[] {
  const ev = new Evaluator(model);
  const idx = ev.colIdxOrThrow(categoryColumn);
  const categories: string[] = [];
  const seen = new Set<string>();
  for (const row of model.rows) {
    const v = row[idx] ?? null;
    const key = isBlank(v) ? "" : String(v);
    if (!seen.has(key)) {
      seen.add(key);
      categories.push(key);
    }
  }
  return categories.map((category) => ({
    category,
    value: evaluateMeasure(model, dax, [...filters, { column: categoryColumn, values: [category] }]),
  }));
}

/** List supported functions for UI autocomplete. */
export const SUPPORTED_DAX_FUNCTIONS: string[] = [
  // Aggregations & iterators
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTROWS",
  "DISTINCTCOUNT",
  "DISTINCTCOUNTNOBLANK",
  "SUMX",
  "AVERAGEX",
  "MINX",
  "MAXX",
  "COUNTX",
  "RANKX",
  "CONCATENATEX",
  // Statistics
  "MEDIAN",
  "PRODUCT",
  "COUNTBLANK",
  "STDEV.P",
  "STDEV.S",
  "VAR.P",
  "VAR.S",
  // Filter & tables
  "CALCULATE",
  "CALCULATETABLE",
  "FILTER",
  "ALL",
  "ALLEXCEPT",
  "VALUES",
  "SELECTEDVALUE",
  "HASONEVALUE",
  "TOPN",
  "TREATAS",
  "LOOKUPVALUE",
  "RELATED",
  // Table construction & transformation
  "SUMMARIZE",
  "ADDCOLUMNS",
  "SELECTCOLUMNS",
  "GROUPBY",
  "CROSSJOIN",
  "GENERATE",
  "GENERATEALL",
  "NATURALINNERJOIN",
  "NATURALLEFTOUTERJOIN",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "ROW",
  "DATATABLE",
  // Variables & logic
  "VAR",
  "RETURN",
  "IF",
  "SWITCH",
  "AND",
  "OR",
  "NOT",
  "XOR",
  "COALESCE",
  "ISBLANK",
  "IN",
  "ISNUMBER",
  "ISTEXT",
  "ISLOGICAL",
  // Maths
  "DIVIDE",
  "ABS",
  "ROUND",
  "ROUNDUP",
  "ROUNDDOWN",
  "TRUNC",
  "INT",
  "MOD",
  "SIGN",
  "FLOOR",
  "CEILING",
  "SQRT",
  "POWER",
  "EXP",
  "LN",
  "LOG",
  "PI",
  "BLANK",
  // Text
  "LEN",
  "LEFT",
  "RIGHT",
  "MID",
  "UPPER",
  "LOWER",
  "TRIM",
  "CONCATENATE",
  "SUBSTITUTE",
  "CONTAINSSTRING",
  // Time intelligence
  "TOTALYTD",
  "TOTALQTD",
  "TOTALMTD",
  "DATESYTD",
  "DATESQTD",
  "DATESMTD",
  "SAMEPERIODLASTYEAR",
  "DATEADD",
  "PARALLELPERIOD",
  "PREVIOUSMONTH",
  "PREVIOUSQUARTER",
  "PREVIOUSYEAR",
  "NEXTDAY",
  "NEXTMONTH",
  "NEXTQUARTER",
  "NEXTYEAR",
  "DATESBETWEEN",
  "DATESINPERIOD",
  "FIRSTDATE",
  "LASTDATE",
  "STARTOFMONTH",
  "STARTOFQUARTER",
  "STARTOFYEAR",
  "ENDOFMONTH",
  "ENDOFQUARTER",
  "ENDOFYEAR",
  "ISEMPTY",
  "CONTAINS",
];
