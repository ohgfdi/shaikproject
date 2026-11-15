import { requireAuth } from "@/lib/auth/guard";
import { buildDecompositionTree, findKeyInfluencers } from "@/lib/engine/ai-visuals";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { badRequest, loadDatasetFrame } from "@/lib/server/pbi-frame";

export const dynamic = "force-dynamic";

/**
 * POST /api/datasets/[id]/ai-visuals
 *
 * Power BI AI visuals computed with deterministic statistics:
 *  - tree: decomposition tree of a measure sliced by up to 4 levels
 *  - influencers: key influencers of a boolean outcome with Wilson CIs
 *
 * Body:
 *   { mode: "tree", measureColumn, levels: string[], filters?: [{column, value}] }
 *   { mode: "influencers", outcomeColumn, analyzeColumns?: string[], minCount?: number }
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const frame = await loadDatasetFrame(ctx, params.id);
    const body = await readJsonBody<{
      mode?: "tree" | "influencers";
      measureColumn?: string;
      levels?: string[];
      filters?: { column: string; value: string }[];
      outcomeColumn?: string;
      analyzeColumns?: string[];
      minCount?: number;
    }>(request);

    const columnNames = frame.columns.map((c) => c.name);

    if (body.mode === "influencers") {
      const outcome = body.outcomeColumn ?? "";
      if (!columnNames.includes(outcome)) throw badRequest(`Outcome column “${outcome}” is not in this dataset.`);
      const result = findKeyInfluencers({
        columns: columnNames,
        rows: frame.rows,
        outcomeColumn: outcome,
        analyzeColumns: body.analyzeColumns?.filter((c) => columnNames.includes(c)),
        minCount: body.minCount,
      });
      await logActivity(
        ctx,
        "KEY_INFLUENCERS",
        `Ran key influencers on “${frame.datasetName}” for outcome “${outcome}”`,
        frame.projectId,
        { datasetId: frame.datasetId },
      );
      return ok({
        ...result,
        note: "Likelihoods are observed proportions with Wilson 95% intervals — computed from actual rows, not modelled predictions.",
      });
    }

    // default: decomposition tree
    const measureColumn = body.measureColumn ?? "";
    if (!columnNames.includes(measureColumn))
      throw badRequest(`Measure column “${measureColumn}” is not in this dataset.`);
    const levels = (body.levels ?? []).filter((l) => columnNames.includes(l)).slice(0, 4);
    if (!levels.length) throw badRequest("Pick at least one level column to slice by.");
    const tree = buildDecompositionTree({
      columns: columnNames,
      rows: frame.rows,
      measureColumn,
      levels,
      filters: body.filters,
    });
    await logActivity(
      ctx,
      "DECOMPOSITION_TREE",
      `Built decomposition tree on “${frame.datasetName}” (${measureColumn} by ${levels.join(" → ")})`,
      frame.projectId,
      { datasetId: frame.datasetId },
    );
    return ok({
      tree,
      note: "Children ranked by contribution contrast against their siblings — computed from actual rows.",
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
