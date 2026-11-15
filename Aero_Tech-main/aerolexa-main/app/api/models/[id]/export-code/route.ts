import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { modelPythonScript } from "@/lib/engine/code-export";
import { parseJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import type { ModelCard } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/models/:id/export-code — runnable sklearn script for a model card. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const model = await prisma.modelVersion.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, model, "VIEWER");
    const card = parseJson<ModelCard | null>(
      JSON.stringify({
        task: model!.task,
        algorithm: model!.name.toLowerCase().includes("logistic")
          ? "logistic-regression"
          : model!.name.toLowerCase().includes("forest")
            ? "random-forest"
            : model!.name.toLowerCase().includes("boost")
              ? "gradient-boosting"
              : model!.name.toLowerCase().includes("k-means") || model!.task === "clustering"
                ? "k-means"
                : "linear-regression",
        name: model!.name,
        targetColumn: model!.targetColumn,
        features: parseJson<string[]>(model!.features, []),
        params: parseJson<Record<string, number | string | boolean>>(model!.params, {}),
        metrics: parseJson<Record<string, number>>(model!.metrics, {}),
        versionTag: `v${model!.version}`,
        featureImportance:
          parseJson<{ featureImportance?: { feature: string; importance: number; method: string }[] }>(
            model!.metrics,
            {},
          ).featureImportance ?? [],
      }),
      null,
    );
    if (!card) {
      return NextResponse.json(
        { ok: false, error: { code: "INTERNAL", message: "The model card could not be assembled." } },
        { status: 500 },
      );
    }
    await logActivity(
      ctx,
      "MODEL_EXPORTED",
      `Exported runnable Python script for model “${model!.name}” v${model!.version}`,
      model!.projectId,
      { modelId: model!.id },
    );
    const script = modelPythonScript(card);
    return new NextResponse(script, {
      headers: {
        "Content-Type": "text/x-python; charset=utf-8",
        "Content-Disposition": `attachment; filename="model-${model!.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v${model!.version}.py"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
