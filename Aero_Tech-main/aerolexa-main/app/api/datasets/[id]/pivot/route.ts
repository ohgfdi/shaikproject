import { ApiError, notFoundError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { runQueryOnDataset } from "@/lib/server/dataset-query";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

interface PivotBody {
  rows: string[];
  columns: string[];
  values: { column: string; aggregation: "sum" | "count" | "avg" | "min" | "max" }[];
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/** Same normalization the shared query engine uses for dataset table aliases. */
function tableAlias(name: string): string {
  const clean = name
    .replace(/[^a-zA-Z0-9_ ]/g, " ")
    .trim()
    .split(/\s+/)
    .join("_")
    .toLowerCase();
  return clean || "dataset";
}

/**
 * Pivot aggregation for a dataset.
 *
 * Produces a TRUE wide pivot: the `columns` dimension's distinct values become
 * result columns ("colValue — agg(valueCol)"), the `rows` dimensions stay as
 * leading group-by columns, and each cell aggregates the matching rows. The
 * whole computation runs through the SAME engine path as the SQL Lab
 * (`runQueryOnDataset`) — DuckDB when available — so RLS, row caps and engine
 * notes are identical to every other dataset read. The pivot-to-wide reshape
 * happens on the engine's grouped result; no number is fabricated client-side.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<PivotBody>(request);
    const { rows, columns, values } = body;

    if (!rows?.length) throw new ApiError(400, "VALIDATION", "At least one row group-by column is required.");
    if (!columns?.length) throw new ApiError(400, "VALIDATION", "At least one pivot column is required.");
    if (!values?.length) throw new ApiError(400, "VALIDATION", "At least one value aggregation is required.");

    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");

    // One grouped query: rows × column-dimension × value aggregates. The
    // column dimension participates in the GROUP BY so every (rowKey, colKey)
    // cell arrives as its own grouped row; the wide reshape below folds it.
    const groupBy = [...rows, ...columns].map(quote).join(", ");
    const aggregations = values
      .map((v, i) => `${v.aggregation}(${quote(v.column)}) AS ${quote(`agg_${i}`)}`)
      .join(", ");
    const sql = [
      `SELECT ${groupBy}, ${aggregations}`,
      `FROM ${quote(tableAlias(dataset.name))}`,
      `GROUP BY ${groupBy}`,
      `ORDER BY ${groupBy}`,
      `LIMIT ${serverEnv().DATASET_QUERY_LIMIT}`,
    ].join(" ");

    const outcome = await runQueryOnDataset(ctx, dataset.id, sql, { minRole: "VIEWER" });

    // Wide reshape on the engine's grouped result.
    // Result columns: [row1 … rowN, col1 … colM, agg_0 … agg_k]
    const nRows = rows.length;
    const nCols = columns.length;
    const nVals = values.length;
    const rowKeyOf = (r: (string | number | boolean | null)[]) =>
      r
        .slice(0, nRows)
        .map((v) => String(v ?? ""))
        .join("\u0001");
    const colKeyOf = (r: (string | number | boolean | null)[]) =>
      r
        .slice(nRows, nRows + nCols)
        .map((v) => String(v ?? ""))
        .join("\u0001");

    const rowKeys: string[] = [];
    const rowHeaderRows = new Map<string, (string | number | boolean | null)[]>();
    const colKeys: string[] = [];
    const colKeySeen = new Set<string>();
    const cells = new Map<string, (string | number | boolean | null)[]>();
    for (const r of outcome.result.rows as (string | number | boolean | null)[][]) {
      const rk = rowKeyOf(r);
      const ck = colKeyOf(r);
      if (!rowHeaderRows.has(rk)) {
        rowHeaderRows.set(rk, r.slice(0, nRows));
        rowKeys.push(rk);
      }
      if (!colKeySeen.has(ck)) {
        colKeySeen.add(ck);
        colKeys.push(ck);
      }
      cells.set(`${rk}\u0001${ck}`, r.slice(nRows + nCols, nRows + nCols + nVals));
    }
    colKeys.sort((a, b) => a.localeCompare(b));

    const columnHeaders = [
      ...rows,
      ...colKeys.flatMap((ck) =>
        values.map((v, i) => `${ck.replace(/\u0001/g, " | ")} — ${v.column} (${v.aggregation}) [${i}]`),
      ),
    ];
    const wideRows = rowKeys.map((rk) => {
      const header = rowHeaderRows.get(rk) as (string | number | boolean | null)[];
      const cellsRow = colKeys.flatMap(() => values.map(() => null as string | number | boolean | null));
      colKeys.forEach((ck, ci) => {
        const cell = cells.get(`${rk}\u0001${ck}`);
        if (cell) {
          for (let i = 0; i < nVals; i++) cellsRow[ci * nVals + i] = cell[i] ?? null;
        }
      });
      return [...header, ...cellsRow];
    });

    await logActivity(
      ctx,
      "PIVOT_TABLE",
      `Pivot table generated on “${dataset.name}” (${wideRows.length} rows × ${colKeys.length} column values)`,
      dataset.projectId,
      { datasetId: dataset.id, rows, columns, values: values.length },
    );

    return ok({
      rows: wideRows,
      columns: columnHeaders,
      rowColumns: rows,
      columnValues: colKeys.map((ck) => ck.replace(/\u0001/g, " | ")),
      values,
      rowCount: outcome.result.rowCount,
      engine: outcome.result.engine,
      note:
        outcome.result.note +
        ` Pivoted ${colKeys.length} distinct column value(s) into ${colKeys.length * nVals} result column(s).`,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
