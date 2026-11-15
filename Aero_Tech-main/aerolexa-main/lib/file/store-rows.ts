/**
 * Materialize computed rows (SQL query results, notebook outputs, model
 * exports) as a real, profiled Dataset: writes NDJSON then reuses the
 * streaming profiler from lib/file/parse.ts so downstream screens behave
 * exactly as they do for uploaded files.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { dataDir, inferType, recastCell, type Cell } from "@/lib/engine/dataset";
import { applyColumnOps, ParseError } from "@/lib/file/parse";
import { keys, saveFile } from "@/lib/server/storage";
import type { ColType, ColumnDef, DatasetProfile } from "@/lib/types";

export interface StorableColumn {
  name: string;
  type: ColType;
}

export interface StoreRowsResult {
  rowCount: number;
  columns: ColumnDef[];
  profile: DatasetProfile;
  preview: Cell[][];
  qualityWarnings: string[];
}

/**
 * Write rows to `<dataDir>/parsed/<id>.ndjson` with typed columns, then run
 * the standard profiler over the file (column stats, missing values,
 * duplicates, outliers). Column names are deduplicated.
 */
export async function storeRowsAsDataset(
  id: string,
  columns: StorableColumn[],
  rows: (string | number | boolean | null)[][],
): Promise<StoreRowsResult> {
  if (columns.length === 0 || rows.length === 0) {
    throw new ParseError("Nothing to materialize — the result has no columns or rows.");
  }
  if (columns.length > 300) throw new ParseError("Too many columns to materialize (max 300).");
  const names = dedupeNames(columns.map((c) => c.name));
  const typedColumns: ColumnDef[] = names.map((name, i) => ({
    name,
    type: columns[i]?.type ?? inferType(rows.map((r) => (r[i] === null ? ("" as Cell) : (r[i] as Cell)))),
  }));

  const dir = path.join(dataDir(), "parsed");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${id}.ndjson`);
  const tmp = `${target}.materialize`;
  const lines = rows.map((row) => {
    const typed = row.map((v, i) => recastCell(v as Cell, typedColumns[i]?.type ?? "string"));
    return `${JSON.stringify(typed.map((c) => (c === null ? null : c)))}\n`;
  });
  await fs.writeFile(tmp, lines.join(""));
  await fs.rename(tmp, target);
  // Publish so any replica can stream this materialized dataset.
  await saveFile(keys.parsed(id), lines.join(""));

  // Profile the materialized NDJSON with the same pipeline as uploads.
  const reprofiled = await applyColumnOps(id, typedColumns, []);
  return {
    rowCount: rows.length,
    columns: reprofiled.columns,
    profile: reprofiled.profile,
    preview: reprofiled.preview,
    qualityWarnings: reprofiled.profile.qualityWarnings,
  };
}

function dedupeNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const base = n || "column";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}
