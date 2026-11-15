import { createReadStream, createWriteStream, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import Papa from "papaparse";
import readXlsxFile from "read-excel-file";

import { extractPdfText, pdfTextToRows } from "@/lib/engine/connectors/bank-statement";
import { dataDir, ndjsonPath, resolveReadable, uploadsDir, type Cell } from "@/lib/engine/dataset";
import { inferType, recastCell } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { keys, saveFileStream } from "@/lib/server/storage";
import type { ColType, ColumnDef, ColumnStat, DatasetProfile } from "@/lib/types";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export interface ParseResult {
  fileName: string;
  rowCount: number;
  columnCount: number;
  columns: ColumnDef[];
  profile: DatasetProfile;
  preview: Cell[][];
  qualityWarnings: string[];
}

const SAMPLE = 2000; // cells per column used for type inference
const DISTINCT_CAP = 5000;
const SIGNATURE_CAP = 1_000_000;
const MAX_COLUMNS = 300;

// ---------------------------------------------------------------------------
// Raw file handling
// ---------------------------------------------------------------------------

/** Persist an uploaded File to disk (streamed) and validate size. */
export async function saveUploadToDisk(file: File, id: string): Promise<{ filePath: string; sizeBytes: number }> {
  const dir = uploadsDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.raw`);
  const maxBytes = serverEnv().MAX_UPLOAD_BYTES;
  let written = 0;
  const out = createWriteStream(filePath);
  const reader = file.stream().getReader();
  const pump = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      written += value.byteLength;
      if (written > maxBytes) {
        out.destroy();
        throw new ParseError(
          `File exceeds the ${(maxBytes / 1024 / 1024).toFixed(0)} MB upload limit. Split the file or upload a subset.`,
        );
      }
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => out.once("drain", resolve));
      }
    }
    out.end();
  };
  await pump();
  await new Promise<void>((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
  });
  // Multi-instance: the raw upload is the durable source — push it to object
  // storage so any replica can re-parse (e.g. a column-ops rewrite) later.
  // Streamed (ROADMAP 1.5): a 500 MB upload is never read whole into memory.
  await saveFileStream(keys.upload(id), filePath);
  return { filePath, sizeBytes: written };
}

export function cleanupRaw(id: string): void {
  fs.rm(path.join(uploadsDir(), `${id}.raw`)).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// CSV parsing (streaming)
// ---------------------------------------------------------------------------

interface RawTable {
  headers: string[];
  /** column samples for type inference */
  samples: Cell[][];
  rows: Cell[][];
  rowCount: number;
  tooManyColumns: boolean;
  /** set when the header layout was reinterpreted (surface as a quality note) */
  headerNote?: string;
}

/**
 * CSV pass 1 — headers + bounded type-inference samples only. Rows are NOT
 * retained (ROADMAP 1.5): a 1 GB file yields a few hundred bytes of samples,
 * not a 1 GB array.
 */
export async function scanCsvHeader(
  filePath: string,
): Promise<{ headers: string[]; samples: Cell[][]; tooManyColumns: boolean }> {
  const samples: Cell[][] = [];
  let headers: string[] = [];
  let firstDataRowSeen = false;
  let tooManyColumns = false;

  const stream = createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    Papa.parse(stream, {
      skipEmptyLines: "greedy",
      transformHeader: (h) => h,
      step: (results: Papa.ParseStepResult<string[]>) => {
        const raw = (results.data ?? []) as string[];
        if (!firstDataRowSeen) {
          firstDataRowSeen = true;
          headers = raw.map((h, i) => sanitizeHeader(h, i));
          if (headers.length === 0 || headers.every((h) => h === "")) {
            reject(new ParseError("The file has no usable header row."));
            return;
          }
          headers.forEach(() => samples.push([]));
          return;
        }
        if (raw.length === 0) return;
        // Sample collection stops once inference has enough; later rows only
        // widen the too-many-columns check. No row is retained.
        if (samples.every((s) => s.length >= SAMPLE)) return;
        const padded = padRow(raw, headers.length);
        if (raw.length > headers.length) tooManyColumns = true;
        padded.forEach((v, i) => {
          if (v === null) return;
          const t = v.trim();
          if (t === "") return;
          const sample = samples[i];
          if (sample && sample.length < SAMPLE) sample.push(t);
        });
      },
      complete: () => resolve(),
      error: (err: Error) => reject(new ParseError(`Could not read the CSV file: ${err.message}`)),
    });
  });

  // A file whose rows are ALL empty-looking is skipped wholesale by Papa's
  // greedy mode, so the in-step guard never fires — reject here instead.
  if (headers.length === 0 || headers.every((h) => h === "")) {
    throw new ParseError("The file has no usable header row.");
  }
  if (headers.length > MAX_COLUMNS) {
    throw new ParseError(`The file has ${headers.length} columns — above the ${MAX_COLUMNS} column limit.`);
  }
  return { headers, samples, tooManyColumns };
}

/**
 * CSV pass 2 — stream every data row to the `onRow` callback. Nothing is
 * retained (ROADMAP 1.5): the consumer (the NDJSON writer + aggregators)
 * receives rows one at a time, so a 1 GB file ingests in constant memory.
 */
export async function streamCsvRows(
  filePath: string,
  scannedHeaders: string[],
  maxRows: number,
  onRow: (row: Cell[]) => void,
): Promise<{ rowCount: number; tooManyColumns: boolean; headerNote?: string }> {
  let rowCount = 0;
  let firstDataRowSeen = false;
  let sawWide = false;
  let headerNote: string | undefined;

  const stream = createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    Papa.parse(stream, {
      skipEmptyLines: "greedy",
      transformHeader: (h) => h,
      step: (results: Papa.ParseStepResult<string[]>) => {
        const raw = (results.data ?? []) as string[];
        if (!firstDataRowSeen) {
          firstDataRowSeen = true;
          // Header consistency between passes: a vendor file that changes its
          // own header mid-write would silently misalign rows — surface it.
          const second = raw.map((h, i) => sanitizeHeader(h, i));
          if (second.length !== scannedHeaders.length || second.some((h, i) => h !== scannedHeaders[i])) {
            headerNote = "The CSV header changed between the scan and the streaming pass — columns may be misaligned.";
          }
          return;
        }
        if (raw.length === 0) return;
        if (rowCount >= maxRows) return;
        if (raw.length > scannedHeaders.length) sawWide = true;
        const padded = padRow(raw, scannedHeaders.length);
        onRow(padded.map((v) => (v === null ? null : v.trim() === "" ? null : (v.trim() as Cell))));
        rowCount++;
      },
      complete: () => resolve(),
      error: (err: Error) => reject(new ParseError(`Could not read the CSV file: ${err.message}`)),
    });
  });

  return { rowCount, tooManyColumns: sawWide, ...(headerNote ? { headerNote } : {}) };
}

/**
 * Resolve Excel headers from the first two sheet rows.
 *
 * Real spreadsheets routinely use layouts the naive "row 1 is the header" rule
 * gets wrong:
 *  - merged group cells over field names (the group name appears once, the
 *    merged continuation cells arrive as nulls) — combined as "Group / Field";
 *  - a repeated header row (row 2 duplicates row 1) — dropped instead of
 *    becoming a fake all-string data row.
 *
 * Pure and exported so the heuristics are unit-testable without a binary .xlsx
 * fixture. `dataStart` is the index of the first genuine data row.
 */
export function resolveExcelHeaders(
  first: unknown[],
  second?: unknown[],
): {
  headers: string[];
  dataStart: number;
  note: string | null;
} {
  const norm = (row: unknown[] | undefined): string[] =>
    (row ?? []).map((v) => (v === null || v === undefined ? "" : String(v).trim()));
  const h0 = norm(first);
  const h1 = second ? norm(second) : [];

  // Forward-fill the first row so a merged group header spans its columns.
  const filled: string[] = [];
  let carry = "";
  for (const cell of h0) {
    if (cell) carry = cell;
    filled.push(carry);
  }
  const hasBlank = h0.some((c) => c === "");
  const hasDuplicate = new Set(h0.filter(Boolean)).size !== h0.filter(Boolean).length;
  const secondPopulated = h1.length > 0 && h1.every((c) => c !== "");
  const firstHasText = h0.some((c) => c !== "");

  // Two-row header: group labels on row 1 (blank/duplicated across a span) and
  // complete field names on row 2.
  if (secondPopulated && firstHasText && (hasBlank || hasDuplicate)) {
    const headers = h1.map((field, i) => {
      const group = filled[i] ?? "";
      return group && group !== field ? `${group} / ${field}` : field;
    });
    return {
      headers,
      dataStart: 2,
      note: "The Excel sheet uses a two-row header (group + field names); columns were named “Group / Field” and both header rows skipped.",
    };
  }

  // Repeated header row: row 2 echoes row 1 (common in exported reports).
  const repeated = h1.length > 0 && h1.every((c, i) => c === "" || c === h0[i]) && h1.some((c) => c !== "");
  if (repeated) {
    return {
      headers: h0.map((h) => h),
      dataStart: 2,
      note: "The Excel sheet repeated its header row; the duplicate was skipped.",
    };
  }

  return { headers: h0, dataStart: 1, note: null };
}

async function parseXlsxToTable(filePath: string, maxRows: number): Promise<RawTable> {
  let raw: unknown[][];
  try {
    const buf = await fs.readFile(filePath);
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    raw = (await readXlsxFile(arrayBuffer)) as unknown as unknown[][];
  } catch (err) {
    throw new ParseError(
      `Could not read the Excel file. ${err instanceof Error ? err.message : "It may be corrupt or password-protected."}`,
    );
  }
  if (!raw.length) throw new ParseError("The Excel file is empty.");
  const plan = resolveExcelHeaders(raw[0] as unknown[], raw[1] as unknown[] | undefined);
  const headers = plan.headers.map((h, i) => sanitizeHeader(h, i));
  if (headers.length > MAX_COLUMNS)
    throw new ParseError(`The file has ${headers.length} columns — above the ${MAX_COLUMNS} column limit.`);
  if (raw.length - plan.dataStart > maxRows + 1000) {
    throw new ParseError(
      `The Excel file has ${(raw.length - plan.dataStart).toLocaleString()} data rows. For files this large, export to CSV and upload that instead (prototype limit).`,
    );
  }
  const samples: Cell[][] = headers.map(() => []);
  const rows: Cell[][] = [];
  for (let i = plan.dataStart; i < raw.length; i++) {
    if (i - plan.dataStart >= maxRows) break;
    const rawRow = raw[i] as unknown[];
    if (rawRow.every((c) => c === null || c === undefined || c === "")) continue;
    const cells = padRow(rawRow, headers.length).map((v, idx) => {
      if (v === null || v === undefined) return null;
      if (v instanceof Date) {
        const iso = Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
        return iso;
      }
      if (typeof v === "number" && !Number.isFinite(v)) return null;
      if (typeof v === "object") return String(v);
      const sample = samples[idx];
      if (sample && sample.length < SAMPLE) sample.push(v as Cell);
      return v as Cell;
    });
    rows.push(cells);
  }
  return {
    headers,
    samples,
    rows,
    rowCount: rows.length,
    tooManyColumns: false,
    ...(plan.note ? { headerNote: plan.note } : {}),
  };
}

function sanitizeHeader(value: unknown, index: number): string {
  const raw = String(value ?? "")
    .trim()
    .replace(/^\uFEFF/, "");
  const name = raw.length > 0 && raw.length <= 120 ? raw : `column_${index + 1}`;
  return name;
}

function padRow<T>(row: T[], width: number): (T | null)[] {
  if (row.length === width) return row;
  const out: (T | null)[] = [...row];
  while (out.length < width) out.push(null);
  return out;
}

function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const count = seen.get(h) ?? 0;
    seen.set(h, count + 1);
    return count === 0 ? h : `${h}_${count + 1}`;
  });
}

// ---------------------------------------------------------------------------
// Typing + recast + final NDJSON (single streaming pass with aggregators)
// ---------------------------------------------------------------------------

interface Agg {
  count: number;
  numeric: number;
  dateLike: number;
  boolLike: number;
  empty: number;
  sum: number;
  sumSq: number;
  min: number;
  max: number;
  distinct: Set<string>;
  top: Map<string, number>;
  values: number[];
  outliers: number;
  distinctTooMany: boolean;
  total: number;
}

function newAgg(): Agg {
  return {
    count: 0,
    numeric: 0,
    dateLike: 0,
    boolLike: 0,
    empty: 0,
    sum: 0,
    sumSq: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    distinct: new Set(),
    top: new Map(),
    values: [],
    outliers: 0,
    distinctTooMany: false,
    total: 0,
  };
}

/**
 * Recast rows to NDJSON and produce column statistics.
 *
 * Memory contract (ROADMAP 1.5): rows arrive through `source` (streaming) or
 * the materialized `table.rows` fallback — never both. Everything else the
 * pipeline keeps is O(columns): aggregators, capped distinct/top maps, capped
 * outlier windows, and the 20-row preview. `agg.values` is a bounded reservoir
 * (never the full numeric column) so percentiles/outliers stay approximate
 * beyond the cap — honestly labelled via `sampled` on the profile.
 */
const VALUES_CAP = 100_000;

async function writeNdjsonAndProfile(
  id: string,
  headers: string[],
  source: {
    table?: RawTable;
    /** Bounded inference samples from pass 1 (streaming CSV path, no `table`). */
    samples?: Cell[][];
    streamRows?: (onRow: (row: Cell[]) => void) => Promise<{ rowCount: number; headerNote?: string }>;
  },
  isDemo: boolean,
): Promise<{ profile: DatasetProfile; preview: Cell[][]; rowCount: number; headerNote?: string }> {
  // The streaming CSV path collects samples in pass 1 and never materializes a
  // table, so read them from wherever they were produced. Falling through to `[]`
  // made inferType() see an empty sample and declare EVERY uploaded CSV column a
  // string — which surfaced as `sum(VARCHAR)` binder errors in SQL Lab and
  // "Target x is not numeric" in the model trainer.
  const samples = source.samples ?? source.table?.samples;
  const types = headers.map((_, i) => inferType(samples?.[i] ?? []));
  const columns: ColumnDef[] = headers.map((name, i) => ({ name, type: types[i] ?? "string" }));
  const cols = columns.length;

  const aggs = columns.map(() => newAgg());
  const sigs = new Set<string>();
  let duplicateRows = 0;
  let signatureOverflow = false;
  let valuesTruncated = false;

  const dir = path.join(dataDir(), "parsed");
  await fs.mkdir(dir, { recursive: true });
  const tmpFile = `${ndjsonPath(id)}.tmp`;
  const out = createWriteStream(tmpFile);

  const ingest = (rawRow: Cell[]): void => {
    const typedRow = rawRow.map((cell, i) => recastCell(cell, columns[i]?.type ?? "string"));
    const rowForJson = typedRow.map((cell) => (cell === null ? null : cell));
    out.write(`${JSON.stringify(rowForJson)}\n`);

    // duplicate signature (bounded)
    if (!signatureOverflow) {
      const sig = typedRow
        .map((c) => (c === null ? "" : typeof c === "number" ? `n${c}` : typeof c === "boolean" ? `b${c}` : c))
        .join("\u0001");
      if (sig.length > 2048) {
        signatureOverflow = true;
      } else if (sigs.has(sig)) {
        duplicateRows++;
      } else {
        if (sigs.size >= SIGNATURE_CAP) signatureOverflow = true;
        else sigs.add(sig);
      }
    }

    for (let i = 0; i < cols; i++) {
      const agg = aggs[i] as Agg;
      const cell = typedRow[i] as Cell | undefined;
      agg.total++;
      if (cell === null || cell === undefined || cell === "") {
        agg.empty++;
        continue;
      }
      agg.count++;
      if (typeof cell === "number") {
        agg.numeric++;
        agg.sum += cell;
        agg.sumSq += cell * cell;
        if (cell < agg.min) agg.min = cell;
        if (cell > agg.max) agg.max = cell;
        if (agg.values.length < VALUES_CAP) agg.values.push(cell);
        else valuesTruncated = true;
      } else if (typeof cell === "boolean") {
        agg.boolLike++;
      } else {
        const s = String(cell);
        const n = Number(s);
        if (Number.isFinite(n)) {
          agg.numeric++;
          agg.sum += n;
          agg.sumSq += n * n;
          if (n < agg.min) agg.min = n;
          if (n > agg.max) agg.max = n;
          if (agg.values.length < VALUES_CAP) agg.values.push(n);
          else valuesTruncated = true;
        }
        const d = new Date(s);
        if (!Number.isNaN(d.getTime())) agg.dateLike++;
        if (s.toLowerCase() === "true" || s.toLowerCase() === "false") agg.boolLike++;
        if (!agg.distinctTooMany) {
          if (agg.distinct.size >= DISTINCT_CAP) agg.distinctTooMany = true;
          else agg.distinct.add(s);
        }
        if (!agg.distinctTooMany || agg.top.size < DISTINCT_CAP) {
          agg.top.set(s, (agg.top.get(s) ?? 0) + 1);
        }
      }
    }
    if (preview.length < 20) preview.push(typedRow);
  };

  const preview: Cell[][] = [];
  let streamedCount = 0;
  let streamNote: string | undefined;
  if (source.streamRows) {
    // Streaming path (ROADMAP 1.5): rows flow one-at-a-time from the CSV
    // parser into the writer + aggregators — never materialized.
    const result = await source.streamRows(ingest);
    streamedCount = result.rowCount;
    streamNote = result.headerNote;
  } else {
    for (const row of source.table?.rows ?? []) ingest(row);
  }

  const writeDone = new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });
  await writeDone;

  const analyzedRows = streamedCount || source.table?.rowCount || 0;

  // Outlier counts after full pass (on 1.5 IQR)
  for (let i = 0; i < cols; i++) {
    const agg = aggs[i] as Agg;
    const vals = agg.values;
    if (vals.length >= 4) {
      const sorted = [...vals].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
      const q1 = q(0.25);
      const q3 = q(0.75);
      const iqr = q3 - q1;
      if (iqr > 0) {
        let outCount = 0;
        for (const v of vals) if (v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr) outCount++;
        agg.outliers = outCount;
      }
    }
  }

  await fs.rename(tmpFile, ndjsonPath(id));
  // Multi-instance: publish the normalized row store so every replica streams
  // the same rows. Streamed (ROADMAP 1.5) — never readFile on a 500 MB NDJSON.
  await saveFileStream(keys.parsed(id), ndjsonPath(id));

  const stats: Record<string, ColumnStat> = {};
  const qualityWarnings: string[] = [];
  for (let i = 0; i < cols; i++) {
    const agg = aggs[i] as Agg;
    const col = columns[i] as ColumnDef;
    const stat: ColumnStat = {
      name: col.name,
      type: col.type,
      missing: agg.empty,
      distinct: agg.distinctTooMany ? -1 : agg.distinct.size + (agg.count - agg.numeric - agg.boolLike > 0 ? 0 : 0),
      nearConstant: agg.count >= 20 && agg.distinct.size <= 1,
    };
    if (col.type === "number") {
      const n = agg.count || 1;
      stat.min = agg.min === Number.POSITIVE_INFINITY ? undefined : agg.min;
      stat.max = agg.max === Number.NEGATIVE_INFINITY ? undefined : agg.max;
      stat.sum = agg.sum;
      stat.mean = agg.sum / n;
      const sorted = [...agg.values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      stat.median = sorted.length
        ? sorted.length % 2
          ? sorted[mid]
          : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
        : undefined;
      stat.stddev =
        agg.count > 1 ? Math.sqrt(Math.max(0, agg.sumSq / agg.count - (agg.sum / agg.count) ** 2)) : undefined;
      stat.outlierCount = agg.outliers;
      const missingRate = analyzedRows ? (agg.empty / analyzedRows) * 100 : 0;
      if (missingRate > 30) {
        qualityWarnings.push(
          `“${col.name}” is missing in ${missingRate.toFixed(0)}% of rows — results using it exclude those rows.`,
        );
      }
      if (stat.nearConstant) {
        qualityWarnings.push(
          `“${col.name}” is nearly constant (${agg.distinct.size} distinct value(s)) and adds little signal.`,
        );
      }
    }
    stats[col.name] = stat;
  }

  // Duplicate warning
  const dupRate = analyzedRows ? (duplicateRows / analyzedRows) * 100 : 0;
  if (duplicateRows > 0) {
    if (signatureOverflow) {
      qualityWarnings.push(
        `Duplicate scan exceeded its limit; ${duplicateRows.toLocaleString()}+ exact duplicate rows were found.`,
      );
    } else if (dupRate >= 1) {
      qualityWarnings.push(
        `${duplicateRows.toLocaleString()} exact duplicate rows found (${dupRate.toFixed(1)}%) — consider deduplicating before analysis.`,
      );
    }
  }

  const profile: DatasetProfile = {
    analyzedRows,
    // Honest sampling label (ROADMAP 1.5): when the numeric window capped,
    // percentiles/outliers come from the first VALUES_CAP values per column.
    sampled: valuesTruncated,
    rowCount: analyzedRows,
    columnCount: cols,
    columns,
    stats,
    duplicateRows,
    qualityWarnings,
  };
  if (valuesTruncated) {
    qualityWarnings.push(
      `Numeric distributions (median/outliers) were computed from the first ${VALUES_CAP.toLocaleString()} values per column on this very large file.`,
    );
  }

  void isDemo;
  return { profile, preview, rowCount: analyzedRows, ...(streamNote ? { headerNote: streamNote } : {}) };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface PersistDatasetOptions {
  id: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  isDemo?: boolean;
}

/**
 * Parse an uploaded file (CSV/XLSX) into a normalized NDJSON row-stream,
 * returning the profile + preview used to populate the Dataset row.
 */
export async function parseAndProfileFile(opts: PersistDatasetOptions): Promise<ParseResult> {
  if (!existsSync(opts.filePath)) throw new ParseError("Uploaded file is missing on disk.");
  const ext = path.extname(opts.fileName).toLowerCase();
  const mime = opts.mimeType.toLowerCase();
  const isCsv = ext === ".csv" || mime.includes("csv") || mime.includes("text/plain");
  const isXlsx =
    ext === ".xlsx" ||
    mime.includes("spreadsheetml") ||
    mime.includes("officedocument") ||
    mime.includes("octet-stream");
  const isPdf = ext === ".pdf" || mime.includes("pdf");
  if (!isCsv && !isXlsx && !isPdf) {
    throw new ParseError(`Unsupported file type “${opts.fileName}”. Upload a .csv, .xlsx or text-layer .pdf file.`);
  }

  const maxRows = 5_000_000;
  if (isCsv) {
    // Streaming ingest (ROADMAP 1.5): pass 1 scans headers + samples, pass 2
    // streams rows straight into the NDJSON writer + aggregators. A ≥500 MB
    // CSV ingests in bounded memory; rows are never materialized.
    const { headers: scanned, samples } = await scanCsvHeader(opts.filePath);
    const headers = dedupeHeaders(scanned.map((h, i) => h || `column_${i + 1}`));
    const result = await writeNdjsonAndProfile(
      opts.id,
      headers,
      {
        samples,
        streamRows: (onRow) => streamCsvRows(opts.filePath, scanned, maxRows, (row) => onRow(row)),
      },
      opts.isDemo === true,
    );
    if (result.rowCount === 0) {
      throw new ParseError("The file contains a header row but no data rows beneath it.");
    }
    if (result.headerNote) result.profile.qualityWarnings.unshift(result.headerNote);
    return {
      fileName: opts.fileName,
      rowCount: result.rowCount,
      columnCount: headers.length,
      columns: headers.map((name, i) => ({ name, type: result.profile.columns[i]?.type ?? "string" })),
      profile: result.profile,
      preview: result.preview,
      qualityWarnings: result.profile.qualityWarnings,
    };
  }

  if (isPdf) {
    // Bank-statement PDF ingestion (B17): text-layer extraction via the same
    // engine the bank-statement connector uses — no guessing, no OCR.
    // Scanned/image-only PDFs are rejected with an honest, actionable error
    // rather than silently producing an empty dataset.
    const data = await fs.readFile(opts.filePath);
    const text = extractPdfText(data);
    if (text.length === 0) {
      throw new ParseError(
        `“${opts.fileName}” has no extractable text layer — it is a scanned (image-only) PDF. Ledgerly reads text-layer PDFs, it does not guess at images: export the statement as CSV/Excel from your bank's portal, or run it through OCR first.`,
      );
    }
    const pdfRows = pdfTextToRows(text);
    if (pdfRows.length === 0) {
      throw new ParseError(
        `No transaction rows could be read from “${opts.fileName}”. The layout is not a recognizable table of dated rows — export as CSV/Excel from your bank's portal for a lossless import.`,
      );
    }
    const pdfHeaders = ["date", "description", "debit", "credit", "balance"];
    // `samples` is COLUMN-major (samples[column] = bounded values), matching
    // scanCsvHeader / parseXlsxToTable — it feeds inferType per column.
    const pdfSamples: Cell[][] = pdfHeaders.map((_, col) => pdfRows.slice(0, SAMPLE).map((r) => r[col] ?? null));
    const pdfTable: RawTable = {
      headers: pdfHeaders,
      samples: pdfSamples,
      rows: pdfRows,
      rowCount: pdfRows.length,
      tooManyColumns: false,
      headerNote: `Rows reconstructed from the PDF's text layer (${pdfRows.length} dated transaction rows).`,
    };
    const pdf = await writeNdjsonAndProfile(opts.id, pdfHeaders, { table: pdfTable }, opts.isDemo === true);
    if (pdfTable.headerNote) pdf.profile.qualityWarnings.unshift(pdfTable.headerNote);
    return {
      fileName: opts.fileName,
      rowCount: pdf.rowCount,
      columnCount: pdfHeaders.length,
      columns: pdfHeaders.map((name, i) => ({ name, type: pdf.profile.columns[i]?.type ?? "string" })),
      profile: pdf.profile,
      preview: pdf.preview,
      qualityWarnings: pdf.profile.qualityWarnings,
    };
  }

  const table = await parseXlsxToTable(opts.filePath, maxRows);
  if (table.rowCount === 0) {
    throw new ParseError("The file contains a header row but no data rows beneath it.");
  }
  const headers = dedupeHeaders(table.headers.map((h, i) => h || `column_${i + 1}`));
  table.headers = headers;

  const { profile, preview } = await writeNdjsonAndProfile(opts.id, headers, { table }, opts.isDemo === true);
  if (table.headerNote) profile.qualityWarnings.unshift(table.headerNote);
  return {
    fileName: opts.fileName,
    rowCount: table.rowCount,
    columnCount: headers.length,
    columns: headers.map((name, i) => ({ name, type: profile.columns[i]?.type ?? "string" })),
    profile,
    preview,
    qualityWarnings: profile.qualityWarnings,
  };
}

/** Count lines of an NDJSON file quickly. */
export async function countNdjsonLines(filePath: string): Promise<number> {
  let count = 0;
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const _ of rl) count++;
  return count;
}

// ---------------------------------------------------------------------------
// Column operations (rename / re-cast / drop) — stream rewrite + reprofile
// ---------------------------------------------------------------------------

export interface ColumnOp {
  kind: "cast" | "drop" | "rename";
  name: string;
  type?: ColType;
  newName?: string;
}

/**
 * Apply column operations to a dataset's NDJSON row-stream and recompute its
 * profile. Operations map positionally so row order and analysis links stay
 * stable; dropped columns are removed from the file.
 */
export async function applyColumnOps(
  id: string,
  currentColumns: ColumnDef[],
  ops: ColumnOp[],
): Promise<{ columns: ColumnDef[]; profile: DatasetProfile; preview: Cell[][] }> {
  const columns = currentColumns.map((c) => ({ ...c }));
  for (const op of ops) {
    const idx = columns.findIndex((c) => c.name === op.name);
    if (idx < 0) throw new ParseError(`Column “${op.name}” was not found in the dataset.`);
    if (op.kind === "rename") {
      columns[idx] = { ...(columns[idx] as ColumnDef), name: (op.newName ?? op.name).trim() || op.name };
    } else if (op.kind === "cast") {
      if (op.type && op.type !== columns[idx]?.type) {
        columns[idx] = { ...(columns[idx] as ColumnDef), type: op.type };
      }
    } else if (op.kind === "drop") {
      columns.splice(idx, 1);
    }
  }
  const dropNames = new Set(ops.filter((o) => o.kind === "drop").map((o) => o.name));
  const renameTo = new Map(ops.filter((o) => o.kind === "rename").map((o) => [o.name, o.newName ?? o.name]));

  // Column ops re-read the stored rows — resolve through storage so a replica
  // without a warm cache fetches the NDJSON from object storage first.
  const file = await resolveReadable(keys.parsed(id));
  const aggs = columns.map(() => newAgg());
  const sigs = new Set<string>();
  let duplicateRows = 0;
  let signatureOverflow = false;
  const preview: Cell[][] = [];
  const tmp = `${file}.ops`;
  const out = createWriteStream(tmp);

  const ingest = (row: Cell[]): void => {
    const typedRow: Cell[] = row.map((cell, i) => {
      if (dropNames.has(currentColumns[i]?.name ?? "")) return null as never;
      const target = columns.find(
        (c) => (renameTo.get(currentColumns[i]?.name ?? "") ?? currentColumns[i]?.name) === c.name,
      );
      return recastCell(cell, target?.type ?? "string");
    });
    const outRow = typedRow.slice(0, columns.length);
    while (outRow.length < columns.length) outRow.push(null);
    out.write(`${JSON.stringify(outRow.map((c) => (c === null ? null : c)))}\n`);

    if (!signatureOverflow) {
      const sig = outRow.map((c) => (c === null ? "" : String(c))).join("\u0001");
      if (sig.length > 2048 || sigs.size >= SIGNATURE_CAP) {
        signatureOverflow = true;
      } else if (sigs.has(sig)) {
        duplicateRows++;
      } else {
        sigs.add(sig);
      }
    }

    for (let i = 0; i < columns.length; i++) {
      const agg = aggs[i] as Agg;
      const cell = outRow[i];
      agg.total++;
      if (cell === null || cell === undefined || cell === "") {
        agg.empty++;
        continue;
      }
      agg.count++;
      if (typeof cell === "number") {
        agg.numeric++;
        agg.sum += cell;
        agg.sumSq += cell * cell;
        if (cell < agg.min) agg.min = cell;
        if (cell > agg.max) agg.max = cell;
        agg.values.push(cell);
      } else if (typeof cell === "boolean") {
        agg.boolLike++;
      } else {
        const s = String(cell);
        const n = Number(s);
        if (Number.isFinite(n)) {
          agg.numeric++;
          agg.sum += n;
          agg.sumSq += n * n;
          if (n < agg.min) agg.min = n;
          if (n > agg.max) agg.max = n;
          agg.values.push(n);
        }
        if (!agg.distinctTooMany) {
          if (agg.distinct.size >= DISTINCT_CAP) agg.distinctTooMany = true;
          else agg.distinct.add(s);
        }
        if (agg.top.size < DISTINCT_CAP) agg.top.set(s, (agg.top.get(s) ?? 0) + 1);
      }
    }
    if (preview.length < 20) preview.push(outRow);
  };

  const rl = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      ingest(JSON.parse(line) as Cell[]);
    } catch {
      // skip corrupt lines defensively
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });
  await fs.rename(tmp, file);
  // Publish the rewritten row store (column ops changed the rows on disk).
  // Streamed (ROADMAP 1.5) — the NDJSON can be hundreds of MB.
  await saveFileStream(keys.parsed(id), file);

  // Outliers + stats assembly (mirrors the upload path)
  const stats: Record<string, ColumnStat> = {};
  const qualityWarnings: string[] = [];
  const analyzedRows = aggs[0]?.total ?? 0;
  for (let i = 0; i < columns.length; i++) {
    const agg = aggs[i] as Agg;
    const col = columns[i] as ColumnDef;
    if (col.type === "number" && agg.values.length >= 4) {
      const sorted = [...agg.values].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
      const q1 = q(0.25);
      const q3 = q(0.75);
      const iqr = q3 - q1;
      if (iqr > 0) {
        let outC = 0;
        for (const v of agg.values) if (v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr) outC++;
        agg.outliers = outC;
      }
    }
    const stat: ColumnStat = {
      name: col.name,
      type: col.type,
      missing: agg.empty,
      distinct: agg.distinctTooMany ? -1 : agg.distinct.size,
      nearConstant: agg.count >= 20 && agg.distinct.size <= 1,
    };
    if (col.type === "number") {
      const n = agg.count || 1;
      stat.min = agg.min === Number.POSITIVE_INFINITY ? undefined : agg.min;
      stat.max = agg.max === Number.NEGATIVE_INFINITY ? undefined : agg.max;
      stat.sum = agg.sum;
      stat.mean = agg.sum / n;
      stat.stddev =
        agg.count > 1 ? Math.sqrt(Math.max(0, agg.sumSq / agg.count - (agg.sum / agg.count) ** 2)) : undefined;
      stat.outlierCount = agg.outliers;
      const sorted = [...agg.values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      stat.median = sorted.length
        ? sorted.length % 2
          ? sorted[mid]
          : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
        : undefined;
      const missingRate = analyzedRows ? (agg.empty / analyzedRows) * 100 : 0;
      if (missingRate > 30) qualityWarnings.push(`“${col.name}” is missing in ${missingRate.toFixed(0)}% of rows.`);
      if (stat.nearConstant) qualityWarnings.push(`“${col.name}” is nearly constant and adds little signal.`);
    }
    stats[col.name] = stat;
  }
  if (duplicateRows > 0 && !signatureOverflow) {
    const rate = analyzedRows ? (duplicateRows / analyzedRows) * 100 : 0;
    if (rate >= 1)
      qualityWarnings.push(`${duplicateRows.toLocaleString()} exact duplicate rows found (${rate.toFixed(1)}%).`);
  }

  const profile: DatasetProfile = {
    analyzedRows,
    sampled: false,
    rowCount: analyzedRows,
    columnCount: columns.length,
    columns,
    stats,
    duplicateRows,
    qualityWarnings,
  };
  return { columns, profile, preview };
}
