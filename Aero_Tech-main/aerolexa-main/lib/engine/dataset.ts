import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { serverEnv } from "@/lib/env";
import { ensureLocal, keys } from "@/lib/server/storage";
import type { ColumnDef, ColType, Granularity } from "@/lib/types";

export type Cell = string | number | boolean | null;

export interface ParsedDataset {
  columns: ColumnDef[];
  rows: Cell[][];
  /** total rows on disk (rows above may be a labelled sample) */
  totalRows: number;
}

export function dataDir(): string {
  return path.join(process.cwd(), serverEnv().DATA_DIR);
}

export function uploadsDir(): string {
  return path.join(dataDir(), "uploads");
}

export function rawFilePath(id: string): string {
  return path.join(uploadsDir(), `${id}.raw`);
}

export function ndjsonPath(id: string): string {
  return path.join(dataDir(), "parsed", `${id}.ndjson`);
}

/**
 * Resolve a dataset artifact to a readable local path, pulling it from object
 * storage on cache miss (S3 driver) or failing with a clear error when the
 * local file is absent (local driver). The returned path is streamable —
 * every reader in the app goes through this so multi-instance deployments
 * "just work" without changing any streaming code.
 */
export async function resolveReadable(key: string): Promise<string> {
  return ensureLocal(key);
}

/**
 * Stream the first `limit` rows of a normalized NDJSON dataset into memory.
 * Rows beyond the limit are counted but not loaded; callers label results as
 * sampled so the UI never misrepresents coverage.
 *
 * NOTE (bias): this is a HEAD slice. For training, prefer
 * `loadParsedDatasetSampled`, which draws a uniform-uniform sample over ALL
 * rows so models never fit only the file's head.
 */
export async function loadParsedDataset(
  id: string,
  limit = serverEnv().DATASET_ANALYSIS_LIMIT,
): Promise<{ rows: Cell[][]; totalRows: number }> {
  const file = await resolveReadable(keys.parsed(id));
  const rows: Cell[][] = [];
  let totalRows = 0;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
    if (!line.trim()) continue;
    totalRows++;
    if (rows.length < limit) {
      try {
        rows.push(JSON.parse(line) as Cell[]);
      } catch {
        // Skip corrupt line defensively — a data-quality banner covers this case upstream.
      }
    }
  }
  return { rows, totalRows };
}

/**
 * Seeded uniform sample of the FIRST `k` items of a stream — O(k) memory,
 * one pass, deterministic given the seed (Vitter 1985 Algorithm R).
 *
 * Every item has probability k/n of inclusion regardless of position: the
 * classic swap-in trick keeps the first k slots as the reservoir while the
 * stream advances, so an item at position i (0-based) survives with
 * probability k/(i+1) exactly. Unlike a head slice, this sees the WHOLE file
 * — training on row 10,000,000 of a capped dataset stays representative.
 */
export function seededReservoirSample<T>(
  stream: Iterable<T> | AsyncIterable<T>,
  k: number,
  seed = 42,
): Promise<{ sample: T[]; seen: number }> {
  const run = async (): Promise<{ sample: T[]; seen: number }> => {
    if (k <= 0) {
      let seen = 0;
      for await (const _ of stream as AsyncIterable<T>) {
        seen++;
        void _;
      }
      return { sample: [], seen };
    }
    let a = seed >>> 0;
    const rand = (): number => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const reservoir: T[] = [];
    let seen = 0;
    for await (const item of stream as AsyncIterable<T>) {
      if (reservoir.length < k) {
        reservoir.push(item);
      } else {
        const j = Math.floor(rand() * (seen + 1));
        if (j < k) reservoir[j] = item;
      }
      seen++;
    }
    return { sample: reservoir, seen };
  };
  return run();
}

/**
 * Uniform sample over the ENTIRE dataset (all rows on disk), for unbiased
 * training when the file exceeds the in-memory cap.
 *
 * Returns the same shape as `loadParsedDataset` plus `sampled: true` when
 * the sample is strict (`totalRows > rows.length`) so callers can keep the
 * honest-labelling contract: every surface that trains on a sample must say
 * so (the training route stamps it into the model card's methodology).
 */
export async function loadParsedDatasetSampled(
  id: string,
  limit = serverEnv().DATASET_ANALYSIS_LIMIT,
  seed = 42,
): Promise<{ rows: Cell[][]; totalRows: number; sampled: boolean }> {
  const file = await resolveReadable(keys.parsed(id));
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
  // The stream yields lines; the reservoir keeps at most `limit` of them.
  const lines = (async function* (): AsyncGenerator<string> {
    for await (const line of rl) {
      if (line.trim()) yield line;
    }
  })();
  const { sample, seen } = await seededReservoirSample(lines, limit, seed);
  const rows: Cell[][] = [];
  for (const line of sample) {
    try {
      rows.push(JSON.parse(line as string) as Cell[]);
    } catch {
      // Skip corrupt lines defensively — same policy as the head loader.
    }
  }
  return { rows, totalRows: seen, sampled: seen > rows.length };
}

export function columnIndex(columns: ColumnDef[], name: string | null | undefined): number {
  if (!name) return -1;
  return columns.findIndex((c) => c.name === name);
}

/** Coerce a cell to a finite number using the declared column type. */
export function cellNumber(cell: Cell | undefined): number {
  if (cell === null || cell === undefined || cell === "") return Number.NaN;
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : Number.NaN;
  if (typeof cell === "boolean") return cell ? 1 : 0;
  const n = Number(String(cell).replace(/[,$\s%€£]/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

export function cellString(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "boolean") return cell ? "true" : "false";
  return String(cell).trim();
}

/** Parse a cell as a Date; returns null when not parseable. */
export function cellDate(cell: Cell | undefined): Date | null {
  const s = cellString(cell);
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1900 && d.getFullYear() < 2200) return d;
  return null;
}

/**
 * Column values as numbers, honouring the column's declared type and silently
 * dropping rows where the value cannot be read as a number.
 */
export function numericColumn(rows: Cell[][], columns: ColumnDef[], name: string | null): number[] {
  const idx = columnIndex(columns, name);
  if (idx < 0) return [];
  const values: number[] = [];
  const type = columns[idx]?.type;
  for (const row of rows) {
    const cell = row[idx];
    if (type === "number" || type === "date") {
      const n = cellNumber(cell);
      if (Number.isFinite(n)) values.push(n);
    } else {
      const n = cellNumber(cell);
      if (Number.isFinite(n)) values.push(n);
    }
  }
  return values;
}

export function categoricalValues(rows: Cell[][], columns: ColumnDef[], name: string | null): (string | null)[] {
  const idx = columnIndex(columns, name);
  if (idx < 0) return [];
  return rows.map((row) => {
    const s = cellString(row[idx]);
    return s === "" ? null : s;
  });
}

/** Distinct categorical values with counts, sorted descending by count. */
export function valueCounts(values: (string | null)[], topN = 1000): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v === null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const entries = [...counts.entries()].map(([value, count]) => ({ value, count }));
  entries.sort((a, b) => b.count - a.count);
  return entries.slice(0, topN);
}

// ---------------------------------------------------------------------------
// Date bucketing
// ---------------------------------------------------------------------------

export function bucketKey(d: Date, granularity: Granularity): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  switch (granularity) {
    case "day":
      return `${y}-${m}-${day}`;
    case "week": {
      // ISO week number
      const date = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
      const dayNum = (date.getUTCDay() + 6) % 7;
      date.setUTCDate(date.getUTCDate() - dayNum + 3);
      const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
      const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
      firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
      const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
      return `${y}-W${String(week).padStart(2, "0")}`;
    }
    case "month":
      return `${y}-${m}`;
    case "quarter":
      return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case "year":
      return String(y);
  }
}

export function bucketLabel(key: string, granularity: Granularity): string {
  if (granularity === "month") {
    const [y, m] = key.split("-");
    const label = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    return label;
  }
  if (granularity === "quarter") {
    const [y, q] = key.split("-Q");
    return `Q${q} ${y}`;
  }
  return key;
}

export interface BucketedPoint {
  key: string;
  label: string;
  /** aggregation value (sum, mean, count) */
  value: number;
  count: number;
}

/**
 * Aggregate a numeric column across a date column at a granularity.
 * Missing/empty buckets between first and last period are zero-filled so line
 * charts don't visually bridge large gaps silently.
 */
export function bucketByDate(
  rows: Cell[][],
  columns: ColumnDef[],
  dateCol: string,
  metricCol: string,
  granularity: Granularity,
  aggregate: "sum" | "avg" = "sum",
): BucketedPoint[] {
  const dateIdx = columnIndex(columns, dateCol);
  const metricIdx = columnIndex(columns, metricCol);
  const buckets = new Map<string, { sum: number; count: number }>();
  let minKey: string | null = null;
  let maxKey: string | null = null;
  const rowsToUse = dateIdx < 0 || metricIdx < 0 ? [] : rows;
  for (const row of rowsToUse) {
    const d = cellDate(row[dateIdx]);
    if (!d) continue;
    const v = cellNumber(row[metricIdx]);
    if (!Number.isFinite(v)) continue;
    const key = bucketKey(d, granularity);
    const cur = buckets.get(key) ?? { sum: 0, count: 0 };
    cur.sum += v;
    cur.count += 1;
    buckets.set(key, cur);
    if (!minKey || key < minKey) minKey = key;
    if (!maxKey || key > maxKey) maxKey = key;
  }
  if (!minKey || !maxKey) return [];
  const keys = zeroFillKeys(minKey, maxKey, granularity);
  return keys.map((key) => {
    const b = buckets.get(key) ?? { sum: 0, count: 0 };
    return {
      key,
      label: bucketLabel(key, granularity),
      value: aggregate === "avg" && b.count > 0 ? b.sum / b.count : b.sum,
      count: b.count,
    };
  });
}

/** Produce every bucket key between two keys (inclusive) at a granularity. */
export function zeroFillKeys(minKey: string, maxKey: string, granularity: Granularity): string[] {
  if (granularity === "day" || granularity === "month" || granularity === "quarter" || granularity === "year") {
    const start = keyToDate(minKey);
    const end = keyToDate(maxKey);
    if (!start || !end || end < start) return [minKey, maxKey];
    const keys: string[] = [];
    const cursor = new Date(start);
    let guard = 0;
    while (cursor <= end && guard < 2000) {
      keys.push(bucketKey(cursor, granularity));
      advanceDate(cursor, granularity);
      guard++;
    }
    return keys;
  }
  // Week keys can't be enumerated simply — return observed keys only.
  return [minKey];
}

function keyToDate(key: string): Date | null {
  if (key.includes("-Q")) {
    const [y, q] = key.split("-Q");
    return new Date(Date.UTC(Number(y), (Number(q) - 1) * 3, 1));
  }
  if (/^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split("-");
    return new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    return new Date(`${key}T00:00:00Z`);
  }
  const y = Number(key);
  if (/^\d{4}$/.test(key)) return new Date(Date.UTC(y, 0, 1));
  return null;
}

function advanceDate(d: Date, granularity: Granularity): void {
  switch (granularity) {
    case "day":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "month":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case "quarter":
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case "year":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
    default:
      d.setUTCDate(d.getUTCDate() + 7);
  }
}

/** Apply a categorical (exact-match) filter to the row set. */
export function applyCategoricalFilter(
  rows: Cell[][],
  columns: ColumnDef[],
  filterCol: string | null | undefined,
  filterValue: string | null | undefined,
): Cell[][] {
  if (!filterCol || filterValue === null || filterValue === undefined) return rows;
  const idx = columnIndex(columns, filterCol);
  if (idx < 0) return rows;
  return rows.filter((row) => cellString(row[idx]) === filterValue);
}

export function detectGranularity(spans: number): Granularity {
  // Number of distinct date values → sensible default bucket
  if (spans <= 60) return "day";
  if (spans <= 2 * 52) return "week";
  if (spans <= 8 * 12) return "month";
  if (spans <= 8 * 4) return "quarter";
  return "month";
}

/** Lightweight type inference over sample cell values. */
export function inferType(sample: Cell[]): ColType {
  let numbers = 0;
  let dates = 0;
  let booleans = 0;
  let total = 0;
  for (const cell of sample) {
    if (cell === null || cell === undefined || cell === "") continue;
    total++;
    if (typeof cell === "number") {
      numbers++;
      continue;
    }
    if (typeof cell === "boolean") {
      booleans++;
      continue;
    }
    const s = String(cell).trim();
    if (s.toLowerCase() === "true" || s.toLowerCase() === "false") {
      booleans++;
      continue;
    }
    if (Number.isFinite(Number(s.replace(/[,$\s%€£]/g, "")))) {
      numbers++;
      continue;
    }
    if (cellDate(cell)) {
      dates++;
      continue;
    }
  }
  if (total === 0) return "string";
  const numShare = numbers / total;
  const dateShare = dates / total;
  const boolShare = booleans / total;
  if (boolShare >= 0.95) return "boolean";
  if (numShare >= 0.85) return "number";
  if (dateShare >= 0.85) return "date";
  return "string";
}

/** Convert a column's cells to a different declared type (re-cast). */
export function recastCell(cell: Cell, target: ColType): Cell {
  if (cell === null || cell === undefined || cell === "") return null;
  switch (target) {
    case "number": {
      const n = cellNumber(cell);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean": {
      if (typeof cell === "boolean") return cell;
      const s = cellString(cell).toLowerCase();
      if (["true", "yes", "1", "y"].includes(s)) return true;
      if (["false", "no", "0", "n"].includes(s)) return false;
      return null;
    }
    case "date": {
      const s = cellString(cell);
      const n = cellNumber(cell);
      // Excel serial date (number) → ISO when plausible range
      if (Number.isFinite(n) && n > 20000 && n < 80000) {
        const d = new Date(Math.round((n - 25569) * 86400 * 1000));
        return d.toISOString().slice(0, 10);
      }
      const d = cellDate(s);
      return d ? d.toISOString().slice(0, 10) : null;
    }
    case "string":
    default:
      return cellString(cell);
  }
}
