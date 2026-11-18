import { promises as fs } from "node:fs";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { notFoundError } from "@/lib/auth/guard";
// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - model explain API is a deployment-wide aggregate operation
import { prisma } from "@/lib/db";
import { explainRow, missingInputFeatures, type ArtifactPayload, type ServeableModel } from "@/lib/engine/predictor";
import { serverEnv } from "@/lib/env";
import { logActivity } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";
import { modelArtifactPath } from "@/lib/server/artifacts";
import { requireRowRole } from "@/lib/server/members";
import { moduleEnabledForRequest } from "@/lib/server/modules";
import { enforceUserRateLimit } from "@/lib/server/rate-limit";
import type { ModelCard } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Shapley sampling costs ~R×B forward passes; 20/min per user keeps it sane. */
const EXPLAIN_LIMIT = { limit: 20, windowMs: 60_000 };
const MAX_BACKGROUND = 64;

/**
 * POST /api/models/:id/explain — per-prediction Shapley attributions.
 *
 * Body:
 *   { "features": {...},                       // the row to explain
 *     "background"?: [...],                    // optional real rows for the expectation
 *     "seed"?: number, "nPermutations"?: number }
 *
 * Without a background the route draws one from the TRAINING dataset (real
 * rows, RLS-filtered, seeded) — expectations over the actual distribution.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const model = await prisma.modelVersion.findUnique({ where: { id: params.id } });
    if (!model) throw notFoundError("Model not found.");
    await requireRowRole(ctx, model, "VIEWER");
    enforceUserRateLimit(ctx.user.id, "model_explain", EXPLAIN_LIMIT);

    if (!(await moduleEnabledForRequest("TRAINING_ENABLED"))) {
      throw new ApiError(503, "TRAINING_DISABLED", "Model explanations are disabled (TRAINING_ENABLED=false).");
    }

    const body = (await request.json().catch(() => null)) as {
      features?: Record<string, unknown>;
      background?: Record<string, unknown>[];
      seed?: number;
      nPermutations?: number;
      backgroundRows?: number;
    } | null;
    const features = body?.features;
    if (!features || typeof features !== "object" || Array.isArray(features)) {
      throw new ApiError(400, "VALIDATION", 'Send { "features": { "<feature>": value, ... } } — the row to explain.');
    }

    const { serveable } = await loadCard(model.id, model.task);
    // Validate against the RAW input columns, not preprocessor.featureNames:
    // the latter are the one-hot EXPANDED names (`region=East`) that a client
    // never sends, so comparing them to the request body rejected every correct
    // request. missingInputFeatures() undoes the expansion for us.
    const missing = missingInputFeatures(serveable, features);
    if (missing.length > 0) {
      throw new ApiError(
        400,
        "VALIDATION",
        `Missing feature${missing.length === 1 ? "" : "s"}: ${missing.join(", ")} — explain needs every model feature.`,
      );
    }

    // Background: caller-supplied real rows, else sampled from the dataset.
    let background = (body?.background ?? []).filter((r) => r && typeof r === "object" && !Array.isArray(r)) as Record<
      string,
      unknown
    >[];
    if (background.length === 0) {
      const { loadParsedDataset } = await import("@/lib/engine/dataset");
      const { applyRowSecurity } = await import("@/lib/server/dataset-access");
      const { datasetColumns } = await import("@/lib/serialize");
      const dataset = await prisma.dataset.findUnique({ where: { id: model.datasetId } });
      if (!dataset) throw notFoundError("The training dataset is missing — provide a background sample.");
      const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
      const rls = await applyRowSecurity(ctx, dataset, { rows: loaded.rows, columns: datasetColumns(dataset) });
      const cols = datasetColumns(dataset);
      const want = Math.min(Math.max(2, body?.backgroundRows ?? 24), MAX_BACKGROUND, rls.rows.length);
      const rand = (seed: number): (() => number) => {
        let a = seed >>> 0;
        return () => {
          a |= 0;
          a = (a + 0x6d2b79f5) | 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      };
      const prng = rand(body?.seed ?? 42);
      const idx: number[] = [];
      for (let i = 0; i < want; i++) idx.push(Math.floor(prng() * rls.rows.length));
      background = idx.map((i) => {
        const row = rls.rows[i] as (string | number | boolean | null)[];
        const obj: Record<string, unknown> = {};
        cols.forEach((c, j) => (obj[c.name] = row[j]));
        return obj;
      });
    }
    if (background.length > MAX_BACKGROUND) background = background.slice(0, MAX_BACKGROUND);

    const { serve: served, explanation } = explainRow(serveable, features, background, {
      seed: body?.seed,
      nPermutations: Math.min(128, Math.max(1, body?.nPermutations ?? 32)),
    });

    await logActivity(
      ctx,
      "MODEL_TRAINED",
      `Model “${model.name}” v${model.version} explained with Shapley attributions`,
      model.projectId,
      { modelId: model.id, explained: true },
    );

    return Response.json({
      ok: true,
      data: {
        modelId: model.id,
        modelName: model.name,
        version: model.version,
        prediction: served.output,
        baseValue: explanation.baseValue,
        contributions: explanation.contributions.map((c) => ({ feature: c.feature, phi: c.phi })),
        reconstructionError: explanation.reconstructionError,
        backgroundRows: background.length,
        methodology: explanation.methodology,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Load the artifact JSON and shape it for the explainer. */
async function loadCard(modelId: string, task: string): Promise<{ serveable: ServeableModel; card: ModelCard }> {
  let card: (ModelCard & { artifactPayload?: ArtifactPayload }) | null = null;
  try {
    const raw = await fs.readFile(modelArtifactPath(modelId), "utf8");
    card = JSON.parse(raw) as ModelCard & { artifactPayload?: ArtifactPayload };
  } catch {
    card = null;
  }
  if (!card) throw notFoundError("The model artifact is missing on disk.");
  return {
    serveable: {
      task,
      algorithm: card.algorithm,
      targetColumn: card.targetColumn ?? null,
      features: card.features,
      weights: card.weights,
      intercept: card.intercept,
      coefficients: card.coefficients,
      centroids: card.centroids,
      classMap: card.classMap,
      artifactPayload: card.artifactPayload,
    },
    card,
  };
}
