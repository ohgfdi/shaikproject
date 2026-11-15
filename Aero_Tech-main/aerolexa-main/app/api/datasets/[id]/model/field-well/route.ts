/**
 * POST /api/datasets/[id]/model/field-well
 *
 * Power BI field well: bind axis/value/legend columns and get back a REAL
 * ChartSpec computed by aggregating the dataset frame (RLS enforced, filter
 * context honored). The client renders the spec through the existing chart
 * suite — a re-bind is a real recomputation, never a hand-drawn chart.
 *
 * Body: { well: { axis: string[], values?: string[], legend?: string },
 *         agg?: "sum"|"count"|"avg"|"min"|"max", kind?: ChartSpec["kind"],
 *         filters?: { column, values }[] }
 */
import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { buildFieldWellSpec, validateFieldWell } from "@/lib/server/field-well";
import { badRequest, loadDatasetFrame } from "@/lib/server/pbi-frame";

const schema = z.object({
  well: z.object({
    axis: z.array(z.string().min(1).max(120)).min(1).max(3),
    values: z.array(z.string().min(1).max(120)).max(4).optional(),
    legend: z.string().max(120).optional(),
  }),
  agg: z.enum(["sum", "count", "avg", "min", "max"]).optional(),
  kind: z.string().max(30).optional(),
  filters: z
    .array(z.object({ column: z.string().min(1), values: z.array(z.string()).max(500) }))
    .max(12)
    .optional(),
});

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const frame = await loadDatasetFrame(ctx, params.id);

    const errors = validateFieldWell(frame, body.well);
    if (errors.length) throw badRequest(errors[0]!);

    // Filter context: keep only rows matching every selection (AND across
    // columns, OR within a column's values — the cross-filter semantics).
    let rows = frame.rows;
    for (const f of body.filters ?? []) {
      const idx = frame.columns.findIndex((c) => c.name === f.column);
      if (idx < 0) continue; // column not on this dataset → not filtered by it
      const allowed = new Set(f.values);
      rows = rows.filter((r) => allowed.has(String(r[idx])));
    }

    const spec = buildFieldWellSpec({ columns: frame.columns, rows }, body.well, {
      agg: body.agg,
      kind: body.kind as never,
    });
    return ok({ spec, rlsNote: frame.rlsNote || undefined, rowsEvaluated: rows.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
