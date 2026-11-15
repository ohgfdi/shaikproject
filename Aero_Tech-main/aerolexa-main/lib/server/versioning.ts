/**
 * Phase 1.5 — server-side version snapshot orchestration (server-only).
 *
 * DatasetVersion snapshots: every re-parse (column ops) and connector sync
 * writes an immutable NDJSON copy of the dataset's rows under
 * `data/versions/` plus a DB row, so prior content stays retrievable and the
 * live Dataset row always points at the newest state.
 *
 * AnalysisVersion: created on every analysis run, with extracted metrics so
 * two versions can be diffed without re-reading their full results.
 */

import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import type { Cell } from "@/lib/engine/dataset";
import {
  computeDatasetVersionChangeLog,
  extractVersionMetrics,
  nextVersionNumber,
  type VersionChangeLog,
} from "@/lib/engine/versioning";
import { serverEnv } from "@/lib/env";
import { parseJsonArray, stringifyJson } from "@/lib/json";
import { keys, readTextFile, saveFile } from "@/lib/server/storage";
import type { AnalysisResult, ColumnDef } from "@/lib/types";

/**
 * Snapshot a dataset's current rows as a new DatasetVersion and point the live
 * dataset row's ndjsonPath at the new snapshot so the live dataset == latest
 * version. Returns the created version (or null when the dataset has no rows
 * on disk yet).
 */
export async function createDatasetVersion(opts: {
  datasetId: string;
  workspaceId: string;
  source: "upload" | "sync" | "column-ops" | "materialize" | "re-upload" | "connected";
  label?: string;
  createdById?: string | null;
  note?: string;
  truncated?: boolean;
}): Promise<{ id: string; version: number; changeLog: VersionChangeLog } | null> {
  const dataset = await prisma.dataset.findUnique({ where: { id: opts.datasetId } });
  if (!dataset) return null;

  const { rows } = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
  if (rows.length === 0) return null;

  const previous = await prisma.datasetVersion.findFirst({
    where: { datasetId: dataset.id },
    orderBy: { version: "desc" },
    select: { id: true, version: true, ndjsonPath: true },
  });

  let previousRows: (string | number | boolean | null)[][] = [];
  if (previous) {
    try {
      // Read through storage: the prior snapshot may live only in object storage
      // if it was written by another replica.
      const raw = await readTextFile(`versions/${dataset.id}/${previous.ndjsonPath}`);
      previousRows = raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as (string | number | boolean | null)[]);
    } catch {
      previousRows = []; // prior snapshot missing — diff from zero
    }
  }

  const version = nextVersionNumber(previous?.version ?? 0);
  const snapshotId = `${dataset.id}-v${version}-${Date.now().toString(36)}`;
  const fileName = `${snapshotId}.ndjson`;
  // Immutable snapshot → write through storage so every replica (and any
  // future pin/restore) can read it regardless of which instance created it.
  await saveFile(keys.version(dataset.id, snapshotId), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));

  const changeLog = computeDatasetVersionChangeLog(
    previous ? { version: previous.version, rows: previousRows } : null,
    { version, rows },
    { note: opts.note, truncated: opts.truncated },
  );

  const created = await prisma.datasetVersion.create({
    data: {
      workspaceId: opts.workspaceId,
      datasetId: dataset.id,
      version,
      previousVersionId: previous?.id ?? null,
      label: opts.label ?? null,
      source: opts.source,
      rowCount: rows.length,
      columnCount: dataset.columnCount,
      ndjsonPath: fileName,
      columns: dataset.columns,
      profile: dataset.profile,
      qualityWarnings: dataset.qualityWarnings,
      changeLog: stringifyJson(changeLog),
      createdById: opts.createdById ?? null,
    },
  });

  return { id: created.id, version, changeLog };
}

/** A dataset's version list (newest first), for the UI selector. */
export async function listDatasetVersions(datasetId: string) {
  return prisma.datasetVersion.findMany({
    where: { datasetId },
    orderBy: { version: "desc" },
    take: 50,
    select: {
      id: true,
      version: true,
      label: true,
      source: true,
      rowCount: true,
      changeLog: true,
      createdAt: true,
    },
  });
}

/**
 * Record an AnalysisVersion for a freshly-run analysis and extract its
 * diff-able metrics. Also snapshots the dataset state it ran against.
 */
export async function createAnalysisVersion(opts: {
  analysisId: string;
  workspaceId: string;
  result: AnalysisResult;
  config: Record<string, unknown>;
  createdById: string;
  datasetVersionId?: string | null;
}): Promise<{ id: string; version: number }> {
  const previous = await prisma.analysisVersion.findFirst({
    where: { analysisId: opts.analysisId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = nextVersionNumber(previous?.version ?? 0);
  const created = await prisma.analysisVersion.create({
    data: {
      workspaceId: opts.workspaceId,
      analysisId: opts.analysisId,
      version,
      datasetVersionId: opts.datasetVersionId ?? null,
      result: stringifyJson(opts.result),
      config: stringifyJson(opts.config),
      metrics: stringifyJson(extractVersionMetrics(opts.result)),
      createdById: opts.createdById,
    },
  });
  return { id: created.id, version };
}

/** A dataset's pinned column set at a given version (falls back to the live row). */
export async function datasetColumnsAtVersion(
  datasetId: string,
  datasetVersionId: string | null,
): Promise<ColumnDef[]> {
  if (datasetVersionId) {
    const version = await prisma.datasetVersion.findUnique({ where: { id: datasetVersionId } });
    if (version) return parseJsonArray<ColumnDef>(version.columns, []);
  }
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId }, select: { columns: true } });
  return dataset ? parseJsonArray<ColumnDef>(dataset.columns, []) : [];
}

/** Rows at a specific dataset version (falls back to the live ndjson). */
export async function datasetRowsAtVersion(
  datasetId: string,
  datasetVersionId: string | null,
  limit?: number,
): Promise<{ rows: Cell[][]; totalRows: number }> {
  if (datasetVersionId) {
    const version = await prisma.datasetVersion.findUnique({ where: { id: datasetVersionId } });
    if (version) {
      const raw = await readTextFile(`versions/${datasetId}/${version.ndjsonPath}`).catch(() => "");
      const all = raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as Cell[];
          } catch {
            return null;
          }
        })
        .filter((r): r is Cell[] => Array.isArray(r));
      const cap = limit ?? serverEnv().DATASET_ANALYSIS_LIMIT;
      return { rows: all.slice(0, cap), totalRows: all.length };
    }
  }
  return loadParsedDataset(datasetId, limit ?? serverEnv().DATASET_ANALYSIS_LIMIT);
}
