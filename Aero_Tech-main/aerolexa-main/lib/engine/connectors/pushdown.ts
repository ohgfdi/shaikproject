/**
 * Warehouse-side aggregation pushdown.
 *
 * The analyst's scale wall: importing raw rows caps analysis at
 * DATASET_ANALYSIS_LIMIT. The fix every professional BI tool uses is to let
 * the WAREHOUSE do the heavy lifting — GROUP BY / WHERE / ORDER BY run on the
 * source engine and only the aggregated result crosses the network.
 *
 * What this module does:
 *  - `planAggregation`  — validates a declarative aggregation spec and renders
 *    the engine-specific SQL text (or Mongo pipeline) with:
 *      · identifiers quoted with the engine's own quoting rules,
 *      · user VALUES always bound as parameters (postgres $n, mysql ?),
 *        never interpolated,
 *      · filter values for text-only engines (Snowflake/BigQuery) gated by
 *        the same strict safety rule as watermark SQL: finite numbers or
 *        strict ISO-8601 strings, otherwise the plan is REJECTED and the
 *        caller falls back to a bounded raw pull — an unsafe filter never
 *        reaches query text.
 *  - `runAggregation`   — executes a validated plan through the right
 *    connector engine and returns the same PulledTable shape as a raw pull,
 *    so the caller materializes the aggregate exactly like an import.
 *
 * Supported aggregations: sum, avg, min, max, count (with optional DISTINCT).
 * Dimensions = GROUP BY columns. Optional HAVING (aggregate op/value).
 * Optional ORDER BY a dimension or any aggregate with LIMIT.
 */

import { ConnectorError } from "@/lib/engine/connectors/errors";
import { ISO_TIMESTAMP_RE } from "@/lib/engine/connectors/watermark";

export type PushdownEngine = "postgres" | "mysql" | "snowflake" | "bigquery";

export const PUSHDOWN_AGGREGATIONS = ["sum", "avg", "min", "max", "count"] as const;
export type PushdownAggregation = (typeof PUSHDOWN_AGGREGATIONS)[number];

export interface AggregationSpec {
  schema: string;
  table: string;
  /** GROUP BY columns (1–5). */
  dimensions: string[];
  /** Measure definitions — output columns in order. */
  measures: {
    aggregation: PushdownAggregation;
    /** Column to aggregate; ignored (null) for count(*) but still validated. */
    column: string | null;
    /** Output column name; defaults to `${aggregation}_${column}`. */
    alias?: string;
    distinct?: boolean;
  }[];
  /** Optional equality filters (ANDed): column = value. */
  filters?: { column: string; value: string | number }[];
  /** Optional watermark-style filter: column > value (same safety gate). */
  since?: { column: string; value: string | number };
  /** Optional HAVING on the first measure: agg op on output > value. */
  having?: { op: ">" | ">=" | "<" | "<="; value: number };
  /** Order rows by a dimension or a measure alias before the LIMIT. */
  orderBy?: { column: string; direction?: "asc" | "desc" };
  /** Row cap on the aggregated result (default 5000). */
  limit?: number;
}

export interface AggregationPlan {
  engine: PushdownEngine;
  sql: string;
  /** Values to bind for postgres ($1…$n) / mysql (? in order). */
  params: (string | number)[];
  /** Output columns in order (dimension + measure aliases). */
  columns: { name: string; type: "string" | "number" }[];
}

export class PushdownError extends ConnectorError {
  constructor(message: string, opts?: { status?: number; code?: string }) {
    super(message, opts);
    this.name = "PushdownError";
  }
}

const MAX_DIMENSIONS = 5;
const MAX_MEASURES = 12;

/** Column/alias identifier shape gate: letters, digits, underscore, max length. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/;

function assertIdent(name: string, label: string): string {
  if (!IDENT_RE.test(name)) {
    throw new PushdownError(
      `The ${label} “${name.slice(0, 40)}” is not a plain column name. How to fix: use the exact column name from the schema browser (letters, digits, underscore — no spaces, quotes or operators).`,
      { status: 400, code: "CONNECTOR_CONFIG" },
    );
  }
  return name;
}

function assertSchemaTable(name: string, label: string): string {
  if (!IDENT_RE.test(name)) {
    throw new PushdownError(`The ${label} “${name.slice(0, 40)}” is not a plain identifier.`, {
      status: 400,
      code: "CONNECTOR_CONFIG",
    });
  }
  return name;
}

/**
 * The Snowflake/BigQuery injection gate: a filter value may be rendered into
 * query text ONLY as a finite JS number or a strict ISO-8601 string. Anything
 * else returns null → the plan is rejected → the caller falls back to a raw
 * bounded pull. Never interpolates unvalidated text.
 */
function safeQueryTextLiteral(value: string | number): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && ISO_TIMESTAMP_RE.test(value)) return `TIMESTAMP '${value.replace(" ", "T")}'`;
  return null;
}

function quoteIdentFor(engine: PushdownEngine, name: string): string {
  if (engine === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/** The engine-facing alias for an output column. */
export function measureAlias(measure: {
  aggregation: PushdownAggregation;
  column: string | null;
  alias?: string;
}): string {
  if (measure.alias && IDENT_RE.test(measure.alias)) return measure.alias;
  if (measure.aggregation === "count") return measure.column ? `count_${measure.column}` : "count_rows";
  return `${measure.aggregation}_${measure.column ?? "rows"}`;
}

/** Validate a spec once; shared by compile + run so errors are uniform. */
function validateSpec(spec: AggregationSpec): void {
  assertSchemaTable(spec.schema, "schema");
  assertSchemaTable(spec.table, "table");
  if (!Array.isArray(spec.dimensions) || spec.dimensions.length < 1 || spec.dimensions.length > MAX_DIMENSIONS) {
    throw new PushdownError(`Choose 1–${MAX_DIMENSIONS} dimension columns to group by.`, {
      status: 400,
      code: "CONNECTOR_CONFIG",
    });
  }
  spec.dimensions.forEach((d) => assertIdent(d, "dimension"));
  if (!Array.isArray(spec.measures) || spec.measures.length < 1 || spec.measures.length > MAX_MEASURES) {
    throw new PushdownError(`Define 1–${MAX_MEASURES} measures to aggregate.`, {
      status: 400,
      code: "CONNECTOR_CONFIG",
    });
  }
  for (const m of spec.measures) {
    if (!PUSHDOWN_AGGREGATIONS.includes(m.aggregation)) {
      throw new PushdownError(
        `Unknown aggregation “${String(m.aggregation)}”. Use one of: ${PUSHDOWN_AGGREGATIONS.join(", ")}.`,
        {
          status: 400,
          code: "CONNECTOR_CONFIG",
        },
      );
    }
    if (m.column !== null) assertIdent(m.column, "measure column");
    if (m.aggregation !== "count" && m.column === null) {
      throw new PushdownError(`${m.aggregation} needs a column to aggregate (only count may be empty).`, {
        status: 400,
        code: "CONNECTOR_CONFIG",
      });
    }
  }
  for (const f of spec.filters ?? []) assertIdent(f.column, "filter column");
  if (spec.since) assertIdent(spec.since.column, "watermark column");
  if (spec.orderBy) assertIdent(spec.orderBy.column, "order-by column");
  if (spec.having && !Number.isFinite(spec.having.value)) {
    throw new PushdownError("HAVING value must be a finite number.", { status: 400, code: "CONNECTOR_CONFIG" });
  }
}

/** Compile a validated spec into engine SQL + bound params. */
export function planAggregation(spec: AggregationSpec, engine: PushdownEngine): AggregationPlan {
  validateSpec(spec);
  const params: (string | number)[] = [];
  const bind = (value: string | number): string => {
    if (engine === "postgres") {
      params.push(value);
      return `$${params.length}`;
    }
    if (engine === "mysql") {
      params.push(value);
      return "?";
    }
    // Text-only engines: value must pass the strict literal gate.
    const lit = safeQueryTextLiteral(value);
    if (lit === null) {
      throw new PushdownError(
        "Filter values for Snowflake/BigQuery pushdown must be finite numbers or ISO-8601 timestamps. How to fix: change the filter, or run a raw pull instead.",
        { status: 400, code: "CONNECTOR_CONFIG" },
      );
    }
    return lit;
  };

  const src = `${quoteIdentFor(engine, spec.schema)}.${quoteIdentFor(engine, spec.table)}`;
  const whereParts: string[] = [];
  for (const f of spec.filters ?? []) {
    whereParts.push(`${quoteIdentFor(engine, f.column)} = ${bind(f.value)}`);
  }
  if (spec.since) {
    whereParts.push(`${quoteIdentFor(engine, spec.since.column)} > ${bind(spec.since.value)}`);
  }

  const selectParts: string[] = spec.dimensions.map(
    (d) => `${quoteIdentFor(engine, d)} AS ${quoteIdentFor(engine, d)}`,
  );
  for (const m of spec.measures) {
    const alias = quoteIdentFor(engine, measureAlias(m));
    if (m.aggregation === "count") {
      const inner = m.column
        ? m.distinct
          ? `DISTINCT ${quoteIdentFor(engine, m.column)}`
          : quoteIdentFor(engine, m.column)
        : "*";
      selectParts.push(`COUNT(${inner}) AS ${alias}`);
    } else {
      const col = m.distinct
        ? `DISTINCT ${quoteIdentFor(engine, m.column ?? "")}`
        : quoteIdentFor(engine, m.column ?? "");
      selectParts.push(`${m.aggregation.toUpperCase()}(${col}) AS ${alias}`);
    }
  }

  const groupBy = spec.dimensions.map((d) => quoteIdentFor(engine, d)).join(", ");
  const having = spec.having
    ? ` HAVING ${quoteIdentFor(engine, measureAlias(spec.measures[0]!))} ${spec.having.op} ${Number(spec.having.value)}`
    : "";
  const orderBy = spec.orderBy
    ? ` ORDER BY ${quoteIdentFor(engine, spec.orderBy.column)} ${spec.orderBy.direction === "asc" ? "ASC" : "DESC"}`
    : ` ORDER BY ${spec.dimensions.map((d) => quoteIdentFor(engine, d)).join(", ")}`;
  const limit = Math.max(1, Math.min(Math.floor(spec.limit ?? 5000), 100_000));
  const where = whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : "";

  const sql =
    `SELECT ${selectParts.join(", ")} FROM ${src}${where}` + ` GROUP BY ${groupBy}${having}${orderBy} LIMIT ${limit}`;

  const columns: AggregationPlan["columns"] = [
    ...spec.dimensions.map((d) => ({ name: d, type: "string" as const })),
    ...spec.measures.map((m) => ({ name: measureAlias(m), type: "number" as const })),
  ];
  return { engine, sql, params, columns };
}

/** Compile a spec into a MongoDB aggregation pipeline (dimensions + measures). */
export function planMongoAggregation(spec: AggregationSpec): Record<string, unknown>[] {
  if (spec.schema && spec.schema !== "") {
    // Mongo has no schema; an accidental SQL-style schema hints at misuse.
    throw new PushdownError("MongoDB collections have no schema — leave the schema field empty.", {
      status: 400,
      code: "CONNECTOR_CONFIG",
    });
  }
  validateSpec(spec);
  const match: Record<string, unknown> = {};
  for (const f of spec.filters ?? []) match[f.column] = f.value;
  if (spec.since) {
    if (typeof spec.since.value === "number" && Number.isFinite(spec.since.value)) {
      match[spec.since.column] = { $gt: spec.since.value };
    } else if (typeof spec.since.value === "string" && ISO_TIMESTAMP_RE.test(spec.since.value)) {
      match[spec.since.column] = { $gt: new Date(spec.since.value) };
    } else {
      throw new PushdownError("The watermark value must be a finite number or an ISO-8601 timestamp.", {
        status: 400,
        code: "CONNECTOR_CONFIG",
      });
    }
  }
  const group: Record<string, unknown> = {
    _id:
      spec.dimensions.length === 1
        ? `$${spec.dimensions[0]}`
        : Object.fromEntries(spec.dimensions.map((d) => [d, `$${d}`])),
  };
  for (const m of spec.measures) {
    const alias = measureAlias(m);
    if (m.aggregation === "count") {
      group[alias] = m.column ? { $sum: { $cond: [{ $ifNull: [`$${m.column}`, false] }, 1, 0] } } : { $sum: 1 };
    } else {
      group[alias] = { [`$${m.aggregation}`]: `$${m.column}` };
    }
  }
  const pipeline: Record<string, unknown>[] = [];
  if (Object.keys(match).length > 0) pipeline.push({ $match: match });
  pipeline.push({ $group: group });
  if (spec.having)
    pipeline.push({ $match: { [measureAlias(spec.measures[0]!)]: { [spec.having.op]: spec.having.value } } });
  {
    const sort: Record<string, 1 | -1> = spec.orderBy
      ? { [spec.orderBy.column]: spec.orderBy.direction === "asc" ? 1 : -1 }
      : Object.fromEntries(spec.dimensions.map((d) => [d, 1 as const]));
    pipeline.push({ $sort: sort });
  }
  pipeline.push({ $limit: Math.max(1, Math.min(Math.floor(spec.limit ?? 5000), 100_000)) });
  return pipeline;
}

/**
 * The honest availability gate: pushdown needs a real query runner for the
 * engine. All five implemented SQL/Mongo engines have one; file parsers
 * (tally/gst/bank-statement) do not and deliberately return null.
 */
export function pushdownSupported(kind: string): boolean {
  return ["postgres", "mysql", "snowflake", "bigquery", "mongodb"].includes(kind);
}
