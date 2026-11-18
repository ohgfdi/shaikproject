import { ApiError, requireAuth } from "@/lib/auth/guard";
import { notFoundError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { serve, missingInputFeatures } from "@/lib/engine/predictor";
import { logActivity } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { loadServeable } from "@/lib/server/model-serving";
import { moduleEnabledForRequest } from "@/lib/server/modules";
import { enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

/** Prediction requests are cheap but unbounded input; 60/min per user. */
const PREDICT_LIMIT = { limit: 60, windowMs: 60_000 };

/**
 * POST /api/models/:id/predict — model serving.
 *
 * Body: { "features": { "<featureName>": value, ... } }
 *
 * The raw values go through the TRAIN-fitted preprocessor (median impute →
 * one-hot → standardize) and the stored parameters, so the served answer
 * equals what the trained model computes. Session cookies OR a public API
 * key (`models:predict` scope) authenticate; both paths enforce the same
 * role check (VIEWER on the model) and rate limit.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const model = await prisma.modelVersion.findUnique({ where: { id: params.id } });
    if (!model) throw notFoundError("Model not found.");
    await requireRowRole(ctx, model, "VIEWER");
    enforceUserRateLimit(ctx.user.id, "model_predict", PREDICT_LIMIT);

    if (!(await moduleEnabledForRequest("TRAINING_ENABLED"))) {
      // Serving is part of the training surface; respect the same predicate
      // the nav uses so the button and the 503 can never disagree.
      throw new ApiError(503, "TRAINING_DISABLED", "Model serving is disabled (TRAINING_ENABLED=false).");
    }

    const body = (await request.json().catch(() => null)) as { features?: Record<string, unknown> } | null;
    const features = body?.features;
    if (!features || typeof features !== "object" || Array.isArray(features)) {
      throw new ApiError(
        400,
        "VALIDATION",
        'Send { "features": { "<feature>": value, ... } } with every model feature.',
      );
    }

    const model2 = await loadServeable(model.id, model.task);
    // Serving a row that omits a feature the model was trained on returns a
    // confident-looking number built from an imputed value, so the caller has no
    // way to tell a real prediction from a guess. Reject the incomplete row
    // instead — same contract as /explain.
    const missing = missingInputFeatures(model2, features);
    if (missing.length > 0) {
      throw new ApiError(
        400,
        "VALIDATION",
        `Missing feature${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Predict needs every model feature.`,
      );
    }
    const result = serve(model2, features);

    await logActivity(
      ctx,
      "MODEL_TRAINED",
      `Model “${model.name}” v${model.version} served a prediction`,
      model.projectId,
      { modelId: model.id, served: true },
    );

    return Response.json({
      ok: true,
      data: {
        modelId: model.id,
        modelName: model.name,
        version: model.version,
        task: model.task,
        output: result.output,
        probabilities: result.probabilities,
        methodology: result.methodology,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
