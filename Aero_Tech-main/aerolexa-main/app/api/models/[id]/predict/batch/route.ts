import { ApiError, requireAuth } from "@/lib/auth/guard";
import { notFoundError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { serve, missingInputFeatures } from "@/lib/engine/predictor";
import { logActivity } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { loadServeable } from "@/lib/server/model-serving";
import { moduleEnabled, moduleEnabledForRequest } from "@/lib/server/modules";
import { enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

/** Batch scoring is heavier than single-row serving — tighter budget. */
const BATCH_LIMIT = { limit: 10, windowMs: 60_000 };
/** 1000 rows × ~5 predictions/s ⇒ interactive, not a free batch server. */
const MAX_ROWS = 1000;

/**
 * POST /api/models/:id/predict/batch — batch model scoring.
 *
 * Body: { "rows": [ { "<featureName>": value, ... }, ... ] } (≤ 1000 rows)
 *
 * One rate limit + one artifact load, then every row runs the SAME serving
 * path the single-row endpoint uses (train-fitted preprocessor → forward
 * pass → task head), so a batch answer is byte-identical to serving the row
 * individually. Incomplete rows are rejected with their INDEX named — a
 * silently imputed batch row is a confident guess the caller can't detect.
 *
 * Response rows are aligned 1:1 with the request order:
 * { "results": [ { ok, output?, probabilities?, error? }, ... ] }
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const model = await prisma.modelVersion.findUnique({ where: { id: params.id } });
    if (!model) throw notFoundError("Model not found.");
    await requireRowRole(ctx, model, "VIEWER");
    enforceUserRateLimit(ctx.user.id, "model_predict_batch", BATCH_LIMIT);

    if (!(await moduleEnabledForRequest("TRAINING_ENABLED"))) {
      throw new ApiError(503, "TRAINING_DISABLED", "Model serving is disabled (TRAINING_ENABLED=false).");
    }

    const body = (await request.json().catch(() => null)) as { rows?: unknown } | null;
    const rows = body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new ApiError(400, "VALIDATION", 'Send { "rows": [ { ...feature row }, ... ] } with at least one row.');
    }
    if (rows.length > MAX_ROWS) {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", `Batch scoring is capped at ${MAX_ROWS} rows per call.`);
    }
    if (rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) {
      throw new ApiError(400, "VALIDATION", "Every batch row must be a feature object.");
    }

    const model2 = await loadServeable(model.id, model.task);

    const results = rows.map((raw, i) => {
      try {
        const row = raw as Record<string, unknown>;
        const missing = missingInputFeatures(model2, row);
        if (missing.length > 0) {
          return {
            ok: false as const,
            index: i,
            error: `Missing feature${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
          };
        }
        const served = serve(model2, row);
        return {
          ok: true as const,
          index: i,
          output: served.output,
          ...(served.probabilities ? { probabilities: served.probabilities } : {}),
          ...(served.interval ? { interval: served.interval } : {}),
        };
      } catch (err) {
        return {
          ok: false as const,
          index: i,
          error: err instanceof Error ? err.message : "Serving failed for this row.",
        };
      }
    });

    await logActivity(
      ctx,
      "MODEL_TRAINED",
      `Model “${model.name}” v${model.version} batch-scored ${rows.length} row(s)`,
      model.projectId,
      { modelId: model.id, served: true, batch: rows.length },
    );

    return Response.json({
      ok: true,
      data: {
        modelId: model.id,
        modelName: model.name,
        version: model.version,
        task: model.task,
        count: results.length,
        served: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
