/**
 * Data engineering engine — quality expectations + gates, column-level
 * lineage DAG, and dataset contracts (the dbt/Great-Expectations trio).
 *
 * Pure and deterministic; API routes own persistence. Every check returns a
 * machine-readable result the UI renders as pass/fail with counts:
 *
 *  Expectations — declarative per-column/table checks evaluated over typed
 *                 rows: nulls, ranges, value sets, regex, uniqueness,
 *                 freshness, row count, referential integrity.
 *  Gates        — a suite + severity policy ⇒ pass/warn/fail with an exact
 *                 pass ratio; FAIL blocks downstream materialization (the
 *                 route decides enforcement — the gate decides the verdict).
 *  Lineage      — column-level DAG: dataset→dataset edges annotated with the
 *                 columns each transformation reads/writes; topological sort
 *                 with cycle detection, downstream/upstream impact analysis.
 *  Contracts    — schema contract (columns, types, nullability) + quality
 *                 contract (expectation refs); a dataset version either
 *                 satisfies the contract or lists the exact violations.
 */

// ---------------------------------------------------------------------------
// 1. Expectations
// ---------------------------------------------------------------------------

export type ExpectationKind =
  "not-null" | "unique" | "range" | "in-set" | "regex" | "row-count" | "freshness" | "no-fk-violations";

export type Severity = "error" | "warn";

export interface Expectation {
  id: string;
  kind: ExpectationKind;
  /** Column the check binds to (null for table-level checks). */
  column: string | null;
  /** Fail (error) or just warn. Default warn. */
  severity: Severity;
  /** range: inclusive bounds; nulls always fail not-null regardless. */
  params?: {
    min?: number;
    max?: number;
    values?: (string | number)[];
    pattern?: string;
    minRows?: number;
    maxAgeHours?: number;
  };
  /** Human note shown in the UI. */
  description?: string;
}

export interface ExpectationResult {
  expectationId: string;
  kind: ExpectationKind;
  column: string | null;
  passed: boolean;
  severity: Severity;
  /** Rows evaluated (or total rows for table checks). */
  total: number;
  /** Rows that violated the expectation. */
  violations: number;
  /** Violating example values (max 5) — provenance for the UI. */
  examples: string[];
  message: string;
}

export class DataQualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataQualityError";
  }
}

const NUMERIC_RE = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;

/** Evaluate one expectation over typed dataset rows. */
export function evaluateExpectation(
  exp: Expectation,
  columns: { name: string; type: string }[],
  rows: (string | number | boolean | null)[][],
  opts: { now?: Date } = {},
): ExpectationResult {
  const colIdx = exp.column ? columns.findIndex((c) => c.name === exp.column) : -1;
  if (exp.column && colIdx < 0) {
    throw new DataQualityError(`Expectation references unknown column “${exp.column}”.`);
  }
  const colValues = exp.column ? rows.map((r) => r[colIdx] ?? null) : [];
  const total = exp.kind === "row-count" || exp.kind === "freshness" ? rows.length : colValues.length;

  const fail = (violations: number, examples: string[], message: string): ExpectationResult => ({
    expectationId: exp.id,
    kind: exp.kind,
    column: exp.column,
    passed: false,
    severity: exp.severity,
    total,
    violations,
    examples,
    message,
  });
  const pass = (message: string, violations = 0): ExpectationResult => ({
    expectationId: exp.id,
    kind: exp.kind,
    column: exp.column,
    passed: true,
    severity: exp.severity,
    total,
    violations,
    examples: [],
    message,
  });

  switch (exp.kind) {
    case "not-null": {
      const bad = colValues.filter((v) => v === null || v === undefined || v === "");
      const examples = bad.slice(0, 5).map(() => "∅");
      return bad.length === 0
        ? pass(`“${exp.column}” has no null/blank values in ${total} rows.`)
        : fail(bad.length, examples, `“${exp.column}” has ${bad.length} null/blank value(s) out of ${total}.`);
    }
    case "unique": {
      const seen = new Map<string, number>();
      for (const v of colValues) {
        const key = String(v);
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      const dups = [...seen.entries()].filter(([, c]) => c > 1);
      const examples = dups.slice(0, 5).map(([k, c]) => `${k} ×${c}`);
      return dups.length === 0
        ? pass(`“${exp.column}” is unique across ${total} rows.`)
        : fail(dups.length, examples, `“${exp.column}” has ${dups.length} duplicated value(s).`);
    }
    case "range": {
      const min = exp.params?.min;
      const max = exp.params?.max;
      if (min === undefined && max === undefined) throw new DataQualityError("range expectation needs min and/or max.");
      const bad: string[] = [];
      let violations = 0;
      for (const v of colValues) {
        if (v === null || v === "") continue; // nulls are not-null's job
        const s = String(v);
        if (!NUMERIC_RE.test(s)) {
          violations++;
          if (bad.length < 5) bad.push(s);
          continue;
        }
        const n = Number(s);
        if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
          violations++;
          if (bad.length < 5) bad.push(s);
        }
      }
      return violations === 0
        ? pass(`“${exp.column}” within [${min ?? "−∞"}, ${max ?? "+∞"}] for all ${total} rows.`)
        : fail(
            violations,
            bad,
            `“${exp.column}” violates the range [${min ?? "−∞"}, ${max ?? "+∞"}] in ${violations} row(s).`,
          );
    }
    case "in-set": {
      const values = exp.params?.values;
      if (!values?.length) throw new DataQualityError("in-set expectation needs a values list.");
      const allowed = new Set(values.map(String));
      const bad: string[] = [];
      let violations = 0;
      for (const v of colValues) {
        if (v === null || v === "") continue;
        if (!allowed.has(String(v))) {
          violations++;
          if (bad.length < 5) bad.push(String(v));
        }
      }
      return violations === 0
        ? pass(
            `“${exp.column}” ∈ {${values.slice(0, 5).join(", ")}${values.length > 5 ? ", …" : ""}} for all ${total} rows.`,
          )
        : fail(violations, bad, `“${exp.column}” has ${violations} value(s) outside the allowed set.`);
    }
    case "regex": {
      const pattern = exp.params?.pattern;
      if (!pattern) throw new DataQualityError("regex expectation needs a pattern.");
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        throw new DataQualityError(`Invalid regex pattern: ${pattern}`);
      }
      const bad: string[] = [];
      let violations = 0;
      for (const v of colValues) {
        if (v === null || v === "") continue;
        if (!re.test(String(v))) {
          violations++;
          if (bad.length < 5) bad.push(String(v));
        }
      }
      return violations === 0
        ? pass(`“${exp.column}” matches /${pattern}/ for all ${total} rows.`)
        : fail(violations, bad, `“${exp.column}” fails /${pattern}/ in ${violations} row(s).`);
    }
    case "row-count": {
      const minRows = exp.params?.minRows;
      if (minRows === undefined) throw new DataQualityError("row-count expectation needs minRows.");
      return rows.length >= minRows
        ? pass(`Table has ${rows.length} rows (≥ required ${minRows}).`)
        : fail(
            rows.length,
            [String(rows.length)],
            `Table has only ${rows.length} rows — below the required ${minRows}.`,
          );
    }
    case "freshness": {
      const colName = exp.column;
      if (!colName) throw new DataQualityError("freshness expectation needs a timestamp column.");
      const maxAge = exp.params?.maxAgeHours;
      if (maxAge === undefined) throw new DataQualityError("freshness expectation needs maxAgeHours.");
      const now = opts.now ?? new Date();
      // Parse the max timestamp in the column.
      let maxTs: number | null = null;
      for (const v of colValues) {
        if (v === null || v === "") continue;
        const t = typeof v === "number" ? v : Date.parse(String(v));
        if (Number.isFinite(t)) maxTs = maxTs === null ? t : Math.max(maxTs, t);
      }
      if (maxTs === null) return fail(1, ["no timestamps"], `“${colName}” contains no parseable timestamps.`);
      // Numeric timestamps in seconds are normalized to ms.
      const ts = maxTs < 1e12 ? maxTs * 1000 : maxTs;
      const ageHours = (now.getTime() - ts) / 3_600_000;
      return ageHours <= maxAge
        ? pass(`Newest row is ${ageHours.toFixed(1)}h old (≤ ${maxAge}h).`)
        : fail(
            1,
            [new Date(ts).toISOString()],
            `Newest row is ${ageHours.toFixed(1)}h old — staler than the ${maxAge}h budget.`,
          );
    }
    case "no-fk-violations": {
      // Referential integrity: this column's non-null values must all appear
      // in the referenced column. Params carry the referenced values via a
      // caller-supplied set in `values` (the route materializes it).
      const referenced = exp.params?.values;
      if (!referenced) throw new DataQualityError("no-fk-violations needs the referenced column's distinct values.");
      const refSet = new Set(referenced.map(String));
      const bad: string[] = [];
      let violations = 0;
      for (const v of colValues) {
        if (v === null || v === "") continue;
        if (!refSet.has(String(v))) {
          violations++;
          if (bad.length < 5) bad.push(String(v));
        }
      }
      return violations === 0
        ? pass(`All ${total} non-null values of “${exp.column}” exist in the referenced column.`)
        : fail(violations, bad, `${violations} value(s) of “${exp.column}” have no matching parent row (orphaned).`);
    }
  }
}

/** Evaluate a suite; the gate policy decides the verdict. */
export function evaluateSuite(
  expectations: Expectation[],
  columns: { name: string; type: string }[],
  rows: (string | number | boolean | null)[][],
  opts: { now?: Date } = {},
): ExpectationResult[] {
  return expectations.map((e) => evaluateExpectation(e, columns, rows, opts));
}

// ---------------------------------------------------------------------------
// 2. Quality gates
// ---------------------------------------------------------------------------

export interface GatePolicy2 {
  /** Pass ratio (passed / total) required to PASS the gate. Default 0.9. */
  minPassRatio?: number;
  /** Any error-severity failure fails the gate regardless of ratio. Default true. */
  blockOnError?: boolean;
}

export interface GateResult2 {
  verdict: "pass" | "warn" | "fail";
  passRatio: number;
  passed: number;
  failed: number;
  total: number;
  errorFailures: number;
  warnFailures: number;
  /** The failing expectations (for the blocking UI). */
  failures: ExpectationResult[];
  message: string;
}

/**
 * Quality gate: an error-severity failure blocks (when blockOnError), else the
 * pass ratio decides. A gate with zero expectations passes trivially — callers
 * should treat "no expectations" as "no gate".
 */
export function runQualityGate(results: ExpectationResult[], policy: GatePolicy2 = {}): GateResult2 {
  const minPassRatio = policy.minPassRatio ?? 0.9;
  const blockOnError = policy.blockOnError ?? true;
  const total = results.length;
  if (total === 0) {
    return {
      verdict: "pass",
      passRatio: 1,
      passed: 0,
      failed: 0,
      total: 0,
      errorFailures: 0,
      warnFailures: 0,
      failures: [],
      message: "No expectations configured — gate passes trivially.",
    };
  }
  const failures = results.filter((r) => !r.passed);
  const errorFailures = failures.filter((f) => f.severity === "error").length;
  const warnFailures = failures.length - errorFailures;
  const passRatio = (total - failures.length) / total;
  if (blockOnError && errorFailures > 0) {
    return {
      verdict: "fail",
      passRatio,
      passed: total - failures.length,
      failed: failures.length,
      total,
      errorFailures,
      warnFailures,
      failures,
      message: `GATE FAILED: ${errorFailures} error-severity expectation(s) failed${warnFailures ? ` (+${warnFailures} warnings)` : ""}. Downstream materialization is blocked.`,
    };
  }
  if (passRatio >= minPassRatio) {
    return {
      verdict: warnFailures > 0 ? "warn" : "pass",
      passRatio,
      passed: total - failures.length,
      failed: failures.length,
      total,
      errorFailures: 0,
      warnFailures,
      failures,
      message:
        warnFailures > 0
          ? `Gate passed with warnings: ${warnFailures} warn-severity failure(s); pass ratio ${passRatio.toFixed(2)} ≥ ${minPassRatio}.`
          : `Gate passed: all ${total} expectations satisfied.`,
    };
  }
  return {
    verdict: "fail",
    passRatio,
    passed: total - failures.length,
    failed: failures.length,
    total,
    errorFailures,
    warnFailures,
    failures,
    message: `GATE FAILED: pass ratio ${passRatio.toFixed(2)} < required ${minPassRatio} (${failures.length} of ${total} expectations failed).`,
  };
}

// ---------------------------------------------------------------------------
// 3. Column-level lineage DAG
// ---------------------------------------------------------------------------

export interface LineageNode {
  id: string;
  kind: "dataset" | "transform" | "external";
  label: string;
}

export interface LineageEdge {
  from: string;
  to: string;
  /** Columns read from `from` by the operation that produced `to`. */
  columns: string[];
  /** Operation label (e.g. "powerquery:group-by", "join:inner"). */
  operation: string;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export interface LineageValidationError {
  kind: "cycle" | "missing-node" | "self-loop";
  message: string;
  nodes?: string[];
}

/** Structural validation: unknown endpoints, self-loops, and cycles. */
export function validateLineage(graph: LineageGraph): LineageValidationError[] {
  const errors: LineageValidationError[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      errors.push({
        kind: "missing-node",
        message: `Edge ${e.from} → ${e.to} references an unknown node.`,
        nodes: [e.from, e.to],
      });
      continue;
    }
    if (e.from === e.to) {
      errors.push({ kind: "self-loop", message: `Node ${e.from} depends on itself.`, nodes: [e.from] });
      continue;
    }
    adj.get(e.from)!.push(e.to);
  }
  // Cycle detection: iterative DFS with colors.
  const color = new Map<string, 0 | 1 | 2>();
  for (const id of ids) color.set(id, 0);
  const stack: { node: string; iter: number }[] = [];
  const path: string[] = [];
  for (const root of ids) {
    if ((color.get(root) ?? 0) !== 0) continue;
    stack.push({ node: root, iter: 0 });
    color.set(root, 1);
    path.push(root);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const neighbors = adj.get(top.node) ?? [];
      if (top.iter < neighbors.length) {
        const next = neighbors[top.iter]!;
        top.iter++;
        const c = color.get(next) ?? 0;
        if (c === 1) {
          const start = path.indexOf(next);
          errors.push({
            kind: "cycle",
            message: `Circular lineage: ${[...path.slice(start), next].join(" → ")}`,
            nodes: path.slice(start),
          });
        } else if (c === 0) {
          color.set(next, 1);
          stack.push({ node: next, iter: 0 });
          path.push(next);
        }
      } else {
        color.set(top.node, 2);
        stack.pop();
        path.pop();
      }
    }
  }
  return errors;
}

/** Topological order (Kahn). Throws on cycles — validate first for details. */
export function topologicalOrder(graph: LineageGraph): string[] {
  const errors = validateLineage(graph).filter((e) => e.kind === "cycle" || e.kind === "missing-node");
  if (errors.length) throw new DataQualityError(`Lineage graph is not a DAG: ${errors[0]!.message}`);
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) {
    indegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of graph.edges) {
    adj.get(e.from)!.push(e.to);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }
  const queue = graph.nodes
    .map((n) => n.id)
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort();
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift() as string;
    out.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return out;
}

export interface ImpactAnalysis {
  /** Node ids affected when `nodeId` changes (downstream, transitive). */
  downstream: string[];
  /** Node ids `nodeId` depends on (upstream, transitive). */
  upstream: string[];
  /** Columns contributed by `nodeId`'s outgoing edges — what consumers read. */
  exposedColumns: string[];
}

/** Upstream/downstream impact analysis for one node (BFS both directions). */
export function lineageImpact(graph: LineageGraph, nodeId: string): ImpactAnalysis {
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (!ids.has(nodeId)) throw new DataQualityError(`Unknown lineage node “${nodeId}”.`);
  const adj = new Map<string, string[]>();
  const radj = new Map<string, string[]>();
  for (const n of graph.nodes) {
    adj.set(n.id, []);
    radj.set(n.id, []);
  }
  for (const e of graph.edges) {
    adj.get(e.from)!.push(e.to);
    radj.get(e.to)!.push(e.from);
  }
  const bfs = (start: string, map: Map<string, string[]>): string[] => {
    const seen = new Set<string>([start]);
    const queue = [start];
    const out: string[] = [];
    while (queue.length) {
      const cur = queue.shift() as string;
      for (const next of map.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          out.push(next);
          queue.push(next);
        }
      }
    }
    return out.sort();
  };
  return {
    downstream: bfs(nodeId, adj),
    upstream: bfs(nodeId, radj),
    exposedColumns: [...new Set(graph.edges.filter((e) => e.from === nodeId).flatMap((e) => e.columns))].sort(),
  };
}

// ---------------------------------------------------------------------------
// 4. Dataset contracts
// ---------------------------------------------------------------------------

export interface ContractColumn {
  name: string;
  type: "number" | "string" | "boolean" | "date";
  nullable: boolean;
  /** Soft uniqueness — verified via a unique expectation in the suite. */
  unique?: boolean;
  description?: string;
}

export interface DatasetContract {
  id: string;
  datasetName: string;
  /** Human contract version (semver-ish, informational). */
  version: string;
  columns: ContractColumn[];
  /** Expectations that MUST hold for a dataset version to satisfy the contract. */
  expectations: Expectation[];
  /** Who signed the contract / owns changes (provenance). */
  ownerId?: string;
  updatedAt?: string;
}

export type ContractViolationKind =
  "missing-column" | "extra-column" | "type-mismatch" | "nullability-violation" | "expectation-failed";

export interface ContractViolation {
  kind: ContractViolationKind;
  column: string | null;
  message: string;
  /** For expectation-failed: the failing expectation id. */
  expectationId?: string;
}

export interface ContractCheckResult {
  satisfied: boolean;
  violations: ContractViolation[];
  /** Expectation results that ran as part of the contract check. */
  expectationResults: ExpectationResult[];
}

/**
 * Check a dataset version against its contract: schema first (columns, types,
 * nullability), then quality expectations. All violations are returned — the
 * caller decides enforcement (e.g. block materialization on any violation).
 */
export function checkContract(
  contract: DatasetContract,
  columns: { name: string; type: string }[],
  rows: (string | number | boolean | null)[][],
  opts: { now?: Date } = {},
): ContractCheckResult {
  const violations: ContractViolation[] = [];
  const actualByName = new Map(columns.map((c) => [c.name, c] as const));
  for (const want of contract.columns) {
    const got = actualByName.get(want.name);
    if (!got) {
      violations.push({
        kind: "missing-column",
        column: want.name,
        message: `Contract requires column “${want.name}” but the dataset does not have it.`,
      });
      continue;
    }
    const t = (got.type ?? "unknown").toLowerCase();
    const typeOk =
      want.type === t ||
      (want.type === "number" &&
        (t === "number" || t === "int" || t === "float" || t === "double" || t === "decimal")) ||
      (want.type === "string" && (t === "string" || t === "text" || t === "varchar")) ||
      (want.type === "date" && (t === "date" || t === "datetime" || t === "timestamp"));
    if (!typeOk) {
      violations.push({
        kind: "type-mismatch",
        column: want.name,
        message: `Column “${want.name}” is ${t} but the contract requires ${want.type}.`,
      });
      continue;
    }
    if (!want.nullable) {
      const idx = columns.findIndex((c) => c.name === want.name);
      const nulls = rows.filter((r) => r[idx] === null || r[idx] === undefined || r[idx] === "").length;
      if (nulls > 0) {
        violations.push({
          kind: "nullability-violation",
          column: want.name,
          message: `Non-nullable column “${want.name}” has ${nulls} null/blank row(s).`,
        });
      }
    }
  }
  for (const have of columns) {
    if (!contract.columns.some((c) => c.name === have.name)) {
      violations.push({
        kind: "extra-column",
        column: have.name,
        message: `Dataset has column “${have.name}” which is not in the contract (add it or drop the column).`,
      });
    }
  }
  const expectationResults = contract.expectations.length
    ? evaluateSuite(contract.expectations, columns, rows, opts)
    : [];
  for (const r of expectationResults) {
    if (!r.passed) {
      violations.push({
        kind: "expectation-failed",
        column: r.column,
        expectationId: r.expectationId,
        message: `Expectation ${r.expectationId} (${r.kind}${r.column ? ` on ${r.column}` : ""}) failed: ${r.message}`,
      });
    }
  }
  return { satisfied: violations.length === 0, violations, expectationResults };
}
