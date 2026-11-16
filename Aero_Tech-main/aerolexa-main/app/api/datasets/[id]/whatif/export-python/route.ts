// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - what-if Python export is a deployment-wide aggregate operation
import { requireAuth } from "@/lib/auth/guard";
import { notFoundError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { runWhatIf, WhatIfError, type WhatIfInput } from "@/lib/engine/whatif";
import { serverEnv } from "@/lib/env";
import { exportWhatIfScript } from "@/lib/export/python";
import { datasetColumns } from "@/lib/serialize";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";
import type { ColumnDef } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Returns a standalone Python script reproducing the what-if computation. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("WHATIF_ENABLED");
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");

    const body = await readJsonBody<WhatIfInput>(request);
    if (typeof body.pctChange !== "number") throw new WhatIfError("Choose a percentage change to simulate.");
    const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    const columns: ColumnDef[] = datasetColumns(dataset);
    const rls = await applyRowSecurity(ctx, dataset, { rows: loaded.rows, columns });
    const result = runWhatIf(
      { columns, rows: rls.rows },
      { driverColumn: body.driverColumn ?? "", outcomeColumn: body.outcomeColumn ?? "", pctChange: body.pctChange },
    );

    // The exported script embeds the same RLS-filtered rows the projection used.
    const script = exportWhatIfScript(result, dataset.name, columns, rls.rows);

    return ok({ script });
  } catch (err) {
    return toErrorResponse(err);
  }
}
