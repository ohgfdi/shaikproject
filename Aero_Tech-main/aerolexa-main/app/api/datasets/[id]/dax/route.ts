import { requireAuth } from "@/lib/auth/guard";
import {
  DaxError,
  evaluateMeasure,
  evaluateMeasureByCategory,
  validateMeasure,
  type DaxFilter,
} from "@/lib/engine/dax";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { badRequest, loadDatasetFrame } from "@/lib/server/pbi-frame";

export const dynamic = "force-dynamic";

/**
 * POST /api/datasets/[id]/dax
 *
 * Evaluate a DAX-style measure against the dataset. All values are computed
 * from the actual rows with filter-context semantics — nothing is simulated.
 *
 * Body: { measure: string, filters?: {column, values|null}[], byCategory?: string }
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const frame = await loadDatasetFrame(ctx, params.id);
    const body = await readJsonBody<{
      measure?: string;
      filters?: DaxFilter[];
      byCategory?: string;
    }>(request);

    const measure = (body.measure ?? "").trim();
    if (!measure) throw badRequest("Write a measure expression first.");
    if (measure.length > 5_000) throw badRequest("Measure is too long (max 5 000 characters).");

    const syntaxErrors = validateMeasure(measure);
    if (syntaxErrors.length) throw badRequest(`Measure syntax error: ${syntaxErrors[0]}`);

    const filters = (body.filters ?? []).slice(0, 20);
    for (const f of filters) {
      if (!frame.columns.some((c) => c.name === f.column)) {
        throw badRequest(`Filter column “${f.column}” is not in this dataset.`);
      }
    }
    if (body.byCategory && !frame.columns.some((c) => c.name === body.byCategory)) {
      throw badRequest(`Category column “${body.byCategory}” is not in this dataset.`);
    }

    try {
      if (body.byCategory) {
        const series = evaluateMeasureByCategory(
          { columns: frame.columns.map((c) => c.name), rows: frame.rows },
          measure,
          body.byCategory,
          filters,
        );
        await logActivity(
          ctx,
          "DAX_MEASURE",
          `Evaluated measure on “${frame.datasetName}” by ${body.byCategory}`,
          frame.projectId,
          { datasetId: frame.datasetId },
        );
        return ok({ series, note: "Computed from actual rows with DAX filter-context semantics." });
      }
      const value = evaluateMeasure({ columns: frame.columns.map((c) => c.name), rows: frame.rows }, measure, filters);
      await logActivity(ctx, "DAX_MEASURE", `Evaluated measure on “${frame.datasetName}”`, frame.projectId, {
        datasetId: frame.datasetId,
      });
      return ok({ value, note: "Computed from actual rows with DAX filter-context semantics." });
    } catch (err) {
      if (err instanceof DaxError) throw badRequest(err.message);
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
