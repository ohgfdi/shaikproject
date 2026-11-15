/**
 * POST /api/datasets/[id]/model/drill
 *
 * Power BI drill-down hierarchies over the dataset: send the hierarchy
 * (ordered levels) + the current drill path (values of the ancestor levels)
 * and get back the REAL ChartSpec for the next level, computed inside the
 * path's filter context (RLS enforced upstream). A stale path value (no rows)
 * is a hard error — never a silently-empty branch.
 *
 * Body: { hierarchy: { name, levels: string[] }, path?: string[],
 *         measure?: string, agg?: "sum"|"count"|"avg"|"min"|"max",
 *         filters?: { column, values }[] }
 */
import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { drillLevelSpec, validateHierarchy } from "@/lib/server/field-well";
import { badRequest, loadDatasetFrame } from "@/lib/server/pbi-frame";

const schema = z.object({
  hierarchy: z.object({
    name: z.string().min(1).max(80),
    levels: z.array(z.string().min(1).max(120)).min(2).max(6),
  }),
  path: z.array(z.string().min(1).max(300)).max(6).optional(),
  measure: z.string().max(120).optional(),
  agg: z.enum(["sum", "count", "avg", "min", "max"]).optional(),
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

    const errors = validateHierarchy(frame, body.hierarchy);
    if (errors.length) throw badRequest(errors[0]!);

    // Cross-filter context (same semantics as the field-well route).
    let rows = frame.rows;
    for (const f of body.filters ?? []) {
      const idx = frame.columns.findIndex((c) => c.name === f.column);
      if (idx < 0) continue;
      const allowed = new Set(f.values);
      rows = rows.filter((r) => allowed.has(String(r[idx])));
    }

    const { spec, level, parent } = drillLevelSpec({ columns: frame.columns, rows }, body.hierarchy, body.path ?? [], {
      measure: body.measure,
      agg: body.agg,
    });
    return ok({ spec, level, parent, rowsEvaluated: rows.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
