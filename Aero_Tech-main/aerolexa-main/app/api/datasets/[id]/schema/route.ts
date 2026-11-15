/**
 * Dataset schema browser API.
 *
 * Returns the full schema of a dataset including column names, types, and
 * profiling stats. This powers the schema browser panel in the SQL Lab and
 * notebook — equivalent to Hex's schema browser feature.
 */

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJsonArray } from "@/lib/json";
import { datasetColumns } from "@/lib/serialize";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import type { ColumnDef, ColumnStat } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");

    const columns: ColumnDef[] = datasetColumns(dataset);
    const profile = parseJsonArray<ColumnStat>(dataset.profile, []);
    const stats: Record<string, ColumnStat> = {};
    for (const s of profile) {
      if (s && typeof s === "object") stats[s.name] = s;
    }

    // Compute column details with profiling data
    const columnDetails = columns.map((col) => {
      const colStat = stats[col.name];
      return {
        name: col.name,
        type: col.type,
        nullable: colStat ? colStat.missing > 0 : false,
        distinct: colStat?.distinct ?? -1,
        missing: colStat?.missing ?? 0,
        // Numeric stats
        min: colStat?.min,
        max: colStat?.max,
        mean: colStat?.mean,
        median: colStat?.median,
        q1: colStat?.q1,
        q3: colStat?.q3,
        stddev: colStat?.stddev,
        // Categorical stats
        topValues: colStat?.topValues,
        nearConstant: colStat?.nearConstant ?? false,
        // Date stats
        minDate: colStat?.minDate,
        maxDate: colStat?.maxDate,
        // Outlier info
        outlierCount: colStat?.outlierCount,
      };
    });

    return ok({
      schema: {
        datasetId: dataset.id,
        datasetName: dataset.name,
        isDemo: dataset.isDemo,
        rowCount: dataset.rowCount,
        columnCount: columns.length,
        columns: columnDetails,
        qualityWarnings: parseJsonArray<string>(dataset.qualityWarnings, []),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
