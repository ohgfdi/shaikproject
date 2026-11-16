/**
 * Connector import + sync orchestration (server-only).
 *
 * Import: pull real rows from the source table, materialize them through the
 * same profiler pipeline as CSV uploads (lib/file/store-rows.ts), and record
 * the import as sync run #1. Sync: re-pull on demand or on the scheduler's
 * tick, snapshot the pulled rows to disk (data/connector-syncs), diff against
 * the previous dataset content, and update the dataset — every run recorded,
 * never a silent overwrite.
 */

// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - connector sync is a deployment-wide aggregate operation
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { notFoundError, assertWorkspaceAccess, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { computeChangeLog, type ConnectorChangeLog } from "@/lib/engine/connectors/changelog";
import { validateConnectorConfig, type ConnectorConfig } from "@/lib/engine/connectors/config";
import { decryptJson } from "@/lib/engine/connectors/crypto";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { pullConnectorTable, runConnectorAggregation } from "@/lib/engine/connectors/pull";
import type { AggregationSpec } from "@/lib/engine/connectors/pushdown";
import { advanceWatermark, watermarkFilterFromStored } from "@/lib/engine/connectors/watermark";
import { nextRunAt } from "@/lib/engine/cron";
import { loadParsedDataset, dataDir, recastCell, inferType, type Cell } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { type StorableColumn } from "@/lib/file/store-rows";
import { storeRowsAsDataset } from "@/lib/file/store-rows";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { enqueueJob } from "@/lib/server/job-queue";
import { generateIdempotencyKey } from "@/lib/server/queue";
import { saveFile } from "@/lib/server/storage";
import { createDatasetVersion } from "@/lib/server/versioning";
import { type ColType } from "@/lib/types";

export interface SyncOutcome {
  runId: string;
  datasetId: string;
  rowCount: number;
  changeLog: ConnectorChangeLog | null;
  status: "SUCCESS" | "ERROR";
  error?: string;
}

const snapshotDir = () => path.join(dataDir(), "connector-syncs");

async function writeSnapshot(runId: string, rows: (string | number | boolean | null)[][]): Promise<void> {
  await fs.mkdir(snapshotDir(), { recursive: true });
  const lines = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  await fs.writeFile(path.join(snapshotDir(), `${runId}.ndjson`), lines, "utf8");
  // Sync audit snapshots go to object storage too — they are the evidence trail
  // for connector runs and must be readable from any replica.
  await saveFile(`connector-syncs/${runId}.ndjson`, lines);
}

function loadConnectorConfig(connector: { id: string; kind: string; config: string }): ConnectorConfig {
  const decrypted = decryptJson<unknown>(connector.config);
  return validateConnectorConfig(connector.kind, decrypted);
}

async function loadDatasetRows(datasetId: string): Promise<(string | number | boolean | null)[][]> {
  const loaded = await loadParsedDataset(datasetId, serverEnv().DATASET_ANALYSIS_LIMIT);
  return loaded.rows;
}

/**
 * Pull a connector table and materialize it as a brand-new Dataset (the same
 * path CSV uploads take). Returns the new dataset id + stored row count.
 */
export async function importConnectorTable(opts: {
  ctx: AuthContext;
  connectorId: string;
  schema: string;
  table: string;
  datasetName: string;
  rowCap?: number;
}): Promise<{ datasetId: string; rowCount: number; columnCount: number }> {
  const connector = await prisma.connector.findUnique({ where: { id: opts.connectorId } });
  if (!connector) throw notFoundError("Connector not found.");
  assertWorkspaceAccess(opts.ctx, connector, "Connector");

  const schema = opts.schema.trim();
  const table = opts.table.trim();
  if (!schema || !table) {
    throw new ConnectorError(
      "Choose a schema and table to import. How to fix: pick one from the schema browser and retry.",
    );
  }
  const datasetName = opts.datasetName.trim();
  if (!datasetName || datasetName.length > 140) {
    throw new ConnectorError("Give the imported dataset a name (max 140 characters).");
  }

  const id = randomUUID();
  const config = loadConnectorConfig(connector);
  const rowCap = Math.max(1, opts.rowCap ?? serverEnv().DATASET_ANALYSIS_LIMIT);
  const pulled = await pullConnectorTable(config, schema, table, rowCap);
  if (pulled.columns.length === 0 || pulled.rows.length === 0) {
    throw new ConnectorError(
      "The source table has no rows to import. What happened: the pull returned an empty result. How to fix: check the table contains data, or choose another table.",
    );
  }

  const cellRows = pulled.rows.map((row) => row.map((cell) => cell as Cell));
  const storableCols = pulled.columns.map((c, i) => ({
    name: c.name,
    type: inferType(cellRows.map((row) => row[i] as Cell) as Cell[]),
  }));
  const stored = await storeRowsAsDataset(id, storableCols as unknown as StorableColumn[], pulled.rows);
  const sourceTable = `${schema}.${table}`;
  const dataset = await prisma.dataset.create({
    data: {
      id,
      workspaceId: opts.ctx.workspace.id,
      projectId: null,
      name: datasetName,
      originalName: `${sourceTable} · ${connector.name}`,
      mimeType: "application/x-Ledgerly-connector",
      sizeBytes: pulled.rows.length * 96,
      rowCount: stored.rowCount,
      columnCount: stored.columns.length,
      isDemo: false,
      status: "READY",
      ndjsonPath: `${id}.ndjson`,
      profile: stringifyJson(stored.profile),
      columns: stringifyJson(stored.columns),
      preview: stringifyJson(stored.preview),
      qualityWarnings: stringifyJson(stored.qualityWarnings),
      connectorId: connector.id,
      connectorSourceTable: sourceTable,
      createdById: opts.ctx.user.id,
    },
  });

  // Import = sync run #1: recorded with a snapshot + change log so the import
  // itself is never an invisible write.
  const run = await prisma.connectorSyncRun.create({
    data: {
      workspaceId: opts.ctx.workspace.id,
      connectorId: connector.id,
      datasetId: dataset.id,
      tableName: sourceTable,
      status: "SUCCESS",
      rowCount: stored.rowCount,
      changeLog: stringifyJson({
        previousRowCount: 0,
        newRowCount: stored.rowCount,
        rowsAdded: stored.rowCount,
        rowsRemoved: 0,
        comparedRows: stored.rowCount,
        truncated: stored.rowCount >= serverEnv().DATASET_ANALYSIS_LIMIT,
        note:
          stored.rowCount >= serverEnv().DATASET_ANALYSIS_LIMIT
            ? `Initial import of the first ${stored.rowCount.toLocaleString()} of ${serverEnv().DATASET_ANALYSIS_LIMIT}+ source rows (import limit reached).`
            : `Initial import of ${stored.rowCount.toLocaleString()} row(s) from ${sourceTable}.`,
      } satisfies ConnectorChangeLog),
      triggeredBy: "manual",
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  await writeSnapshot(run.id, pulled.rows);
  await prisma.connectorSyncRun.update({
    where: { id: run.id },
    data: { snapshotPath: `${run.id}.ndjson` },
  });

  await prisma.connector.update({
    where: { id: connector.id },
    data: { status: "ok", lastError: null, lastSyncAt: new Date() },
  });
  await logActivity(
    opts.ctx,
    "CONNECTOR_IMPORTED",
    `Imported “${sourceTable}” from connector “${connector.name}” as dataset “${dataset.name}” (${stored.rowCount.toLocaleString()} rows)`,
    null,
    { connectorId: connector.id, datasetId: dataset.id },
  );

  return { datasetId: dataset.id, rowCount: stored.rowCount, columnCount: stored.columns.length };
}

/** Re-pull a connector-backed dataset, snapshot + diff + record the run. */
export async function runConnectorSync(
  connectorId: string,
  datasetId: string,
  triggeredBy: "manual" | "schedule",
): Promise<SyncOutcome> {
  const connector = await prisma.connector.findUnique({ where: { id: connectorId } });
  if (!connector)
    return { runId: "", datasetId, rowCount: 0, changeLog: null, status: "ERROR", error: "Connector not found." };
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!dataset || dataset.connectorId !== connectorId) {
    return {
      runId: "",
      datasetId,
      rowCount: 0,
      changeLog: null,
      status: "ERROR",
      error: "The dataset does not belong to this connector.",
    };
  }
  const sourceTable = dataset.connectorSourceTable;
  if (!sourceTable) {
    return {
      runId: "",
      datasetId,
      rowCount: 0,
      changeLog: null,
      status: "ERROR",
      error: "The dataset has no connector source table.",
    };
  }
  const [schema, ...rest] = sourceTable.split(".");
  const table = rest.join(".");
  if (!schema || !table) {
    return {
      runId: "",
      datasetId,
      rowCount: 0,
      changeLog: null,
      status: "ERROR",
      error: "The stored source table reference is invalid.",
    };
  }

  const run = await prisma.connectorSyncRun.create({
    data: {
      workspaceId: connector.workspaceId,
      connectorId,
      datasetId,
      tableName: sourceTable,
      status: "RUNNING",
      triggeredBy,
    },
  });

  // Incremental-sync watermark (Gap ④). When the dataset carries a watermark
  // { column, value, colType } and the connector engine has a safe parameterized
  // pull (postgres, mysql), re-pull only rows past the floor. Any failure in
  // the incremental path falls back to a FULL pull — an incremental sync never
  // silently produces a partial dataset.
  type Watermark = { column: string; value: string; colType: ColType };
  let watermark: Watermark | null = null;
  try {
    const raw = dataset.connectorWatermark;
    if (raw) {
      const parsed = JSON.parse(raw) as Watermark;
      if (parsed && typeof parsed.column === "string" && typeof parsed.value === "string") {
        watermark = parsed;
      }
    }
  } catch {
    watermark = null; // corrupt JSON → full pull
  }
  // Mongo stores the watermark as a JS Date via the native filter builder, so
  // ISO strings are coerced there; every other engine either binds or renders
  // via the safe builders. Corrupt JSON above already fell back to full pull.
  const watermarkEngines = new Set(["postgres", "mysql", "snowflake", "bigquery", "mongodb"]);
  const canIncrement = watermark !== null && watermarkEngines.has(connector.kind) && watermark.value !== "";

  try {
    const config = loadConnectorConfig(connector);
    const rowCap = serverEnv().DATASET_ANALYSIS_LIMIT;
    const incremental =
      canIncrement && watermark
        ? {
            column: watermark.column,
            since: watermarkFilterFromStored(watermark.column, watermark.value, watermark.colType).value,
          }
        : undefined;
    const pulled = await pullConnectorTable(config, schema, table, rowCap, incremental);
    // Snapshot the pulled rows BEFORE merging/replace: this file is the run's
    // evidence trail (what THIS pull fetched) and is what the change-log diff
    // and previous-version retrieval read back.
    await writeSnapshot(run.id, pulled.rows);

    // --- Incremental merge path (append new rows, keep stored history) -----
    if (incremental) {
      const previousRows = await loadDatasetRows(dataset.id);
      const previousDataset = await prisma.dataset.findUnique({ where: { id: dataset.id }, select: { columns: true } });
      const previousColumns = JSON.parse(previousDataset?.columns ?? "[]") as { name: string; type: string }[];
      const recastPull = pulled.rows.map((row) =>
        row.map((cell, index) => recastCell(cell, (pulled.columns[index]?.type ?? "string") as ColType)),
      );
      const columnSignature = (cols: { name: string; type: string }[]) =>
        cols.map((c) => `${c.name}:${c.type}`).join("|");
      if (columnSignature(previousColumns) === columnSignature(pulled.columns)) {
        const mergedRows = [...previousRows, ...recastPull];
        const watermarkIndex = pulled.columns.findIndex((c) => c.name === watermark!.column);
        const nextWatermark =
          watermarkIndex >= 0 ? advanceWatermark(recastPull, watermarkIndex, watermark!.value) : watermark!.value;
        // (advanceWatermark is monotonic: the floor never moves backwards.)
        const mergedRowsCapped = mergedRows.slice(0, rowCap);
        const truncatedByCap = mergedRows.length > mergedRowsCapped.length;

        const storableCols = previousColumns.map((c) => ({ name: c.name, type: c.type as ColType }));
        const stored = await storeRowsAsDataset(dataset.id, storableCols as StorableColumn[], mergedRowsCapped);
        await prisma.dataset.update({
          where: { id: dataset.id },
          data: {
            rowCount: stored.rowCount,
            columnCount: stored.columns.length,
            profile: stringifyJson(stored.profile),
            columns: stringifyJson(stored.columns),
            preview: stringifyJson(stored.preview),
            qualityWarnings: stringifyJson(stored.qualityWarnings),
            connectorWatermark: stringifyJson({
              column: watermark!.column,
              value: nextWatermark,
              colType: watermark!.colType,
            }),
            updatedAt: new Date(),
          },
        });
        await createDatasetVersion({
          datasetId: dataset.id,
          workspaceId: connector.workspaceId,
          source: "sync",
          label: `incremental sync from ${sourceTable} (+${recastPull.length} rows)`,
          createdById: connector.createdById,
          note: `Appended ${recastPull.length} new row(s) past watermark ${watermark!.column} > ${watermark!.value}; total ${stored.rowCount.toLocaleString()}.${truncatedByCap ? " Older rows beyond the import cap were dropped." : ""}`,
        });
        await prisma.connectorSyncRun.update({
          where: { id: run.id },
          data: {
            status: "SUCCESS",
            rowCount: stored.rowCount,
            changeLog: stringifyJson({
              rowsAdded: recastPull.length,
              rowsRemoved: 0,
              rowsChanged: 0,
              comparedRows: stored.rowCount,
              truncated: truncatedByCap,
              note: `Incremental (watermark ${watermark!.column} > ${watermark!.value}): appended ${recastPull.length} new row(s).`,
            }),
            snapshotPath: `${run.id}.ndjson`,
            finishedAt: new Date(),
          },
        });
        await prisma.connector.update({
          where: { id: connector.id },
          data: { status: "ok", lastError: null, lastSyncAt: new Date() },
        });
        return { runId: run.id, datasetId, rowCount: stored.rowCount, changeLog: null, status: "SUCCESS" };
      }
      // Schema drift → deliberate fall-through to the full-pull replace path.
    }

    const previousRows = await loadDatasetRows(dataset.id);
    // Diff like-for-like: the previously stored rows were recast to the
    // dataset's column types on import, so recast the fresh pull identically
    // before comparing — otherwise numeric ("1250.50") vs number (1250.5)
    // would report every row as changed on every sync.
    const recastPull = pulled.rows.map((row) =>
      row.map((cell, index) => recastCell(cell, (pulled.columns[index]?.type ?? "string") as ColType)),
    );
    const changeLog = computeChangeLog(previousRows, recastPull);
    // Truncated means the source has more rows than the import limit allows
    if (changeLog.comparedRows >= serverEnv().DATASET_ANALYSIS_LIMIT) {
      changeLog.truncated = true;
      changeLog.note = `${changeLog.note} The source has many rows; only the first ${pulled.rows.length.toLocaleString()} were pulled (import limit reached).`;
    }

    const cellRows = pulled.rows.map((row) => row.map((cell) => cell as Cell));
    const storableCols = pulled.columns.map((c, i) => ({
      name: c.name,
      type: inferType(cellRows.map((row) => row[i]) as unknown as Cell[] as Cell[]),
    }));
    const stored = await storeRowsAsDataset(dataset.id, storableCols as StorableColumn[], pulled.rows);
    // Keep the watermark fresh even on a full replace, so the NEXT incremental
    // sync starts from the newest value just pulled rather than a stale floor.
    let nextWatermarkJson: string | null = null;
    if (watermark) {
      const wmIndex = pulled.columns.findIndex((c) => c.name === watermark!.column);
      const wmValue = wmIndex >= 0 ? advanceWatermark(pulled.rows, wmIndex, watermark.value) : watermark.value;
      nextWatermarkJson = stringifyJson({ column: watermark.column, value: wmValue, colType: watermark.colType });
    }
    await prisma.dataset.update({
      where: { id: dataset.id },
      data: {
        rowCount: stored.rowCount,
        columnCount: stored.columns.length,
        profile: stringifyJson(stored.profile),
        columns: stringifyJson(stored.columns),
        preview: stringifyJson(stored.preview),
        qualityWarnings: stringifyJson(stored.qualityWarnings),
        ...(nextWatermarkJson ? { connectorWatermark: nextWatermarkJson } : {}),
        updatedAt: new Date(),
      },
    });
    // Phase 1.5: record the synced state as a DatasetVersion so the previous
    // content stays retrievable (never a silent overwrite) and analyses can
    // pin to the pre-sync state.
    await createDatasetVersion({
      datasetId: dataset.id,
      workspaceId: connector.workspaceId,
      source: "sync",
      label: `sync from ${sourceTable}`,
      createdById: connector.createdById,
      note: changeLog.note,
    });
    await prisma.connectorSyncRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        rowCount: stored.rowCount,
        changeLog: stringifyJson(changeLog),
        snapshotPath: `${run.id}.ndjson`,
        finishedAt: new Date(),
      },
    });
    await prisma.connector.update({
      where: { id: connector.id },
      data: { status: "ok", lastError: null, lastSyncAt: new Date() },
    });

    // Data alerts: the dataset just changed — re-evaluate its rules. A
    // failing alert must never fail the sync that triggered it.
    try {
      const { runAlertEvaluationsForDataset } = await import("./alerts");
      await runAlertEvaluationsForDataset(datasetId);
    } catch {
      // isolated: alert evaluation problems never surface as sync errors
    }

    return { runId: run.id, datasetId, rowCount: stored.rowCount, changeLog, status: "SUCCESS" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "The sync failed for an unknown reason.";
    await prisma.connectorSyncRun.update({
      where: { id: run.id },
      data: { status: "ERROR", error: message, finishedAt: new Date() },
    });
    await prisma.connector.update({
      where: { id: connector.id },
      data: { status: "error", lastError: message },
    });
    return { runId: run.id, datasetId, rowCount: 0, changeLog: null, status: "ERROR", error: message };
  }
}

/**
 * Scheduler hook: run every enabled connector whose cron schedule is due
 * (same poller + cron parser as scheduled reports). Returns how many datasets
 * were synced. A single failing connector never stops the others.
 */
export async function runDueConnectorSyncs(now: Date = new Date()): Promise<number> {
  const connectors = await prisma.connector.findMany({
    where: { syncEnabled: true },
    include: { datasets: { select: { id: true, connectorId: true } } },
  });
  let synced = 0;
  const durable = process.env.JOB_WORKER_ENABLED === "true";
  for (const connector of connectors) {
    try {
      if (!connector.syncCron) continue;
      const next = nextRunAt(connector.syncCron, connector.lastSyncAt ?? new Date());
      if (!next || next.getTime() > now.getTime()) continue;
      for (const dataset of connector.datasets) {
        if (!dataset.connectorId) continue;
        if (durable) {
          // Durable path (ROADMAP 5.4): enqueue a connector-sync job — the
          // worker executes it with retries/backoff and crash recovery. The
          // idempotency key is stable per (connector, dataset, lastSyncAt) so
          // a poller retry can never double-sync the same watermark.
          await enqueueJob({
            workspaceId: connector.workspaceId,
            kind: "connector-sync",
            payload: { connectorId: connector.id, datasetId: dataset.id },
            idempotencyKey: generateIdempotencyKey(
              `${connector.id}:${dataset.id}:${connector.lastSyncAt?.toISOString() ?? "never"}`,
              1,
            ),
          });
        } else {
          await runConnectorSync(connector.id, dataset.id, "schedule");
        }
        synced += 1;
      }
    } catch {
      // Keep polling other connectors on transient DB/connection errors.
    }
  }
  return synced;
}

/**
 * Aggregation pushdown import: run a GROUP BY ON the source warehouse and
 * materialize the aggregated result as a Dataset. This is the scale-gap
 * closer for warehouse tables larger than DATASET_ANALYSIS_LIMIT — the
 * source engine does the heavy lifting and only aggregated rows cross the
 * network. The run is recorded like any import (sync run #1 with snapshot).
 */
export async function importConnectorAggregation(opts: {
  ctx: AuthContext;
  connectorId: string;
  spec: AggregationSpec;
  datasetName: string;
}): Promise<{ datasetId: string; rowCount: number; columnCount: number; sql: string }> {
  const connector = await prisma.connector.findUnique({ where: { id: opts.connectorId } });
  if (!connector) throw notFoundError("Connector not found.");
  assertWorkspaceAccess(opts.ctx, connector, "Connector");
  const datasetName = opts.datasetName.trim();
  if (!datasetName || datasetName.length > 140) {
    throw new ConnectorError("Give the imported dataset a name (max 140 characters).");
  }

  const config = loadConnectorConfig(connector);
  const pulled = await runConnectorAggregation(config, opts.spec);
  if (pulled.columns.length === 0 || pulled.rows.length === 0) {
    throw new ConnectorError(
      "The aggregation returned no rows. What happened: the GROUP BY matched nothing. How to fix: relax the filters, or check the dimension column values.",
    );
  }

  const id = randomUUID();
  const storableCols = pulled.columns.map((c) => ({ name: c.name, type: c.type as ColType }));
  const stored = await storeRowsAsDataset(id, storableCols as unknown as StorableColumn[], pulled.rows);
  const sourceTable = `${opts.spec.schema ? `${opts.spec.schema}.` : ""}${opts.spec.table}`;
  const dataset = await prisma.dataset.create({
    data: {
      id,
      workspaceId: opts.ctx.workspace.id,
      projectId: null,
      name: datasetName,
      originalName: `aggregate(${sourceTable}) · ${connector.name}`,
      mimeType: "application/x-Ledgerly-connector",
      sizeBytes: pulled.rows.length * 64,
      rowCount: stored.rowCount,
      columnCount: stored.columns.length,
      isDemo: false,
      status: "READY",
      ndjsonPath: `${id}.ndjson`,
      profile: stringifyJson(stored.profile),
      columns: stringifyJson(stored.columns),
      preview: stringifyJson(stored.preview),
      qualityWarnings: stringifyJson(stored.qualityWarnings),
      connectorId: connector.id,
      connectorSourceTable: sourceTable,
      createdById: opts.ctx.user.id,
    },
  });

  const run = await prisma.connectorSyncRun.create({
    data: {
      workspaceId: opts.ctx.workspace.id,
      connectorId: connector.id,
      datasetId: dataset.id,
      tableName: sourceTable,
      status: "SUCCESS",
      rowCount: stored.rowCount,
      changeLog: stringifyJson({
        previousRowCount: 0,
        newRowCount: stored.rowCount,
        rowsAdded: stored.rowCount,
        rowsRemoved: 0,
        comparedRows: stored.rowCount,
        truncated: false,
        note: `Warehouse aggregation import: GROUP BY ran on ${connector.kind}; ${stored.rowCount.toLocaleString()} aggregated row(s) materialized.`,
      } satisfies ConnectorChangeLog),
      triggeredBy: "manual",
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  await writeSnapshot(run.id, pulled.rows);
  await prisma.connectorSyncRun.update({
    where: { id: run.id },
    data: { snapshotPath: `${run.id}.ndjson` },
  });
  await prisma.connector.update({
    where: { id: connector.id },
    data: { status: "ok", lastError: null, lastSyncAt: new Date() },
  });
  await logActivity(
    opts.ctx,
    "CONNECTOR_IMPORTED",
    `Aggregated “${sourceTable}” on ${connector.kind} and imported the result as dataset “${dataset.name}” (${stored.rowCount.toLocaleString()} rows)`,
    null,
    { connectorId: connector.id, datasetId: dataset.id, pushdown: true },
  );

  return { datasetId: dataset.id, rowCount: stored.rowCount, columnCount: stored.columns.length, sql: sourceTable };
}
