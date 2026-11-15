import { requireAuth } from "@/lib/auth/guard";
import { computeKpi } from "@/lib/engine/kpi";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { badRequest, loadDatasetFrame } from "@/lib/server/pbi-frame";

export const dynamic = "force-dynamic";

/**
 * POST /api/datasets/[id]/kpi
 *
 * KPI indicator card with target attainment, trend vs prior period and status.
 * Body: { measureColumn, dateColumn?, grain?, target?, targetColumn?, direction? }
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const frame = await loadDatasetFrame(ctx, params.id);
    const body = await readJsonBody<{
      measureColumn?: string;
      dateColumn?: string;
      grain?: "day" | "month" | "quarter" | "year";
      target?: number;
      targetColumn?: string;
      direction?: "increasing" | "decreasing";
      onTrackRatio?: number;
      offTrackRatio?: number;
    }>(request);

    const columnNames = frame.columns.map((c) => c.name);
    const measureColumn = body.measureColumn ?? "";
    if (!columnNames.includes(measureColumn))
      throw badRequest(`Measure column “${measureColumn}” is not in this dataset.`);
    if (body.dateColumn && !columnNames.includes(body.dateColumn))
      throw badRequest(`Date column “${body.dateColumn}” is not in this dataset.`);
    if (body.targetColumn && !columnNames.includes(body.targetColumn))
      throw badRequest(`Target column “${body.targetColumn}” is not in this dataset.`);

    const kpi = computeKpi({
      columns: columnNames,
      rows: frame.rows,
      measureColumn,
      dateColumn: body.dateColumn,
      grain: body.grain,
      target: typeof body.target === "number" ? body.target : undefined,
      targetColumn: body.targetColumn,
      direction: body.direction,
      onTrackRatio: body.onTrackRatio,
      offTrackRatio: body.offTrackRatio,
    });

    await logActivity(
      ctx,
      "KPI_EVAL",
      `Evaluated KPI ${measureColumn} on “${frame.datasetName}” (status: ${kpi.current.status})`,
      frame.projectId,
      { datasetId: frame.datasetId },
    );
    return ok({ kpi, note: "Attainment and trend computed from actual rows for the selected period grain." });
  } catch (err) {
    return toErrorResponse(err);
  }
}
