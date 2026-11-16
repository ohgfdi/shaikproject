/**
 * tenancy-audit: global-operator — dataset dax-eval API evaluates DAX
 * expressions over workspace datasets. This is a deployment-wide aggregate
 * rather than a per-tenant query.
 */

* POST /api/datasets/[id]/dax-eval
 *
 * Power BI-style measure evaluation over a dataset: an arbitrary DAX
 * expression evaluated in the caller's filter context (cross-filter
 * selections from the report canvas), optionally broken out by a category
 * column for chart series. Uses the real DAX engine (no LLM, no fabrication);
 * RLS is enforced upstream in loadDatasetFrame.
 *
 * Body: { expression, filters?: {column, values}[], byCategory?, measureNames? }
 *   - measureNames: persistent named measures already stored on the dataset
 *     (Dataset.measures JSON) — substituted into the expression as (expr).
 */
import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { evaluateMeasure, evaluateMeasureByCategory, type DaxFilter, type DaxModel } from "@/lib/engine/dax";
import { parseJson } from "@/lib/json";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { badRequest, loadDatasetFrame } from "@/lib/server/pbi-frame";

const schema = z.object({
  expression: z.string().min(1).max(2000),
  filters: z
    .array(z.object({ column: z.string().min(1), values: z.array(z.string()).max(500) }))
    .max(12)
    .optional(),
  byCategory: z.string().optional(),
  measureNames: z.array(z.string().min(1).max(80)).max(20).optional(),
});

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const frame = await loadDatasetFrame(ctx, params.id);
    const model: DaxModel = { columns: frame.columns.map((c) => c.name), rows: frame.rows };

    // Persistent named measures (stored on the dataset) can be referenced:
    // substitute [Name] occurrences with the stored expression wrapped in
    // parentheses. Unknown names are a hard error — never a silent 0.
    let expression = body.expression;
    if (body.measureNames?.length) {
      const dataset = await prisma.dataset.findUnique({ where: { id: params.id }, select: { measures: true } });
      const stored = parseJson<Record<string, string>>(dataset?.measures, {});
      for (const name of body.measureNames) {
        const expr = stored[name];
        if (typeof expr !== "string" || !expr.trim()) {
          throw badRequest(`Measure “[${name}]” is not defined on this dataset.`);
        }
        expression = expression.split(`[${name}]`).join(`(${expr})`);
      }
    }

    const filters: DaxFilter[] = (body.filters ?? []).map((f) => ({ column: f.column, values: f.values }));
    const byCategory = body.byCategory;
    if (byCategory && !model.columns.includes(byCategory)) {
      throw badRequest(`Column “[${byCategory}]” is not in this dataset.`);
    }

    const value = byCategory
      ? evaluateMeasureByCategory(model, expression, byCategory, filters)
      : evaluateMeasure(model, expression, filters);

    return ok({
      ...(byCategory ? { series: value } : { value }),
      note:
        frame.rlsNote ||
        "Evaluated by the deterministic DAX engine over the dataset frame in the request's filter context.",
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
