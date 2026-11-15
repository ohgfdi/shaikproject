import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { notFoundError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { whatIfPythonScript } from "@/lib/engine/code-export";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { runWhatIf, WhatIfError } from "@/lib/engine/whatif";
import { serverEnv } from "@/lib/env";
import { datasetColumns } from "@/lib/serialize";
import { logActivity } from "@/lib/server/activity";
import { readJsonBody, toErrorResponse } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  driverColumn: z.string().min(1),
  outcomeColumn: z.string().min(1),
  pctChange: z.number(),
});

/**
 * POST /api/datasets/:id/whatif/export — recompute the projection server-side
 * and return a standalone Python script that reproduces it.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("WHATIF_ENABLED");
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");
    const input = bodySchema.parse(await readJsonBody(request));
    const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    const columns = datasetColumns(dataset);
    const rls = await applyRowSecurity(ctx, dataset, { rows: loaded.rows, columns });
    const result = runWhatIf({ columns, rows: rls.rows }, input);
    await logActivity(
      ctx,
      "WHATIF_EXPORTED",
      `Exported runnable Python script for what-if (${result.pctChange > 0 ? "+" : ""}${result.pctChange}% ${result.driverColumn} → ${result.outcomeColumn})`,
      dataset.projectId,
      { datasetId: dataset.id },
    );
    const script = whatIfPythonScript(result, dataset.name);
    return new NextResponse(script, {
      headers: {
        "Content-Type": "text/x-python; charset=utf-8",
        "Content-Disposition": `attachment; filename="whatif-${dataset.id.slice(-8)}.py"`,
      },
    });
  } catch (err) {
    if (err instanceof WhatIfError) return toErrorResponse(err);
    return toErrorResponse(err);
  }
}
