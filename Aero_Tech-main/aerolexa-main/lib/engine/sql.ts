/**
 * Prototype SQL engine for the SQL Lab.
 *
 * Executes a deliberately small, read-only subset of SQL against the selected
 * dataset's row stream. It is NOT a live database: the prototype has no real
 * PostgreSQL/SQLite query path, so every result is computed here
 * deterministically and labelled with the "Prototype / Demo" engine note.
 *
 * Supported grammar:
 *   SELECT <expr|agg> [, ...] | * FROM <dataset>
 *   [WHERE <cond>]              (=, !=, <>, <, <=, >, >=, IS [NOT] NULL, AND,
 *                                OR, NOT, parens, + - * / % on numbers)
 *   [GROUP BY <column> [, ...]] (COUNT(*|col), SUM, AVG, MIN, MAX)
 *   [ORDER BY <ordinal|alias|expr> [ASC|DESC]]
 *   [LIMIT <n>]
 *
 * Security limits (enforced here AND in the route):
 *  - the first token must be SELECT; DDL/DML keywords are rejected outright,
 *  - only one statement is allowed (trailing `;` is tolerated),
 *  - result rows are capped at the caller's rowCap (default 5000).
 *
 * Dependency-free + unit-tested (__tests__/unit/sql.test.ts).
 */

import type { ColType, SqlColumn, SqlResultSet, SqlValue } from "@/lib/types";

export class SqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlError";
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: "word"; raw: string } // raw casing preserved; comparisons use upper
  | { kind: "number"; value: number; raw: string }
  | { kind: "string"; value: string; raw: string }
  | { kind: "symbol"; value: string; raw: string };

/** Export the tokenizer so the DuckDB engines can run the same read-only guard. */
export function tokenizeSql(input: string): Token[] {
  return tokenize(input);
}

/**
 * Lightweight read-only guard used by the DuckDB engines BEFORE execution.
 * Unlike the full parser, it deliberately does NOT restrict expression grammar
 * (CASE, LIKE, HAVING, joins… are all fine for DuckDB) — it only rejects
 * DDL/DML, non-SELECT starts and multiple statements.
 */
export function assertReadOnlySql(sql: string): void {
  const tokens = tokenize(sql);
  if (tokens.length === 0) throw new SqlError("The query is empty.");
  const first = tokens[0];
  if (!(first && first.kind === "word" && first.raw.toUpperCase() === "SELECT")) {
    throw new SqlError(`Only read-only SELECT queries are supported (found “${first ? first.raw : "end of query"}”).`);
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.kind === "word" && FORBIDDEN.has(t.raw.toUpperCase())) {
      throw new SqlError(`“${t.raw}” is not allowed — the SQL lab runs read-only SELECT queries only.`);
    }
    // Reject statement separators that leave trailing tokens (`;` alone at the
    // end is tolerated) — one SELECT per query, exactly like the parser.
    if (t.kind === "symbol" && t.value === ";" && i < tokens.length - 1) {
      throw new SqlError("One SELECT per query — multiple statements are not allowed.");
    }
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < n) {
    const c = input[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && input[i + 1] === "-") {
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && input[i + 1] === "*") {
      const end = input.indexOf("*/", i + 2);
      if (end < 0) throw new SqlError("Unterminated /* comment in the query.");
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      let out = "";
      while (j < n && input[j] !== close) {
        if (input[j] === "\\" && j + 1 < n) {
          out += input[j + 1];
          j += 2;
        } else {
          out += input[j];
          j++;
        }
      }
      if (j >= n) throw new SqlError(`Unterminated quoted identifier in the query.`);
      tokens.push({ kind: "word", raw: out });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let out = "";
      let closed = false;
      while (j < n) {
        if (input[j] === "\\" && j + 1 < n) {
          out += input[j + 1];
          j += 2;
        } else if (input[j] === "'") {
          if (input[j + 1] === "'") {
            out += "'";
            j += 2;
          } else {
            closed = true;
            j++;
            break;
          }
        } else {
          out += input[j];
          j++;
        }
      }
      if (!closed) throw new SqlError("Unterminated string literal in the query.");
      tokens.push({ kind: "string", value: out, raw: `'${out}'` });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(input[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9.]/.test(input[j] as string)) j++;
      const raw = input.slice(i, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new SqlError(`Invalid number literal “${raw}”.`);
      tokens.push({ kind: "number", value, raw });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(input[j] as string)) j++;
      tokens.push({ kind: "word", raw: input.slice(i, j) });
      i = j;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === "!=" || two === "<>" || two === "<=" || two === ">=" || two === "||") {
      tokens.push({ kind: "symbol", value: two, raw: two });
      i += 2;
      continue;
    }
    // `.` and `:` cover qualified names (a.id) and DuckDB `::` casts — both
    // are valid in the read-only SELECTs the DuckDB engines accept.
    if (",()=<>+-*/%;.:".includes(c)) {
      tokens.push({ kind: "symbol", value: c, raw: c });
      i++;
      continue;
    }
    throw new SqlError(`Unexpected character “${c}” in the query.`);
  }
  return tokens;
}

const FORBIDDEN = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "CREATE",
  "ALTER",
  "TRUNCATE",
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "REINDEX",
  "VACUUM",
  "EXPLAIN",
  "INTO",
  "VALUES",
  "SET",
  "GRANT",
  "REVOKE",
  "COPY",
  "MERGE",
  "REPLACE",
  "UPSERT",
]);

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "col"; name: string }
  | { kind: "ordinal"; value: number }
  | { kind: "bin"; op: string; left: Expr; right: Expr }
  | { kind: "not"; expr: Expr }
  | { kind: "isnull"; expr: Expr; negated: boolean }
  | { kind: "agg"; fn: "COUNT" | "SUM" | "AVG" | "MIN" | "MAX"; arg: Expr | null };

interface SelectItem {
  expr: Expr;
  alias: string | null;
}
interface Query {
  items: SelectItem[];
  where: Expr | null;
  groupBy: string[];
  orderBy: { expr: Expr; desc: boolean }[];
  limit: number | null;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new SqlError("The query ended unexpectedly.");
    this.pos++;
    return t;
  }
  private kw(word: string): boolean {
    const t = this.peek();
    return !!t && t.kind === "word" && t.raw.toUpperCase() === word;
  }
  private sym(s: string): boolean {
    const t = this.peek();
    return !!t && t.kind === "symbol" && t.value === s;
  }
  private eatKw(word: string): void {
    if (!this.kw(word)) throw new SqlError(`Expected keyword ${word}.`);
    this.next();
  }
  private eatSym(s: string): void {
    if (!this.sym(s)) {
      const t = this.peek();
      throw new SqlError(`Expected “${s}” but found “${t ? t.raw : "end of query"}”.`);
    }
    this.next();
  }

  parse(): Query {
    const first = this.tokens[0];
    if (!first) throw new SqlError("The query is empty.");
    if (first.kind === "word" && FORBIDDEN.has(first.raw.toUpperCase())) {
      throw new SqlError(`“${first.raw}” is not allowed — the SQL lab runs read-only SELECT queries only.`);
    }
    if (!(first.kind === "word" && first.raw.toUpperCase() === "SELECT")) {
      throw new SqlError(`Only read-only SELECT queries are supported (found “${first.raw}”).`);
    }
    for (const t of this.tokens) {
      if (t.kind === "word" && FORBIDDEN.has(t.raw.toUpperCase())) {
        throw new SqlError(`“${t.raw}” is not allowed in the SQL lab (read-only SELECT only).`);
      }
    }
    this.next(); // SELECT

    const items: SelectItem[] = [];
    if (this.sym("*")) {
      this.next();
      items.push({ expr: { kind: "star" } as unknown as Expr, alias: null });
    } else {
      for (;;) {
        const expr = this.parseExpr();
        let alias: string | null = null;
        if (this.kw("AS")) {
          this.next();
          alias = this.expectName();
        } else {
          const t = this.peek();
          if (t && t.kind === "word" && !this.isClauseKeyword()) {
            alias = this.next().raw;
          }
        }
        items.push({ expr, alias });
        if (this.sym(",")) {
          this.next();
          continue;
        }
        break;
      }
    }

    this.eatKw("FROM");
    this.expectName(); // table name is informational — the caller binds the dataset

    let where: Expr | null = null;
    if (this.kw("WHERE")) {
      this.next();
      where = this.parseExpr();
    }

    const groupBy: string[] = [];
    if (this.kw("GROUP")) {
      this.next();
      this.eatKw("BY");
      for (;;) {
        groupBy.push(this.expectName());
        if (this.sym(",")) {
          this.next();
          continue;
        }
        break;
      }
    }

    const orderBy: { expr: Expr; desc: boolean }[] = [];
    if (this.kw("ORDER")) {
      this.next();
      this.eatKw("BY");
      for (;;) {
        const expr = this.parseOrderItem();
        let desc = false;
        if (this.kw("ASC")) this.next();
        else if (this.kw("DESC")) {
          this.next();
          desc = true;
        }
        orderBy.push({ expr, desc });
        if (this.sym(",")) {
          this.next();
          continue;
        }
        break;
      }
    }

    let limit: number | null = null;
    if (this.kw("LIMIT")) {
      this.next();
      const t = this.next();
      if (t.kind !== "number" || !Number.isInteger(t.value) || t.value < 0) {
        throw new SqlError("LIMIT must be a whole number ≥ 0.");
      }
      limit = t.value;
    }

    if (this.sym(";")) this.next();
    if (this.pos < this.tokens.length) {
      throw new SqlError(`Unexpected “${this.tokens[this.pos]!.raw}” after the statement — one SELECT per query.`);
    }
    return { items, where, groupBy, orderBy, limit };
  }

  private isClauseKeyword(): boolean {
    const t = this.peek();
    if (!t || t.kind !== "word") return false;
    return ["FROM", "WHERE", "GROUP", "ORDER", "LIMIT", "AS"].includes(t.raw.toUpperCase());
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== "word") throw new SqlError(`Expected a name but found “${t.raw}”.`);
    return t.raw;
  }

  /** ORDER BY item: ordinal, bare name (alias or column) or full expression. */
  private parseOrderItem(): Expr {
    const t = this.peek();
    if (t && t.kind === "number") {
      this.next();
      return { kind: "ordinal", value: t.value };
    }
    if (t && t.kind === "word" && !this.isClauseKeyword() && !["ASC", "DESC"].includes(t.raw.toUpperCase())) {
      // bare name — resolve as alias during evaluation
      this.next();
      return { kind: "col", name: t.raw };
    }
    return this.parseExpr();
  }

  private parseExpr(): Expr {
    return this.parseOr();
  }
  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.kw("OR")) {
      this.next();
      left = { kind: "bin", op: "OR", left, right: this.parseAnd() };
    }
    return left;
  }
  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.kw("AND")) {
      this.next();
      left = { kind: "bin", op: "AND", left, right: this.parseNot() };
    }
    return left;
  }
  private parseNot(): Expr {
    if (this.kw("NOT")) {
      this.next();
      return { kind: "not", expr: this.parseNot() };
    }
    return this.parseComparison();
  }
  private parseComparison(): Expr {
    const left = this.parseAdditive();
    const t = this.peek();
    if (t && t.kind === "symbol" && ["=", "!=", "<>", "<", "<=", ">", ">="].includes(t.value)) {
      this.next();
      return { kind: "bin", op: t.value, left, right: this.parseAdditive() };
    }
    if (this.kw("IS")) {
      this.next();
      let negated = false;
      if (this.kw("NOT")) {
        this.next();
        negated = true;
      }
      if (!this.kw("NULL")) throw new SqlError("Expected NULL after IS [NOT].");
      this.next();
      return { kind: "isnull", expr: left, negated };
    }
    return left;
  }
  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === "symbol" && (t.value === "+" || t.value === "-")) {
        this.next();
        left = { kind: "bin", op: t.value, left, right: this.parseMultiplicative() };
      } else break;
    }
    return left;
  }
  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === "symbol" && (t.value === "*" || t.value === "/" || t.value === "%")) {
        this.next();
        left = { kind: "bin", op: t.value, left, right: this.parseUnary() };
      } else break;
    }
    return left;
  }
  private parseUnary(): Expr {
    const t = this.peek();
    if (t && t.kind === "symbol" && (t.value === "-" || t.value === "+")) {
      this.next();
      const inner = this.parseUnary();
      if (t.value === "-") return { kind: "bin", op: "UMINUS", left: { kind: "num", value: 0 }, right: inner };
      return inner;
    }
    return this.parsePrimary();
  }
  private parsePrimary(): Expr {
    const t = this.next();
    if (t.kind === "number") return { kind: "num", value: t.value };
    if (t.kind === "string") return { kind: "str", value: t.value };
    if (t.kind === "symbol" && t.value === "(") {
      const inner = this.parseExpr();
      this.eatSym(")");
      return inner;
    }
    if (t.kind === "symbol" && t.value === "-") {
      return { kind: "bin", op: "UMINUS", left: { kind: "num", value: 0 }, right: this.parseUnary() };
    }
    if (t.kind === "word") {
      const up = t.raw.toUpperCase();
      if (up === "TRUE") return { kind: "bool", value: true };
      if (up === "FALSE") return { kind: "bool", value: false };
      if (up === "NULL") return { kind: "null" };
      if (["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(up)) {
        this.eatSym("(");
        let arg: Expr | null = null;
        if (this.sym("*")) {
          this.next();
          if (up !== "COUNT") throw new SqlError(`Only COUNT(*) is supported — ${up}(*) is not valid.`);
        } else {
          arg = this.parseExpr();
        }
        this.eatSym(")");
        return { kind: "agg", fn: up as "COUNT", arg };
      }
      return { kind: "col", name: t.raw };
    }
    throw new SqlError(`Unexpected “${t.raw}” in the query.`);
  }
}

// ---------------------------------------------------------------------------
// Evaluation helpers
// ---------------------------------------------------------------------------

export interface SqlSource {
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
}

type Value = SqlValue;

function colIndex(cols: { name: string }[], name: string): number {
  const exact = cols.findIndex((c) => c.name === name);
  if (exact >= 0) return exact;
  // Case-insensitive fallback for bare (unquoted) column references.
  const lower = name.toLowerCase();
  const found = cols.findIndex((c) => c.name.toLowerCase() === lower);
  return found;
}

function toNum(v: Value): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === undefined) return Number.NaN;
  const s = String(v).replace(/[,$\s%€£]/g, "");
  if (s === "") return Number.NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

function toBool(v: Value): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).toLowerCase();
  if (["true", "yes", "1", "y"].includes(s)) return true;
  if (["false", "no", "0", "n", ""].includes(s)) return false;
  return s.length > 0;
}

function cmp(a: Value, b: Value): number {
  const aNum = typeof a === "number" || typeof a === "boolean";
  const bNum = typeof b === "number" || typeof b === "boolean";
  if (aNum && bNum) {
    const x = toNum(a);
    const y = toNum(b);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

interface EvalCtx {
  /** current row, or null when evaluating aggregates over a whole set */
  row: Value[] | null;
  cols: { name: string }[];
  /** alias name → output position (1-based) */
  aliasPos: Map<string, number>;
  useAlias: boolean;
  agg: Map<string, Value> | null;
}

function evalExpr(expr: Expr, ctx: EvalCtx): Value {
  switch (expr.kind) {
    case "num":
    case "bool":
      return expr.kind === "num" ? (expr as { value: number }).value : (expr as { value: boolean }).value ? 1 : 0;
    case "str":
      return expr.value;
    case "null":
      return null;
    case "ordinal":
      return ctx.agg ? (ctx.agg.get(`ord${expr.value}`) ?? null) : null;
    case "col": {
      // Source columns win; aliases only resolve when no real column exists
      // (they are also resolved directly by ORDER BY against the output row).
      const idx = colIndex(ctx.cols, expr.name);
      if (idx >= 0) return ctx.row ? (ctx.row[idx] ?? null) : null;
      if (ctx.useAlias) {
        const pos = ctx.aliasPos.get(expr.name);
        if (pos !== undefined) {
          const v = ctx.agg ? (ctx.agg.get(`out${pos}`) ?? null) : ctx.row ? (ctx.row[pos - 1] ?? null) : null;
          if (v !== null && v !== undefined) return v;
        }
      }
      throw new SqlError(`Unknown column “${expr.name}”.`);
    }
    case "isnull": {
      const v = evalExpr(expr.expr, ctx);
      return expr.negated ? v !== null && v !== undefined : v === null || v === undefined;
    }
    case "not":
      return toBool(evalExpr(expr.expr, ctx)) ? 0 : 1;
    case "bin": {
      if (expr.op === "AND") return toBool(evalExpr(expr.left, ctx)) && toBool(evalExpr(expr.right, ctx)) ? 1 : 0;
      if (expr.op === "OR") return toBool(evalExpr(expr.left, ctx)) || toBool(evalExpr(expr.right, ctx)) ? 1 : 0;
      if (expr.op === "UMINUS") return -toNum(evalExpr(expr.right, ctx));
      const l = evalExpr(expr.left, ctx);
      const r = evalExpr(expr.right, ctx);
      switch (expr.op) {
        case "+":
          return toNum(l) + toNum(r);
        case "-":
          return toNum(l) - toNum(r);
        case "*":
          return toNum(l) * toNum(r);
        case "/":
          return toNum(r) === 0 ? null : toNum(l) / toNum(r);
        case "%":
          return toNum(r) === 0 ? null : toNum(l) % toNum(r);
        case "=":
          if (l === null || l === undefined || r === null || r === undefined) return null;
          return cmp(l, r) === 0 ? 1 : 0;
        case "!=":
        case "<>":
          if (l === null || l === undefined || r === null || r === undefined) return null;
          return cmp(l, r) !== 0 ? 1 : 0;
        case "<":
          if (l === null || r === null) return null;
          return cmp(l, r) < 0 ? 1 : 0;
        case "<=":
          if (l === null || r === null) return null;
          return cmp(l, r) <= 0 ? 1 : 0;
        case ">":
          if (l === null || r === null) return null;
          return cmp(l, r) > 0 ? 1 : 0;
        case ">=":
          if (l === null || r === null) return null;
          return cmp(l, r) >= 0 ? 1 : 0;
        default:
          throw new SqlError(`Operator “${expr.op}” is not supported yet.`);
      }
    }
    case "agg": {
      if (!ctx.agg) throw new SqlError(`${expr.fn}() can only appear in the SELECT list.`);
      return ctx.agg.get(`${expr.fn}(${aggKey(expr.arg)})`) ?? null;
    }
    default:
      throw new SqlError("This expression form is not supported yet.");
  }
}

/** Stable key for aggregate arguments so WHERE/GROUP contexts agree. */
function aggKey(arg: Expr | null): string {
  if (!arg) return "*";
  if (arg.kind === "col") return `col:${arg.name}`;
  return `expr:${JSON.stringify(arg)}`;
}

function hasAgg(expr: Expr): boolean {
  if (expr.kind === "agg") return true;
  if (expr.kind === "bin") return hasAgg(expr.left) || hasAgg(expr.right);
  if (expr.kind === "not" || expr.kind === "isnull") return hasAgg(expr.expr);
  return false;
}

function collectCols(expr: Expr, out: Set<string>): void {
  if (expr.kind === "col") out.add(expr.name);
  else if (expr.kind === "bin") {
    collectCols(expr.left, out);
    collectCols(expr.right, out);
  } else if (expr.kind === "not" || expr.kind === "isnull") collectCols(expr.expr, out);
  else if (expr.kind === "agg" && expr.arg) collectCols(expr.arg, out);
}

function runAgg(fn: string, rows: Value[][], arg: Expr | null, cols: { name: string }[]): Value {
  if (fn === "COUNT") return rows.length;
  const nums: number[] = [];
  for (const row of rows) {
    const ctx: EvalCtx = { row, cols, aliasPos: new Map(), useAlias: false, agg: null };
    let v: Value;
    if (arg) {
      if (arg.kind === "col") {
        const idx = colIndex(cols, (arg as { name: string }).name);
        if (idx < 0) throw new SqlError(`Unknown column “${(arg as { name: string }).name}”.`);
        v = row[idx] ?? null;
      } else {
        v = evalExpr(arg, ctx);
      }
    } else {
      v = 1;
    }
    if (fn === "COUNT") continue;
    const num = toNum(v);
    if (Number.isFinite(num)) nums.push(num);
  }
  if (fn === "SUM") return nums.reduce((a, b) => a + b, 0);
  if (fn === "AVG") return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  if (fn === "MIN") return nums.length ? Math.min(...nums) : null;
  if (fn === "MAX") return nums.length ? Math.max(...nums) : null;
  return null;
}

function inferType(values: Value[]): ColType {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (!present.length) return "string";
  if (present.every((v) => typeof v === "number")) return "number";
  if (present.every((v) => typeof v === "boolean")) return "boolean";
  return "string";
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export interface ExecuteOptions {
  rowCap?: number;
}

export function executeSql(source: SqlSource, sql: string, opts: ExecuteOptions = {}): SqlResultSet {
  const started = Date.now();
  const rowCap = Math.max(1, opts.rowCap ?? 5000);
  // --- CTE expansion (pre-processing) ---
  const { transformedSql, cteColumns } = expandCtes(sql, source);
  const cols = source.columns;

  // --- Run the (possibly transformed) query through the prototype parser ---
  const tokens = tokenize(transformedSql);
  const query = new Parser(tokens).parse();

  // Expand `*` into explicit column items.
  const items: SelectItem[] = [];
  for (const item of query.items) {
    if ((item.expr as { kind?: string }).kind === "star") {
      for (const c of cols) items.push({ expr: { kind: "col", name: c.name }, alias: c.name });
    } else {
      items.push(item);
    }
  }
  if (items.length === 0) throw new SqlError("SELECT needs at least one column.");

  // Default aliases for output headers.
  items.forEach((item, i) => {
    if (item.alias) return;
    if (item.expr.kind === "col") item.alias = item.expr.name;
    else if (item.expr.kind === "agg") {
      const fn = item.expr.fn.toLowerCase();
      const argName = item.expr.arg && item.expr.arg.kind === "col" ? item.expr.arg.name : "*";
      item.alias = `${fn}(${argName === "*" ? "*" : `"${argName}"`})`;
    } else item.alias = `col_${i + 1}`;
  });

  const aliasPos = new Map<string, number>();
  items.forEach((item, i) => aliasPos.set(item.alias ?? "", i + 1));

  // Column existence checks.
  const validateCols = (expr: Expr | null, allowAgg: boolean, label: string) => {
    if (!expr) return;
    if (!allowAgg && hasAgg(expr)) throw new SqlError(`Aggregates are not allowed in ${label}.`);
    const names = new Set<string>();
    collectCols(expr, names);
    for (const name of names) {
      if (colIndex(cols, name) < 0) throw new SqlError(`Unknown column “${name}”.`);
    }
  };
  for (const item of items) validateCols(item.expr, true, "the SELECT list");
  validateCols(query.where, false, "WHERE");
  for (const g of query.groupBy) {
    if (colIndex(cols, g) < 0) throw new SqlError(`Unknown column “${g}” in GROUP BY.`);
  }

  const anyAgg = items.some((i) => hasAgg(i.expr));
  const grouped = query.groupBy.length > 0;
  const groupIdx = query.groupBy.map((g) => colIndex(cols, g));

  // WHERE filter (row context only).
  const passesWhere = (row: Value[]): boolean => {
    if (!query.where) return true;
    const ctx: EvalCtx = { row, cols, aliasPos, useAlias: false, agg: null };
    const v = evalExpr(query.where, ctx);
    return toBool(v);
  };

  // Pre-filtered rows.
  const filtered: Value[][] = [];
  let cappedEarly = false;
  for (const row of source.rows) {
    if (passesWhere(row)) {
      filtered.push(row);
      if (!grouped && !anyAgg && query.orderBy.length === 0 && filtered.length >= rowCap) {
        // Early exit without GROUP BY / ORDER: the tail can only be identical
        // rows; remember the cap so the caller sees `truncated` truthfully.
        cappedEarly = true;
        break;
      }
    }
  }

  type GroupRec = { key: string; rows: Value[][]; rep: Value[] };
  const groups = new Map<string, GroupRec>();

  if (grouped) {
    for (const row of filtered) {
      const key = groupIdx.map((idx) => String(row[idx] ?? "").replace(/\u0001/g, "")).join("\u0001");
      const rec = groups.get(key);
      if (rec) {
        rec.rows.push(row);
      } else {
        if (groups.size >= rowCap * 4) break; // protect memory; truncated flag set below
        groups.set(key, { key, rows: [row], rep: row });
      }
    }
  }

  // ---- Produce output rows ----
  type OutRow = { values: Value[]; rep: Value[] | null; groupRows: Value[][] | null };

  const evalItemList = (rows: Value[][], rep: Value[] | null): Value[] => {
    // Evaluate aggregate arguments over `rows`, then every item with an agg
    // context so aggregates nested in expressions (SUM(x)/COUNT(*)) resolve.
    const agg = new Map<string, Value>();
    const collectAggs = (expr: Expr) => {
      if (expr.kind === "agg") {
        const key = `${expr.fn}(${aggKey(expr.arg)})`;
        if (!agg.has(key)) agg.set(key, runAgg(expr.fn, rows, expr.arg, cols));
        return;
      }
      if (expr.kind === "bin") {
        collectAggs(expr.left);
        collectAggs(expr.right);
      } else if (expr.kind === "not" || expr.kind === "isnull") collectAggs(expr.expr);
    };
    if (anyAgg) for (const item of items) collectAggs(item.expr);
    const out: Value[] = [];
    const aggCtx: EvalCtx = { row: rep, cols, aliasPos, useAlias: true, agg };
    for (const item of items) {
      if (item.expr.kind === "col" && anyAgg && !grouped) {
        // aggregate query without GROUP BY: bare columns would be ambiguous
        throw new SqlError(`Column “${item.expr.name}” must appear inside an aggregate function or a GROUP BY clause.`);
      }
      out.push(evalExpr(item.expr, aggCtx));
    }
    return out;
  };

  const outRows: OutRow[] = [];
  if (grouped) {
    for (const rec of groups.values()) {
      const values = evalItemList(rec.rows, rec.rep);
      outRows.push({ values, rep: rec.rep, groupRows: rec.rows });
    }
  } else if (anyAgg) {
    const values = evalItemList(filtered, null);
    outRows.push({ values, rep: null, groupRows: null });
  } else {
    for (const row of filtered) {
      const ctx: EvalCtx = { row, cols, aliasPos, useAlias: false, agg: null };
      outRows.push({ values: items.map((item) => evalExpr(item.expr, ctx)), rep: row, groupRows: null });
    }
  }

  // ORDER BY
  if (query.orderBy.length) {
    // In row mode, a bare name prefers the source column; in aggregate/grouped
    // mode it refers to the computed output column (alias or aggregate label).
    const preferAlias = grouped || anyAgg;
    const mkSortCtx = (o: OutRow): EvalCtx => ({ row: o.rep, cols, aliasPos, useAlias: preferAlias, agg: null });
    outRows.sort((a, b) => {
      for (let i = 0; i < query.orderBy.length; i++) {
        const spec = query.orderBy[i]!;
        const e = spec.expr;
        let av: Value;
        let bv: Value;
        if (e.kind === "ordinal") {
          av = a.values[e.value - 1] ?? null;
          bv = b.values[e.value - 1] ?? null;
        } else if (e.kind === "col" && aliasPos.has(e.name) && (preferAlias || colIndex(cols, e.name) < 0)) {
          // An alias that shadows no source column resolves against the output
          // row in row mode too (e.g. `SELECT revenue AS r … ORDER BY r`).
          const idx = aliasPos.get(e.name)!;
          av = a.values[idx - 1] ?? null;
          bv = b.values[idx - 1] ?? null;
        } else {
          av = evalExpr(e, mkSortCtx(a));
          bv = evalExpr(e, mkSortCtx(b));
        }
        const c = cmp(av, bv);
        if (c !== 0) return spec.desc ? -c : c;
      }
      return 0;
    });
  }

  const limit = query.limit === null ? rowCap : Math.min(query.limit, rowCap);
  const limited = outRows.slice(0, limit);
  const truncated = cappedEarly || outRows.length > limit;

  const resultColumns = items.map((item, i) => ({
    name: item.alias ?? `col_${i + 1}`,
    type: inferType(limited.map((r) => r.values[i] ?? null)),
  }));

  // --- Post-process window functions (SUM/AVG/COUNT OVER PARTITION BY ORDER BY) ---
  const windowResult = postprocessWindowFunctions(
    {
      columns: resultColumns,
      rows: limited.map((r) => r.values),
      rowCount: limited.length,
      totalMatched: grouped ? groups.size : filtered.length,
      truncated,
      engine: "prototype-sql",
      note: `Prototype SQL engine — deterministic execution over the dataset's row store (no live database). Read-only SELECT subset; results capped at ${rowCap.toLocaleString()} rows${truncated ? " (truncated)" : ""}.`,
      executionMs: Date.now() - started,
    },
    transformedSql,
    cteColumns,
  );

  return {
    columns: windowResult.columns,
    rows: windowResult.rows,
    rowCount: windowResult.rowCount,
    totalMatched: windowResult.totalMatched,
    truncated: windowResult.truncated,
    engine: windowResult.engine,
    note: windowResult.note,
    executionMs: windowResult.executionMs,
  };
}

/** Expand CTE (WITH) clauses by materializing each CTE's SELECT query. */
function expandCtes(
  sql: string,
  source: SqlSource,
): { transformedSql: string; cteColumns: Map<string, { name: string; type: ColType }[]> } {
  const cteColumns = new Map<string, { name: string; type: ColType }[]>();
  let transformed = sql;

  // Check if SQL starts WITH
  if (!/^WITH\s/.test(sql)) {
    return { transformedSql: transformed, cteColumns };
  }

  // Simple CTE parsing: WITH cte_name AS (SELECT ... FROM table [, ...])
  const cteRegex = /WITH\s+((?:(\w+)\s+AS\s*\((?:SELECT\s+.*?\s+FROM\s+\w+\)\s*,?\s*)+))SELECT\s/isu;
  const match = sql.match(cteRegex);
  if (!match) {
    return { transformedSql: transformed, cteColumns };
  }

  const cteBlock = match[1]!;
  // Parse individual CTEs
  const individualCteRegex = /(\w+)\s+AS\s*\((SELECT\s+.*?\s+FROM\s+\w+\))/gi;
  let cteMatch: RegExpExecArray | null;

  while ((cteMatch = individualCteRegex.exec(cteBlock)) !== null) {
    const cteName = cteMatch[1]!.toUpperCase();
    const cteFull = cteMatch[0]!;
    // Extract SELECT and FROM from the CTE
    const selectFromMatch = cteFull.match(/SELECT\s+(.+?)\s+FROM\s+(\w+)/i);
    if (!selectFromMatch) continue;

    const selectSql = selectFromMatch[1]!.trim();
    const fromTable = selectFromMatch[2]!;

    try {
      // Materialize the CTE by running its SELECT against the dataset
      const cteResult = executeSql(source, `SELECT ${selectSql} FROM ${fromTable}`, { rowCap: 100000 });
      cteColumns.set(cteName, cteResult.columns);

      // Replace CTE reference in main FROM clause with a derived table
      const cteRefRegex = new RegExp(`\\b${cteName}\\b`, "gi");
      transformed = transformed.replace(cteRefRegex, `(${selectSql}) AS ${cteName}`);
    } catch {
      // If CTE materialization fails, skip it
    }
  }

  // Remove the WITH block from the transformed SQL
  transformed = transformed.replace(/^WITH\s+.+?\s+SELECT\s/isu, "SELECT ");

  return { transformedSql: transformed, cteColumns };
}

/** Post-process results to compute window functions (SUM/AVG/COUNT OVER PARTITION BY ORDER BY). */
function postprocessWindowFunctions(
  result: SqlResultSet,
  sql: string,
  _cteColumns: Map<string, SqlColumn[]>,
): SqlResultSet {
  // Detect window function patterns: SUM(col) OVER (PARTITION BY col ORDER BY col)
  const windowFuncRegex =
    /(SUM|AVG|COUNT)\((\w+)\)\s+OVER\s*\(\s*PARTITION\s+BY\s+(\w+)(?:\s+ORDER\s+BY\s+(\w+))?\s*\)/gi;
  const cols: { name: string; type: ColType }[] = result.columns;
  const rows: SqlValue[][] = result.rows;

  let partitionColName = "";
  let orderColName = "";
  let aggType = "";

  const aggMatch = sql.match(windowFuncRegex);
  if (!aggMatch) return result;

  const fullAgg = aggMatch[0]!;
  const innerMatch = fullAgg.match(
    /\((SUM|AVG|COUNT)\((\w+)\)\s+OVER\s*\(\s*PARTITION\s+BY\s+(\w+)(?:\s+ORDER\s+BY\s+(\w+))?\s*\)/i,
  );
  if (innerMatch) {
    aggType = innerMatch[1]!.toUpperCase();
    partitionColName = innerMatch[3] ?? "";
    orderColName = innerMatch[4] ?? "";
  }

  const partitionColIdx = cols.findIndex((c) => c.name.toLowerCase() === (partitionColName || "").toLowerCase());
  const orderColIdx = cols.findIndex((c) => c.name.toLowerCase() === (orderColName || "").toLowerCase());

  if (partitionColIdx < 0 || aggType === "") return result;

  // Group rows by partition key, sort within each partition, compute window function
  const partitionGroups = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const key = String(rows[i]?.[partitionColIdx ?? 0] ?? "");
    if (!partitionGroups.has(key)) {
      partitionGroups.set(key, []);
    }
    partitionGroups.get(key)!.push(i);
  }

  // Compute new column values
  const newColName = `${aggType}(${partitionColName}) OVER`;
  const newRows: SqlValue[][] = [];

  for (const [, rowIndices] of partitionGroups) {
    // Sort rows within partition by order column
    const sortedIndices = rowIndices.sort((a, b) => {
      const av = rows[a]?.[orderColIdx !== -1 ? orderColIdx : 0] ?? null;
      const bv = rows[b]?.[orderColIdx !== -1 ? orderColIdx : 0] ?? null;
      return String(av).localeCompare(String(bv), undefined, { numeric: true });
    });

    // Compute running aggregate
    const newColumn: (number | null)[] = [];
    for (let i = 0; i < sortedIndices.length; i++) {
      let runningValue: number | null = null;
      if (aggType === "SUM") {
        let sum = 0;
        let count = 0;
        for (let j = 0; j <= i; j++) {
          const val = toNum(rows[sortedIndices[j]!]?.[partitionColIdx !== -1 ? partitionColIdx : 0] ?? null);
          if (Number.isFinite(val)) {
            sum += val;
            count++;
          }
        }
        runningValue = count > 0 ? sum : null;
      } else if (aggType === "AVG") {
        let sum = 0;
        let count = 0;
        for (let j = 0; j <= i; j++) {
          const val = toNum(rows[sortedIndices[j]!]?.[partitionColIdx !== -1 ? partitionColIdx : 0] ?? null);
          if (Number.isFinite(val)) {
            sum += val;
            count++;
          }
        }
        runningValue = count > 0 ? sum / count : null;
      } else if (aggType === "COUNT") {
        runningValue = i + 1;
      }
      newColumn.push(runningValue);
    }

    // Add the window function result to each row in order
    for (let i = 0; i < sortedIndices.length; i++) {
      const rowIdx = sortedIndices[i]!;
      const newRow: SqlValue[] = [...(rows[rowIdx] ?? [])];
      newRow.push((newColumn[i] as SqlValue) ?? null);
      newRows.push(newRow);
    }
  }

  // Add new column to result
  const newColumnDef: { name: string; type: ColType } = {
    name: newColName,
    type: "number",
  };

  return {
    columns: [...cols, newColumnDef],
    rows: newRows.slice(0, result.rowCount ?? newRows.length),
    rowCount: Math.min(newRows.length, result.rowCount ?? newRows.length),
    totalMatched: result.totalMatched,
    truncated: result.truncated,
    engine: result.engine,
    note: result.note,
    executionMs: result.executionMs,
  };
}

/** Expose the supported-grammar summary for UI tooltips / docs. */
export const SQL_SUPPORT_NOTE =
  "Read-only prototype SQL: SELECT [WITH cte] , WHERE (=, <>, <, <=, >, >=, AND, OR, NOT, IS [NOT] NULL), GROUP BY with COUNT/SUM/AVG/MIN/MAX, ORDER BY and LIMIT, window functions SUM/AVG/COUNT OVER (PARTITION BY ORDER BY). DDL/DML is rejected.";

/**
 * Extract a table name from a read-only SELECT's FROM clauses, or null when
 * none exists (e.g. `SELECT 1`). Used by the DuckDB engines to materialize the
 * dataset under the exact name the user's query references. Scans the whole
 * token stream so subqueries count too (`FROM (SELECT … FROM sales) a` →
 * `sales`); names inside `FROM (subquery)` position (immediately followed by a
 * parenthesis) are skipped. Uses the same tokenizer as the prototype parser so
 * quoted identifiers resolve identically.
 */
export function sqlFromTable(sql: string | null | undefined): string | null {
  if (!sql) return null;
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch {
    return null;
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t && t.kind === "word" && t.raw.toUpperCase() === "FROM") {
      const name = tokens[i + 1];
      // `FROM (` is a subquery — keep scanning for a real table reference.
      if (name && name.kind === "word") return name.raw;
    }
  }
  return null;
}
