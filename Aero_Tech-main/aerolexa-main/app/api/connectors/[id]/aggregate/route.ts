import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { importConnectorAggregation } from "@/lib/server/connector-sync";

export const dynamic = "force-dynamic";

interface AggregationRequestBody {
  schema?: string;
  table?: string;
  dimensions?: string[];
  measures?: { aggregation?: string; column?: string | null; alias?: string; distinct?: boolean }[];
  filters?: { column?: string; value?: string | number }[];
  since?: { column?: string; value?: string | number };
  having?: { op?: string; value?: number };
  orderBy?: { column?: string; direction?: string };
  limit?: number;
  name?: string;
}

/**
 * POST /api/connectors/[id]/aggregate — warehouse-side aggregation pushdown.
 *
 * Body: { schema, table, dimensions[], measures[{aggregation, column, alias}],
 *         filters?, since?, having?, orderBy?, limit?, name }
 *
 * The GROUP BY runs ON the source engine (Postgres/MySQL via parameterized
 * SQL, Snowflake/BigQuery via gated query text, MongoDB via a $group
 * pipeline) and only aggregated rows cross the network. The result is
 * materialized as a Dataset like any import. Identifiers are engine-quoted;
 * user values are bound as parameters, or the request is rejected before any
 * query text is built.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<AggregationRequestBody>(request);

    const spec = {
      schema: (body.schema ?? "").trim(),
      table: (body.table ?? "").trim(),
      dimensions: (body.dimensions ?? []).map((d) => String(d).trim()).filter(Boolean),
      measures: (body.measures ?? []).map((m) => ({
        aggregation: m.aggregation,
        column: m.column == null || m.column === "" ? null : String(m.column).trim(),
        alias: m.alias ? String(m.alias).trim() : undefined,
        distinct: Boolean(m.distinct),
      })),
      filters: (body.filters ?? []).map((f) => ({
        column: String(f.column ?? "").trim(),
        value: f.value as string | number,
      })),
      since: body.since
        ? { column: String(body.since.column ?? "").trim(), value: body.since.value as string | number }
        : undefined,
      having: body.having ? { op: body.having.op, value: Number(body.having.value) } : undefined,
      orderBy: body.orderBy
        ? { column: String(body.orderBy.column ?? "").trim(), direction: body.orderBy.direction }
        : undefined,
      limit: body.limit,
    } as const;

    const result = await importConnectorAggregation({
      ctx,
      connectorId: params.id,
      spec: spec as unknown as Parameters<typeof importConnectorAggregation>[0]["spec"],
      datasetName: body.name ?? "",
    });
    return ok({ ...result, connectorId: params.id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
