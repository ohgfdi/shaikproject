import { NextRequest, NextResponse } from "next/server";

import {
  DaxError,
  evaluateMeasure,
  evaluateMeasureByCategory,
  validateMeasure,
  type DaxFilter,
} from "@/lib/engine/dax";
import { toErrorResponse } from "@/lib/server/api";
import { validateApiKey, requireScope, addApiKeyHeaders } from "@/lib/server/api-key-auth";
import { loadAuthorizedDataset } from "@/lib/server/dataset-access";

export const dynamic = "force-dynamic";

/**
 * POST /api/public/v1/datasets/[id]/dax
 *
 * Evaluate a DAX measure against a dataset with real filter-context semantics
 * (the same engine the DAX studio uses — oracle-tested in CI). Requires scope:
 * execute:dax. Values are always computed from the dataset's actual rows;
 * RLS rules are resolved before the engine sees a row.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const auth = await validateApiKey(request);
    if (auth instanceof NextResponse) return auth;
    const { context } = auth;

    if (!requireScope(context, "execute:dax")) {
      return NextResponse.json(
        { ok: false, error: { code: "FORBIDDEN", message: "Scope 'execute:dax' required" } },
        { status: 403 },
      );
    }

    const params = await props.params;
    const body = (await request.json().catch(() => ({}))) as {
      measure?: string;
      filters?: DaxFilter[];
      byCategory?: string;
    };
    const measure = (body.measure ?? "").trim();
    if (!measure) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION", message: "Provide a 'measure' body field, e.g. SUM([Amount])." } },
        { status: 400 },
      );
    }
    if (measure.length > 5_000) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION", message: "Measure is too long (max 5,000 characters)." } },
        { status: 400 },
      );
    }
    const syntaxErrors = validateMeasure(measure);
    if (syntaxErrors.length) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION", message: `Measure syntax error: ${syntaxErrors[0]}` } },
        { status: 400 },
      );
    }

    const loaded = await loadAuthorizedDataset(
      { userId: context.userId, workspaceId: context.workspaceId },
      params.id,
      { minRole: "VIEWER" },
    );

    const filters = (body.filters ?? []).slice(0, 20);
    for (const f of filters) {
      if (!loaded.columns.some((c) => c.name === f.column)) {
        return NextResponse.json(
          { ok: false, error: { code: "VALIDATION", message: `Filter column “${f.column}” is not in this dataset.` } },
          { status: 400 },
        );
      }
    }
    if (body.byCategory && !loaded.columns.some((c) => c.name === body.byCategory)) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "VALIDATION", message: `Category column “${body.byCategory}” is not in this dataset.` },
        },
        { status: 400 },
      );
    }

    try {
      const model = { columns: loaded.columns.map((c) => c.name), rows: loaded.rows };
      if (body.byCategory) {
        const series = evaluateMeasureByCategory(model, measure, body.byCategory, filters);
        const response = NextResponse.json({
          ok: true,
          datasetId: loaded.datasetId,
          byCategory: body.byCategory,
          series,
          note: "Computed from actual rows with DAX filter-context semantics.",
          ...(loaded.note ? { rlsNote: loaded.note } : {}),
        });
        return addApiKeyHeaders(response, context);
      }
      const value = evaluateMeasure(model, measure, filters);
      const response = NextResponse.json({
        ok: true,
        datasetId: loaded.datasetId,
        value,
        note: "Computed from actual rows with DAX filter-context semantics.",
        ...(loaded.note ? { rlsNote: loaded.note } : {}),
      });
      return addApiKeyHeaders(response, context);
    } catch (err) {
      if (err instanceof DaxError) {
        return NextResponse.json({ ok: false, error: { code: "DAX_INPUT", message: err.message } }, { status: 400 });
      }
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
