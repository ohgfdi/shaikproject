// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - studio chart generation is a deployment-wide aggregate operation
import { z } from "zod";

import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { buildStudioChart } from "@/lib/engine/studio";
import { serverEnv } from "@/lib/env";
import { parseJsonArray } from "@/lib/json";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import type { ColumnDef } from "@/lib/types";

const schema = z
  .object({
    datasetId: z.string().min(1),
    chartKind: z.string().min(1),
    metric: z.string().nullish(),
    metric2: z.string().nullish(),
    dimension: z.string().nullish(),
    date: z.string().nullish(),
    granularity: z.enum(["day", "week", "month", "quarter", "year"]).optional(),
    from: z.string().nullish(),
    to: z.string().nullish(),
    filterCol: z.string().nullish(),
    filterValues: z.array(z.string()).max(200).optional(),
    bins: z.number().int().min(0).max(60).optional(),
  })
  .passthrough();

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const dataset = await prisma.dataset.findUnique({ where: { id: body.datasetId } });
    await requireRowRole(ctx, dataset, "VIEWER");

    const columns = parseJsonArray<ColumnDef>(dataset!.columns, []);
    const loaded = await loadParsedDataset(dataset!.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    // RLS: charts are computed from the caller's visible rows only.
    const rls = await applyRowSecurity(ctx, dataset!, { rows: loaded.rows, columns });
    const rows = rls.rows;
    const totalRows = loaded.totalRows;
    if (rows.length === 0)
      throw new ApiError(
        400,
        "DATA_MISSING",
        "The dataset file is missing on disk. What happened: the parsed data file could not be found. How to fix: re-upload the dataset file to restore it.",
      );

    const out = buildStudioChart({
      datasetId: dataset!.id,
      datasetName: dataset!.name,
      totalRows,
      columns,
      rows,
      datasetWarnings: parseJsonArray<string>(dataset!.qualityWarnings, []),
      chartKind: body.chartKind,
      metric: body.metric,
      metric2: body.metric2,
      dimension: body.dimension,
      date: body.date,
      granularity: body.granularity ?? "month",
      from: body.from,
      to: body.to,
      filterCol: body.filterCol,
      filterValues: body.filterValues,
      bins: body.bins,
    });

    return ok(out);
  } catch (err) {
    return toErrorResponse(err);
  }
}
