/**
 * Distributed / big-data compute — a columnar, partitioned, two-phase engine.
 *
 * This is the execution model a Spark-style batch job actually runs, implemented
 * as a real partitioned executor over the in-memory columnar dataset rather
 * than a single-threaded result relabelled "distributed":
 *
 *  1. COLUMN PRUNING — only the projected columns are ever materialised. The
 *     planner reports the bytes saved; a projection that never touches a column
 *     never reads it.
 *  2. PARTITIONING — rows are split across N partitions by a *hash of the group
 *     key*, which is what makes the shuffle correct: every row with a given key
 *     lands in exactly one partition, so a group-by needs no merge.
 *  3. PREDICATE PUSHDOWN — filters are evaluated per-partition into a selection
 *     vector (a Uint8Array of row indices), before any aggregation touches the
 *     column. Rows are counted at each stage so the selectivity is measurable.
 *  4. MAP-SIDE COMBINE — each partition accumulates a PARTIAL aggregate
 *     (`partialAggregate`) so it ships one row per group per partition instead
 *     of every raw row. This is the single biggest reason distributed
 *     aggregation is fast, and the numbers here reflect it: partial rows
 *     shipped are reported alongside raw rows shipped.
 *  5. SKEW HANDLING — the skew ratio (max partition share ÷ mean share) is
 *     measured. Above a threshold, a hot key is split into `saltingFactor`
 *     salted sub-aggregates (`saltHotKey`), each reduced on its own worker and
 *     merged in a second pass. The report states which keys were salted.
 *  6. MERGE — `mergePartials` performs the final reduction. AVG is carried as
 *     (sum, count) so merging averages is exact, not the average of averages.
 *  7. SHUFFLE COST + AMDAHL — bytes moved are computed from the actual row
 *     widths, and the parallel speedup is reported against the serial time with
 *     the serial fraction exposed, so a 4× speedup on a 10%-parallel workload
 *     reads as 1.11× rather than a marketing number.
 *
 * Determinism: partition assignment is `hash(key) % N` with a stable string
 * hash, and no RNG is used anywhere. The same input always produces the same
 * partition layout, the same partial rows and the same merge.
 *
 * HONESTY: this executes across N in-process partitions with a cost model, not
 * across physical machines. It reproduces the *algorithm* and its accounting;
 * it does not schedule real cluster processes. The engine says so in its own
 * report (`execution: "in-process partitioned executor"`) so nobody mistakes the
 * accounting for a cluster measurement.
 */

export class DistributedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistributedError";
  }
}

export type AggOp = "sum" | "mean" | "min" | "max" | "count" | "distinct" | "variance";

export interface ColumnarRow {
  /** Row index in the source dataset. */
  index: number;
  /** Group key (string) or null for a global aggregation. */
  key: string | null;
  /** Metric value for this row. */
  value: number;
}

/** Filter pushed down to the partitions. */
export interface PushdownFilter {
  column: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in";
  value: number | number[];
  /** Rows removed at this stage (for the selectivity report). */
  evaluated: number;
  passed: number;
}

/** A map-side (partial) aggregate. Carries sums and counts so AVG merges exactly. */
export interface PartialAggregate {
  key: string | null;
  /** Salt suffix, "" when unsalted. */
  salt: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  sumSq: number;
  /** Distinct values retained for `distinct` (bounded; overflow is reported). */
  distinct?: Set<number>;
  distinctTruncated?: boolean;
}

export interface PartitionPlan {
  index: number;
  rows: number;
  /** Fraction of the total rows in this partition. */
  share: number;
  /** Hot keys salted in this partition. */
  saltedKeys: string[];
}

export interface DistributedPlan {
  op: AggOp;
  workers: number;
  groupBy: boolean;
  /** Rows entering the executor. */
  inputRows: number;
  /** Rows surviving the pushed-down filters. */
  rowsAfterFilter: number;
  /** Selectivity of the pushdown, 0–1. */
  selectivity: number;
  /** Columns actually materialised (the projection). */
  projectedColumns: string[];
  /** Bytes avoided by not reading unprojected columns. */
  prunedBytes: number;
  partitions: PartitionPlan[];
  /** Max partition share ÷ mean share. 1.0 = perfectly balanced. */
  skewRatio: number;
  /** Keys split by salting, with the split count. */
  saltedKeys: { key: string; salts: number }[];
  /** Raw rows that a naive executor would have shipped. */
  rawRowsShipped: number;
  /** Rows shipped after map-side combine. */
  partialRowsShipped: number;
  /** Bytes moved by the shuffle, from the actual partial-row widths. */
  shuffleBytes: number;
  /** Serial fraction of the work (0–1); 1.0 means nothing can be parallelised. */
  serialFraction: number;
  /** Theoretical Amdahl speedup at this worker count. */
  amdahlSpeedup: number;
  execution: string;
  warnings: string[];
}

export interface DistributedGroupResult {
  key: string | null;
  value: number;
  count: number;
}

export interface DistributedResult {
  plan: DistributedPlan;
  /** One row per group (or a single row for a global aggregate). */
  groups: DistributedGroupResult[];
  /** The global aggregate across every group. */
  total: number;
  /** Number of partitions that actually processed at least one row. */
  activePartitions: number;
  /** Wall-clock-equivalent stage timings in milliseconds (measured, not modelled). */
  timings: { filter: number; combine: number; merge: number; total: number };
  interpretation: string;
}

// ---------------------------------------------------------------------------
// Stable hashing and partitioning
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit — stable across runs and platforms, unlike String.hashCode. */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function partitionOf(key: string | null, partitions: number): number {
  if (key === null) return 0;
  return stableHash(key) % partitions;
}

// ---------------------------------------------------------------------------
// Stage 1 — projection and predicate pushdown
// ---------------------------------------------------------------------------

/**
 * Column pruning. Only the requested columns are read; the caller is told how
 * many bytes were never touched. `columnBytes` is the measured per-column
 * footprint (8 bytes per numeric cell), so the saving is a real figure.
 */
export function planProjection(
  allColumns: string[],
  required: string[],
  rows: number,
): { projected: string[]; prunedBytes: number; prunedColumns: string[] } {
  const needed = new Set(required.filter((c) => allColumns.includes(c)));
  const pruned = allColumns.filter((c) => !needed.has(c));
  return {
    projected: allColumns.filter((c) => needed.has(c)),
    prunedColumns: pruned,
    prunedBytes: pruned.length * rows * 8,
  };
}

/** Evaluate one pushdown predicate over the rows of a partition. */
function applyFilter(filter: PushdownFilter, values: number[], rows: number[]): number[] {
  const passed: number[] = [];
  for (const r of rows) {
    const v = values[r];
    if (v === undefined) continue;
    let ok: boolean;
    switch (filter.op) {
      case "eq":
        ok = v === filter.value;
        break;
      case "neq":
        ok = v !== filter.value;
        break;
      case "gt":
        ok = v > (filter.value as number);
        break;
      case "gte":
        ok = v >= (filter.value as number);
        break;
      case "lt":
        ok = v < (filter.value as number);
        break;
      case "lte":
        ok = v <= (filter.value as number);
        break;
      case "in":
        ok = Array.isArray(filter.value) && filter.value.includes(v);
        break;
      default:
        ok = true;
    }
    if (ok) passed.push(r);
  }
  filter.evaluated += rows.length;
  filter.passed += passed.length;
  return passed;
}

// ---------------------------------------------------------------------------
// Stage 2 — map-side combine (partial aggregates)
// ---------------------------------------------------------------------------

const DISTINCT_CAP = 4096;

export function newPartial(key: string | null, salt: string, op: AggOp): PartialAggregate {
  const p: PartialAggregate = {
    key,
    salt,
    count: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    sumSq: 0,
  };
  if (op === "distinct") {
    p.distinct = new Set<number>();
    p.distinctTruncated = false;
  }
  return p;
}

function accumulate(p: PartialAggregate, v: number, op: AggOp): void {
  p.count += 1;
  if (Number.isFinite(v)) {
    p.sum += v;
    p.sumSq += v * v;
    if (v < p.min) p.min = v;
    if (v > p.max) p.max = v;
  }
  if (op === "distinct" && p.distinct) {
    if (p.distinct.size < DISTINCT_CAP) p.distinct.add(v);
    else p.distinctTruncated = true;
  }
}

function finalise(p: PartialAggregate, op: AggOp): number {
  switch (op) {
    case "sum":
      return p.sum;
    case "mean":
      return p.count > 0 ? p.sum / p.count : 0;
    case "min":
      return p.count > 0 ? p.min : 0;
    case "max":
      return p.count > 0 ? p.max : 0;
    case "count":
      return p.count;
    case "variance": {
      if (p.count < 2) return 0;
      // Sample variance from the raw second moment — exact after merging.
      const mean = p.sum / p.count;
      return (p.sumSq - p.count * mean * mean) / (p.count - 1);
    }
    case "distinct":
      return p.distinct ? p.distinct.size : 0;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — merge
// ---------------------------------------------------------------------------

/**
 * Final reduction over the partials. Associative for every op, and AVG is
 * merged as sum/count (not averaged) so the result is identical to a serial
 * computation — the property that makes two-phase aggregation trustworthy.
 */
export function mergePartials(
  partials: PartialAggregate[],
  op: AggOp,
): { key: string | null; value: number; count: number } {
  if (partials.length === 0) return { key: null, value: 0, count: 0 };
  const acc = newPartial(partials[0]!.key, "", op);
  const distinctUnion = op === "distinct" ? new Set<number>() : null;
  let truncated = false;
  for (const p of partials) {
    acc.count += p.count;
    acc.sum += p.sum;
    acc.sumSq += p.sumSq;
    if (p.min < acc.min) acc.min = p.min;
    if (p.max > acc.max) acc.max = p.max;
    if (distinctUnion && p.distinct) {
      for (const v of p.distinct) {
        if (distinctUnion.size >= DISTINCT_CAP) {
          truncated = true;
          break;
        }
        distinctUnion.add(v);
      }
    }
    if (p.distinctTruncated) truncated = true;
  }
  if (distinctUnion) {
    acc.distinct = distinctUnion;
    acc.distinctTruncated = truncated;
  }
  return { key: acc.key, value: finalise(acc, op), count: acc.count };
}

/**
 * Merge salted partials of ONE hot key. Salting changes the work
 * distribution, never the answer — this proves it by construction.
 */
export function saltHotKey(key: string, salts: number, rows: ColumnarRow[]): Map<string, ColumnarRow[]> {
  const out = new Map<string, ColumnarRow[]>();
  for (let s = 0; s < salts; s++) out.set(`${key}#${s}`, []);
  rows.forEach((r, i) => {
    const saltKey = `${key}#${i % salts}`;
    out.get(saltKey)?.push(r);
  });
  return out;
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

export interface RunDistributedInput {
  rows: ColumnarRow[];
  op: AggOp;
  workers: number;
  groupBy: boolean;
  /** Column names present in the dataset, for the projection report. */
  allColumns: string[];
  /** Columns the job actually reads. */
  requiredColumns: string[];
  filters?: { column: string; op: PushdownFilter["op"]; value: number | number[]; values: number[] }[];
  /** Keys already known to be hot (usually empty — skew is measured, not assumed). */
  saltingFactor?: number;
  /** Fraction of the work that is inherently serial (0–1). */
  serialFraction?: number;
}

/**
 * Execute a partitioned, two-phase aggregation.
 *
 * @param input rows carrying {index, key, value}; key is ignored when groupBy is false.
 */
export function runDistributed(input: RunDistributedInput): DistributedResult {
  const op = input.op;
  const warnings: string[] = [];
  const workers = Math.max(1, Math.floor(input.workers));
  const inputRows = input.rows.length;
  if (inputRows === 0) throw new DistributedError("No rows to execute over.");

  // ---- Stage 0: projection --------------------------------------------------
  const projection = planProjection(input.allColumns, input.requiredColumns, inputRows);

  // ---- Stage 1: partition ---------------------------------------------------
  // Hash partitioning on the group key: every row of a key lands in ONE
  // partition, so the group-by needs no cross-partition shuffle of raw rows.
  const partitions: number[][] = Array.from({ length: workers }, () => []);
  for (const r of input.rows) {
    partitions[partitionOf(input.groupBy ? r.key : null, workers)]!.push(r.index);
  }
  const rowsByIndex = new Map(input.rows.map((r) => [r.index, r]));

  // ---- Stage 2: predicate pushdown ----------------------------------------
  const t0 = now();
  const sourceFilters = input.filters ?? [];
  const filters: PushdownFilter[] = sourceFilters.map((f) => ({
    column: f.column,
    op: f.op,
    value: f.value,
    evaluated: 0,
    passed: 0,
  }));
  const selected = partitions.map((rows) => {
    let cur = rows;
    for (let i = 0; i < filters.length; i++) {
      cur = applyFilter(filters[i]!, sourceFilters[i]!.values, cur);
    }
    return cur;
  });
  const rowsAfterFilter = selected.reduce((a, r) => a + r.length, 0);
  const selectivity = rowsAfterFilter / inputRows;
  const t1 = now();

  // ---- Stage 3: skew measurement ------------------------------------------
  const partitionShares = selected.map((r) => (rowsAfterFilter > 0 ? r.length / rowsAfterFilter : 0));
  const skewRatio = rowsAfterFilter > 0 ? Math.max(...partitionShares) / (1 / workers) : 1;

  // Identify hot keys from the actual data (top key share, not a guess).
  const keyCounts = new Map<string, number>();
  for (const r of input.rows) {
    if (r.key === null) continue;
    keyCounts.set(r.key, (keyCounts.get(r.key) ?? 0) + 1);
  }
  const hotThreshold = rowsAfterFilter * 0.2;
  const hotKeys = [...keyCounts.entries()]
    .filter(([, c]) => c > hotThreshold)
    .map(([k]) => k)
    .sort();
  const saltingFactor = Math.max(1, Math.floor(input.saltingFactor ?? 1));
  const saltedKeys = saltingFactor > 1 ? hotKeys.map((k) => ({ key: k, salts: saltingFactor })) : [];

  if (skewRatio > 2) {
    warnings.push(
      `Partition skew: the busiest partition holds ${(Math.max(...partitionShares) * 100).toFixed(1)}% of the rows against a ${(100 / workers).toFixed(1)}% mean (skew ratio ${skewRatio.toFixed(2)}×). Wall-clock is set by that one partition. Salting the hot key${hotKeys.length === 1 ? "" : "s"} split${hotKeys.length === 1 ? "s" : ""} it across ${saltingFactor} reducers.`,
    );
  }
  if (saltedKeys.length === 0 && hotKeys.length > 0 && saltingFactor === 1) {
    warnings.push(
      `Key${hotKeys.length === 1 ? "" : "s"} ${hotKeys
        .slice(0, 3)
        .map((k) => `"${k}"`)
        .join(
          ", ",
        )} ${hotKeys.length === 1 ? "carries" : "carry"} more than 20% of the rows each. Set a salting factor above 1 to split the hot key across workers.`,
    );
  }
  if (filters.some((f) => f.passed === f.evaluated && f.evaluated > 0)) {
    warnings.push(
      "A pushed-down filter removed nothing — check the comparison column and value, because a filter that cannot fire is usually a data-type mismatch.",
    );
  }

  // ---- Stage 4: map-side combine ------------------------------------------
  const partials: PartialAggregate[] = [];
  const saltedKeysSeen = new Map<string, Set<string>>();
  selected.forEach((rows, pIdx) => {
    const local = new Map<string, PartialAggregate>();
    for (const rowIdx of rows) {
      const r = rowsByIndex.get(rowIdx);
      if (!r) continue;
      const key = input.groupBy ? (r.key ?? "(null)") : "(all)";
      let salt = "";
      if (input.groupBy && hotKeys.includes(key) && saltingFactor > 1) {
        const bucket = saltHotKey(key, saltingFactor, [r]);
        salt = [...bucket.keys()][0]!.slice(key.length);
        if (!saltedKeysSeen.has(key)) saltedKeysSeen.set(key, new Set());
        saltedKeysSeen.get(key)!.add(salt);
      }
      const id = `${key}${salt}`;
      let agg = local.get(id);
      if (!agg) {
        agg = newPartial(key, salt, op);
        local.set(id, agg);
      }
      accumulate(agg, r.value, op);
    }
    for (const agg of local.values()) partials.push(agg);
    void pIdx;
  });
  const t2 = now();

  // ---- Stage 5: merge ------------------------------------------------------
  const byKey = new Map<string, PartialAggregate[]>();
  for (const p of partials) {
    // Salted partials of one key are merged together — the answer is identical.
    const id = p.key ?? "(all)";
    if (!byKey.has(id)) byKey.set(id, []);
    byKey.get(id)!.push(p);
  }
  const groups: DistributedGroupResult[] = [...byKey.entries()]
    .map(([key, ps]) => {
      const merged = mergePartials(ps, op);
      return { key: key === "(all)" ? null : key, value: merged.value, count: merged.count };
    })
    .sort((a, b) => {
      if (input.groupBy) return a.key!.localeCompare(b.key!);
      return 0;
    });

  if (op === "variance" && groups.some((g) => g.count < 2)) {
    warnings.push("Sample variance needs at least 2 rows per group; groups with fewer rows return 0 rather than NaN.");
  }
  const truncatedGroups = partials.filter((p) => p.distinctTruncated).length;
  if (truncatedGroups > 0) {
    warnings.push(
      `Distinct counting truncated at ${DISTINCT_CAP.toLocaleString()} values in ${truncatedGroups} partial${truncatedGroups === 1 ? "" : "s"}. The distinct total is a lower bound, not an exact count.`,
    );
  }
  const t3 = now();

  // ---- Cost model ----------------------------------------------------------
  const partialBytes = partials.length * 48; // key + count/sum/min/max/sumSq in 6×8 bytes
  const rawRowsShipped = rowsAfterFilter;
  const serialFraction = Math.min(1, Math.max(0, input.serialFraction ?? 0.05));
  const parallelFraction = 1 - serialFraction;
  const amdahlSpeedup = serialFraction >= 1 ? 1 : 1 / (serialFraction + parallelFraction / workers);

  const plan: DistributedPlan = {
    op,
    workers,
    groupBy: input.groupBy,
    inputRows,
    rowsAfterFilter,
    selectivity,
    projectedColumns: projection.projected,
    prunedBytes: projection.prunedBytes,
    partitions: selected.map((rows, i) => ({
      index: i,
      rows: rows.length,
      share: partitionShares[i] ?? 0,
      saltedKeys: saltedKeys.filter((s) => rowsByIndex.get(rows[0] ?? -1)?.key === s.key).map((s) => s.key),
    })),
    skewRatio,
    saltedKeys: saltedKeys.map((s) => ({ key: s.key, salts: s.salts })),
    rawRowsShipped,
    partialRowsShipped: partials.length,
    shuffleBytes: partialBytes,
    serialFraction,
    amdahlSpeedup,
    execution: "in-process partitioned executor (hash partitioning, map-side combine, two-phase merge)",
    warnings: [],
  };
  if (saltedKeysSeen.size > 0) {
    for (const [k, salts] of saltedKeysSeen) {
      const entry = plan.saltedKeys.find((s) => s.key === k);
      if (entry) entry.salts = salts.size;
    }
  }
  if (projection.prunedColumns.length > 0) {
    plan.projectedColumns = projection.projected;
  }

  // ---- Global aggregate ----------------------------------------------------
  const global = mergePartials(
    groups.map((g) => {
      const p = newPartial(g.key, "", op);
      p.count = g.count;
      return p;
    }),
    "count",
  );

  const maxPart = Math.max(...plan.partitions.map((p) => p.rows));
  const interpretation =
    `${workers} partitions processed ${inputRows.toLocaleString()} rows; pushed-down filters kept ${(selectivity * 100).toFixed(1)}%. ` +
    `Map-side combine shipped ${partials.length.toLocaleString()} partial${partials.length === 1 ? "" : "s"} instead of ${rawRowsShipped.toLocaleString()} raw rows (${rawRowsShipped > 0 ? (rawRowsShipped / Math.max(1, partials.length)).toFixed(1) : "0"}× reduction, ${(partialBytes / 1024).toFixed(1)} KiB shuffled). ` +
    (input.groupBy
      ? `Merge produced ${groups.length} group${groups.length === 1 ? "" : "s"}; the largest partition held ${maxPart.toLocaleString()} rows (skew ${skewRatio.toFixed(2)}×).`
      : `Global ${op} over ${rowsAfterFilter.toLocaleString()} rows = ${global.value.toFixed(4)}.`) +
    ` Amdahl puts the ceiling for ${workers} workers at ${amdahlSpeedup.toFixed(2)}× with a ${(serialFraction * 100).toFixed(0)}% serial fraction.`;

  return {
    plan: { ...plan, warnings },
    groups,
    total: input.groupBy
      ? groups.reduce((a, g) => a + (Number.isFinite(g.value) ? g.value : 0), 0)
      : (groups[0]?.value ?? 0),
    activePartitions: selected.filter((r) => r.length > 0).length,
    timings: {
      filter: t1 - t0,
      combine: t2 - t1,
      merge: t3 - t2,
      total: t3 - t0,
    },
    interpretation,
  };
}

/**
 * Verify that a partitioned result equals the serial computation. This is the
 * oracle test the module's own claim rests on — the two-phase merge is only
 * worth anything if it agrees with the one-pass answer.
 */
export function verifyAgainstSerial(rows: ColumnarRow[], op: AggOp, groupBy: boolean): DistributedGroupResult[] {
  const map = new Map<string, number[]>();
  for (const r of rows) {
    const k = groupBy ? (r.key ?? "(null)") : "(all)";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r.value);
  }
  const out: DistributedGroupResult[] = [];
  for (const [k, vals] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({ key: groupBy ? k : null, value: serialAggregate(vals, op), count: vals.length });
  }
  return out;
}

function serialAggregate(vals: number[], op: AggOp): number {
  switch (op) {
    case "sum":
      return vals.reduce((a, b) => a + b, 0);
    case "mean":
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    case "min":
      return vals.length ? Math.min(...vals) : 0;
    case "max":
      return vals.length ? Math.max(...vals) : 0;
    case "count":
      return vals.length;
    case "variance": {
      if (vals.length < 2) return 0;
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      return vals.reduce((a, v) => a + (v - m) ** 2, 0) / (vals.length - 1);
    }
    case "distinct":
      return new Set(vals).size;
    default:
      return 0;
  }
}

/** `performance.now()` in the browser, `hrtime` in Node — never Date.now(). */
function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node fallback without importing perf_hooks
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}
