import { ApiError, notFoundError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { datasetColumns } from "@/lib/serialize";
import { ok, toErrorResponse } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

/**
 * GET /api/datasets/[id]/values?column=<name>&limit=<n>
 *
 * Distinct values of ONE column, read from the dataset through the SAME
 * authorization + RLS path as every other dataset read. This is the "real
 * source" behind cross-filtering: dashboard slicers and drill-through lists
 * fetch the live distinct values instead of relying on whichever aggregate
 * snapshot happened to be saved with the widget.
 *
 * Response: { column, values, truncated, total, note }
 *   - values are ordered by first appearance in the stored (row-limited) read
 *   - `truncated` reports when the column had more distinct values than `limit`
 */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const url = new URL(request.url);
    const column = url.searchParams.get("column")?.trim();
    if (!column) throw new ApiError(400, "VALIDATION", "Provide the ?column= whose distinct values to list.");
    const limitRaw = Number(url.searchParams.get("limit") ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 1000) : 200;

    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");

    const cols = datasetColumns(dataset);
    const idx = cols.findIndex((c) => c.name === column);
    if (idx < 0) throw new ApiError(400, "VALIDATION", `Column “${column}” does not exist on this dataset.`);

    const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    // RLS through the shared chokepoint: a restricted user sees only the
    // distinct values of the rows they may see — never the hidden ones.
    const rls = await applyRowSecurity(ctx, dataset, { rows: loaded.rows, columns: cols });

    const values: string[] = [];
    const seen = new Set<string>();
    let truncated = false;
    for (const row of rls.rows) {
      const v = row[idx];
      if (v === null || v === undefined || v === "") continue;
      const s = String(v);
      if (seen.has(s)) continue;
      seen.add(s);
      if (values.length >= limit) {
        truncated = true;
        break;
      }
      values.push(s);
    }

    return ok({
      column,
      values,
      truncated,
      total: rls.rows.length,
      note: rls.note,
      sampled: loaded.totalRows > loaded.rows.length,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
