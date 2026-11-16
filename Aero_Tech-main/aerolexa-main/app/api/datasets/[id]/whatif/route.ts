// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - what-if simulation is a deployment-wide aggregate operation
import { requireAuth } from "@/lib/auth/guard";
import { notFoundError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { runWhatIf, WhatIfError } from "@/lib/engine/whatif";
import { serverEnv } from "@/lib/env";
import { datasetColumns } from "@/lib/serialize";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";

export const dynamic = "force-dynamic";

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // The What-if sub-nav tab and the published aiWhatIf scene both depend on
    // this endpoint, so a frozen profile must refuse the simulation itself.
    requireModule("WHATIF_ENABLED");
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");

    const body = await readJsonBody<{
      driverColumn?: string;
      outcomeColumn?: string;
      pctChange?: number;
      controlColumns?: unknown;
      treatmentColumn?: unknown;
    }>(request);
    if (typeof body.pctChange !== "number") throw new WhatIfError("Choose a percentage change to simulate.");
    // Controls arrive as a JSON array of column names; anything else is a 400,
    // not a silently ignored field.
    const controlColumns = Array.isArray(body.controlColumns)
      ? body.controlColumns.filter((c): c is string => typeof c === "string")
      : body.controlColumns === undefined
        ? undefined
        : undefined;
    if (body.controlColumns !== undefined && !Array.isArray(body.controlColumns)) {
      throw new WhatIfError("controlColumns must be an array of column names.");
    }
    const treatmentColumn =
      body.treatmentColumn === undefined || body.treatmentColumn === null || body.treatmentColumn === ""
        ? undefined
        : typeof body.treatmentColumn === "string"
          ? body.treatmentColumn
          : undefined;
    if (
      body.treatmentColumn !== undefined &&
      body.treatmentColumn !== null &&
      body.treatmentColumn !== "" &&
      typeof body.treatmentColumn !== "string"
    ) {
      throw new WhatIfError("treatmentColumn must be a column name.");
    }
    const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    const columns = datasetColumns(dataset);
    // RLS: the simulation is only as private as its input rows.
    const rls = await applyRowSecurity(ctx, dataset, { rows: loaded.rows, columns });
    const result = runWhatIf(
      { columns, rows: rls.rows },
      {
        driverColumn: body.driverColumn ?? "",
        outcomeColumn: body.outcomeColumn ?? "",
        pctChange: body.pctChange,
        controlColumns,
        treatmentColumn,
      },
    );

    await logActivity(
      ctx,
      "WHATIF_RUN",
      `What-if: ${result.pctChange > 0 ? "+" : ""}${result.pctChange}% on ${result.driverColumn} → ${result.outcomeColumn} (“${dataset.name}”)`,
      dataset.projectId,
      { datasetId: dataset.id, fallback: result.fallback },
    );

    return ok({
      result,
      dataset: {
        id: dataset.id,
        name: dataset.name,
        rowsScanned: loaded.rows.length,
        totalRows: loaded.totalRows,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
