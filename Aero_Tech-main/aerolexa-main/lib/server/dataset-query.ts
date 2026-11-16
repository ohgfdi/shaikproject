/**
 * Shared helper: load a dataset's rows and run SQL over them. Used by the SQL
 * Lab run + materialize endpoints and reusable by tests.
 *
 * When DUCKDB_ENABLED (default), queries run on the real DuckDB engine
 * (worker-thread + wasm, full SELECT grammar). If DuckDB cannot initialize the
 * request fails with an explicit ENGINE_UNAVAILABLE error — we do not silently
 * downgrade to the weaker prototype parser. Setting SQL_PROTOTYPE_FALLBACK=true
 * opts into that parser as a clearly-labelled degraded mode.
 */
// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - dataset query utility is a deployment-wide aggregate operation
import { ApiError, notFoundError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { DuckDbUnavailableError, runDuckDbSqlMany } from "@/lib/engine/duckdb/server";
import { executeSql, SqlError, sqlFromTable } from "@/lib/engine/sql";
import { serverEnv } from "@/lib/env";
import { datasetColumns } from "@/lib/serialize";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import type { SqlResultSet, SqlValue } from "@/lib/types";

export interface DatasetQueryOutcome {
  datasetId: string;
  datasetName: string;
  datasetRowCount: number;
  projectId: string | null;
  rowsLoaded: number;
  result: SqlResultSet;
  /** note about dataset coverage added to the engine note */
  coverageNote: string;
  sourceDatasetIds: string[];
}

export async function runQueryOnDataset(
  ctx: AuthContext,
  datasetId: string,
  sql: string,
  opts: { rowCap?: number; minRole?: "VIEWER" | "EDITOR" } = {},
): Promise<DatasetQueryOutcome> {
  return runQueryOnDatasets(ctx, [datasetId], sql, opts);
}

export async function runQueryOnDatasets(
  ctx: AuthContext,
  datasetIds: string[],
  sql: string,
  opts: { rowCap?: number; minRole?: "VIEWER" | "EDITOR" } = {},
): Promise<DatasetQueryOutcome> {
  const uniqueIds = [...new Set(datasetIds.filter(Boolean))];
  if (uniqueIds.length === 0) throw notFoundError("Choose at least one dataset.");
  const datasets = await prisma.dataset.findMany({ where: { id: { in: uniqueIds } } });
  if (datasets.length !== uniqueIds.length) throw notFoundError("One or more datasets were not found.");
  const dataset = datasets[0]!;
  if (!dataset) throw notFoundError("Dataset not found.");
  for (const source of datasets) {
    await requireRowRole(
      ctx,
      { workspaceId: source.workspaceId, projectId: source.projectId },
      opts.minRole ?? "VIEWER",
    );
    if (source.workspaceId !== dataset.workspaceId || source.projectId !== dataset.projectId) {
      throw notFoundError("All joined datasets must belong to the same project.");
    }
  }

  const sources = await Promise.all(
    datasets.map(async (source) => {
      const loaded = await loadParsedDataset(source.id, serverEnv().DATASET_ANALYSIS_LIMIT);
      const cols = datasetColumns(source);
      // RLS (via the shared chokepoint): the rules that apply are the ones
      // declared by the workspace that OWNS this dataset, resolved before any
      // query runs — the engine never sees a filtered-out row.
      const rls = await applyRowSecurity(ctx, source, { rows: loaded.rows, columns: cols });
      return {
        name: tableAlias(source.name),
        columns: cols,
        loaded: { ...loaded, rows: rls.rows as SqlValue[][] },
        rlsNote: rls.note,
      };
    }),
  );
  const rowCap = opts.rowCap ?? serverEnv().DATASET_QUERY_LIMIT;

  const coverageNote =
    sources.map((source) => source.rlsNote).join("") +
    sources
      .filter((source) => source.loaded.totalRows > source.loaded.rows.length)
      .map(
        (source) =>
          ` ${source.name}: first ${source.loaded.rows.length.toLocaleString()} of ${source.loaded.totalRows.toLocaleString()} rows scanned.`,
      )
      .join("");

  // DuckDB first (when enabled); prototype parser as the fallback whenever the
  // engine itself is unavailable. Real SQL errors (binder/catalog) are NOT
  // swallowed — they surface as a friendly SQL_INPUT 400 from the route.
  //
  // Backward compatibility: the SQL Lab historically registered a single
  // dataset's temp table under whatever table name the query itself referenced
  // (e.g. `FROM sales`). Register the single dataset under the SQL-derived name
  // as well as its own alias, so both existing queries and the dataset-named
  // UI prefill keep working. Multi-dataset queries keep the dataset names only.
  const duckSources = [...sources];
  if (duckSources.length === 1) {
    const referenced = sqlFromTable(sql);
    if (referenced && referenced !== duckSources[0]!.name) {
      duckSources.push({ ...duckSources[0]!, name: referenced });
    }
  }
  let result: SqlResultSet | null = null;
  let duckdbUnavailable: DuckDbUnavailableError | null = null;
  if (serverEnv().DUCKDB_ENABLED) {
    try {
      result = await runDuckDbSqlMany(
        duckSources.map((source) => ({
          name: source.name,
          columns: source.columns,
          rows: source.loaded.rows as SqlValue[][],
        })),
        { sql, rowCap, coverageNote },
      );
    } catch (err) {
      if (!(err instanceof DuckDbUnavailableError)) throw err;
      duckdbUnavailable = err;
      // eslint-disable-next-line no-console
      console.error(`[duckdb] engine unavailable: ${err.message}`);
    }
  }
  if (!result && duckdbUnavailable && !serverEnv().SQL_PROTOTYPE_FALLBACK) {
    // World-class stance: fail loudly and actionably instead of silently
    // returning weaker (and differently-typed) results from a fallback engine.
    throw new ApiError(503, "ENGINE_UNAVAILABLE", ENGINE_UNAVAILABLE_MESSAGE);
  }
  if (!result) {
    if (sources.length > 1)
      throw new SqlError(
        "Cross-dataset joins require the DuckDB engine. How to fix: enable DuckDB and retry the query.",
      );
    const source = { columns: sources[0]!.columns, rows: sources[0]!.loaded.rows as SqlValue[][] };
    const fallback = executeSql(source, sql, { rowCap });
    const degradedNote = duckdbUnavailable
      ? ` Degraded mode: the DuckDB engine was unavailable, so this result came from the deterministic prototype parser (SQL_PROTOTYPE_FALLBACK). Treat it as exploratory only.`
      : "";
    result = { ...fallback, note: `${fallback.note}${coverageNote}${degradedNote}` };
  }

  return {
    datasetId: dataset.id,
    datasetName: dataset.name,
    datasetRowCount: dataset.rowCount,
    projectId: dataset.projectId,
    rowsLoaded: sources.reduce((sum, source) => sum + source.loaded.rows.length, 0),
    result,
    coverageNote,
    sourceDatasetIds: datasets.map((source) => source.id),
  };
}

const ENGINE_UNAVAILABLE_MESSAGE =
  "The DuckDB query engine could not start, so this query was not run and no result was produced. How to fix: confirm the server has the DuckDB wasm assets (run `npm run copy:duckdb`) and retry. To run read-only SELECTs on the legacy deterministic parser instead (weaker SQL support, clearly labelled as degraded), set SQL_PROTOTYPE_FALLBACK=true.";

function tableAlias(name: string): string {
  const clean = name
    .replace(/[^a-zA-Z0-9_ ]/g, " ")
    .trim()
    .split(/\s+/)
    .join("_")
    .toLowerCase();
  return clean || "dataset";
}

/** True when `column` exists on the dataset (cheap check for UI prefill). */
export function hasColumn(cols: { name: string }[], column: string | null | undefined): boolean {
  return !!column && cols.some((c) => c.name === column || c.name.toLowerCase() === column.toLowerCase());
}
