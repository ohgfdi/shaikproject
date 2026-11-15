import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";

import { notFoundError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { exportModelScript } from "@/lib/export/python";
import { datasetColumns } from "@/lib/serialize";
import { logActivity } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";
import { modelArtifactPath } from "@/lib/server/artifacts";
import { requireRowRole } from "@/lib/server/members";
import type { ColumnDef, ModelCard } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Download a standalone Python script that reproduces this model's training. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const model = await prisma.modelVersion.findUnique({ where: { id: params.id } });
    if (!model) throw notFoundError("Model not found.");
    await requireRowRole(ctx, model, "VIEWER");

    let card: ModelCard;
    try {
      const raw = await fs.readFile(modelArtifactPath(model.id), "utf8");
      card = JSON.parse(raw) as ModelCard;
    } catch {
      throw notFoundError("The model artifact is missing on disk.");
    }

    const dataset = await prisma.dataset.findUnique({ where: { id: model.datasetId } });
    if (!dataset) throw notFoundError("The training dataset is missing.");
    const columns: ColumnDef[] = datasetColumns(dataset);
    const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);

    const script = exportModelScript(card, columns, loaded.rows);

    await logActivity(
      ctx,
      "MODEL_TRAINED",
      `Exported runnable Python for model “${model.name}” v${model.version}`,
      model.projectId,
      { modelId: model.id, version: model.version },
    );

    const safeName = model.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, "-")
      .slice(0, 60);
    return new NextResponse(script, {
      headers: {
        "Content-Type": "text/x-python; charset=utf-8",
        "Content-Disposition": `attachment; filename="model-${safeName}-v${model.version}.py"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
