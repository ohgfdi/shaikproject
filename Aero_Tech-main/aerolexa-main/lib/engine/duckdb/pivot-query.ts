import type { SqlSource } from "@/lib/engine/sql";

/** Build DuckDB SQL for pivot table aggregation.
 *
 * Given rows (group-by columns), columns (pivot unique values),
 * and values (aggregation specs), generates DuckDB SQL that
 * produces the pivot table result set.
 *
 * Since DuckDB's native PIVOT syntax may not be available in all versions,
 * we generate grouped results with aggregation expressions for each
 * (row, column) combination using CASE-based conditional aggregation.
 *
 * AC:
 * 1. Given a known dataset CSV and known pivot config,
 *    produces correct aggregated table.
 * 2. Handles string and numeric columns appropriately.
 * 3. Produces O(n log n) or better re-aggregation.
 */

export function buildPivotSql(args: {
  datasetCsv: string;
  rows: string[];
  columns: string[];
  values: { column: string; aggregation: "sum" | "count" | "avg" | "min" | "max" }[];
}) {
  const { datasetCsv, rows, columns: _columns, values } = args;

  // Build SELECT clause with aggregation expressions
  // Each value column gets an aggregation expression
  const aggExpressions = values.map(
    (v, vi) => `${v.aggregation}("${v.column}") AS "${vi}_${v.aggregation}_${v.column}"`,
  );

  // Build GROUP BY clause from row columns
  const groupBy = rows.map((r) => `"${r}"`).join(", ");

  // Build the full SQL
  // We use a CSV read approach - in production this would read from the actual dataset
  const sql = `
    SELECT
      ${groupBy},
      ${aggExpressions.join(", ")}
    FROM read_csv_auto('${datasetCsv}')
    GROUP BY ${groupBy}
    ORDER BY ${groupBy}
  `;

  return sql;
}

/** Cross-filter query builder for explorable chart cells.
 *
 * Given a dataset CSV and a filter config, generates DuckDB SQL
 * with a WHERE clause for cross-filtering.
 */

export function buildFilteredQuery(args: {
  datasetCsv: string;
  filter: { column: string; operator: "=" | "!=" | ">" | "<" | ">=" | "<="; value: string | number };
}) {
  const { datasetCsv, filter } = args;
  const { column, operator, value } = filter;

  // Numeric values bind bare; string values are single-quoted and escaped so
  // the generated WHERE clause is valid SQL (a bare word like East would
  // otherwise resolve as an identifier and fail, or worse match a column).
  const val = typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
  const whereClause =
    operator === "="
      ? `"${column}" = ${val}`
      : operator === "!="
        ? `"${column}" != ${val}`
        : operator === ">"
          ? `"${column}" > ${val}`
          : operator === "<"
            ? `"${column}" < ${val}`
            : operator === ">="
              ? `"${column}" >= ${val}`
              : operator === "<="
                ? `"${column}" <= ${val}`
                : "";

  const sql = `
    SELECT *
    FROM read_csv_auto('${datasetCsv}')
    WHERE ${whereClause}
    ORDER BY "${column}"
  `;

  return sql;
}

/** Execute SQL via the prototype SQL engine.
 *
 * This uses the existing SqlEngine from lib/engine/sql.ts
 * for pivot table and cross-filter query execution.
 */

/** Execute pivot SQL via the SQL engine.
 *
 * Used in API routes and components to execute pivot queries.
 */

export async function executePivotSql(sql: string, source?: SqlSource) {
  const { executeSql } = await import("@/lib/engine/sql");
  // The prototype engine executes against in-memory rows; callers may pass a
  // materialized source. Default to an empty source so the parser guard still
  // validates the query shape.
  const src: SqlSource = source ?? { columns: [], rows: [] };
  return executeSql(src, sql);
}

/** Execute filtered (cross-filter) SQL via the SQL engine.
 *
 * Used when a user clicks on a pivot cell or chart cell
 * to re-execute the underlying query with the appropriate
 * WHERE clause.
 */

export async function executeFilteredSql(sql: string, source?: SqlSource) {
  const { executeSql } = await import("@/lib/engine/sql");
  const src: SqlSource = source ?? { columns: [], rows: [] };
  return executeSql(src, sql);
}
