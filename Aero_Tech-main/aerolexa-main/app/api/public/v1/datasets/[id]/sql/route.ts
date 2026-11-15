import { NextRequest, NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/server/api";
import { validateApiKey, requireScope, addApiKeyHeaders } from "@/lib/server/api-key-auth";
import { runQueryOnDataset } from "@/lib/server/dataset-query";
import { requireModule } from "@/lib/server/modules";

export const dynamic = "force-dynamic";

/**
 * POST /api/public/v1/datasets/[id]/sql
 *
 * Run a read-only SELECT against a dataset on the DuckDB engine — the same
 * engine, RLS chokepoint and row caps the in-app SQL Lab uses. Requires scope:
 * execute:sql. Read-only is enforced by the shared guard (DDL/DML rejected);
 * results are capped with exact totals and carry the engine note.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const auth = await validateApiKey(request);
    if (auth instanceof NextResponse) return auth;
    const { context } = auth;

    // The public surface obeys the same freeze as the in-app SQL Lab — a
    // frozen module must not stay reachable through an API key.
    requireModule("SQL_LAB_ENABLED");

    if (!requireScope(context, "execute:sql")) {
      return NextResponse.json(
        { ok: false, error: { code: "FORBIDDEN", message: "Scope 'execute:sql' required" } },
        { status: 403 },
      );
    }

    const params = await props.params;
    const body = (await request.json().catch(() => ({}))) as { sql?: string; limit?: number };
    const sql = (body.sql ?? "").trim();
    if (!sql) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION", message: "Provide a 'sql' body field with a read-only SELECT." } },
        { status: 400 },
      );
    }
    if (sql.length > 20_000) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION", message: "SQL is too long (max 20,000 characters)." } },
        { status: 400 },
      );
    }

    const principal = { userId: context.userId, workspaceId: context.workspaceId } as unknown as Parameters<
      typeof runQueryOnDataset
    >[0];
    const outcome = await runQueryOnDataset(principal, params.id, sql, {
      rowCap:
        typeof body.limit === "number" && Number.isInteger(body.limit) && body.limit > 0
          ? Math.min(body.limit, 10_000)
          : undefined,
    });

    const response = NextResponse.json({
      ok: true,
      datasetId: outcome.datasetId,
      datasetName: outcome.datasetName,
      columns: outcome.result.columns,
      rows: outcome.result.rows,
      rowCount: outcome.result.rows.length,
      totalResultRows: outcome.result.totalMatched,
      truncated: outcome.result.truncated,
      engine: outcome.result.engine,
      engineNote: `${outcome.result.note ?? ""}${outcome.coverageNote}`,
    });
    return addApiKeyHeaders(response, context);
  } catch (err) {
    return toErrorResponse(err);
  }
}
