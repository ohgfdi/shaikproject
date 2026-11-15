import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireProjectRole } from "@/lib/server/members";
import type { ModelMetrics } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    await requireProjectRole(ctx, project, "VIEWER");

    const url = new URL(request.url);
    const rawLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 50;

    const models = await prisma.modelVersion.findMany({
      where: { projectId: project!.id },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { dataset: { select: { name: true } } },
    });
    return ok({
      models: models.map((m) => {
        const metrics = parseJson<ModelMetrics>(m.metrics, {
          algorithm: "unknown",
          task: m.task as "classification" | "regression" | "clustering",
          trainRows: 0,
          featureCount: 0,
        });
        const headline =
          m.task === "regression"
            ? `R² ${fmtMetric(metrics.r2)}`
            : m.task === "classification"
              ? `Accuracy ${fmtMetric(metrics.accuracy)}`
              : `${metrics.k ?? "—"} clusters`;
        return {
          id: m.id,
          name: m.name,
          task: m.task,
          version: m.version,
          status: m.status,
          datasetName: m.dataset?.name ?? null,
          createdAt: m.createdAt.toISOString(),
          headline,
          // `r2`/`accuracy` are held-out (test-split) metrics; the UI labels them
          // as such and surfaces the train-vs-held-out gap.
          heldOut: m.task !== "clustering",
          generalization: metrics.generalization ?? null,
          demoNote: "Deterministic models trained on your rows with held-out metrics.",
          isReal: true,
        };
      }),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function fmtMetric(v: number | undefined): string {
  return typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—";
}
