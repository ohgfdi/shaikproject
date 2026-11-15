/**
 * Shared model-serving loader. Both the single-row and batch prediction
 * routes reconstruct the ServeableModel the same way: artifact JSON from
 * disk → ModelCard + aerolexa.ml.v1 payload. One loader, one contract —
 * the two endpoints can never disagree about what serving accepts.
 */
import { promises as fs } from "node:fs";

import { notFoundError } from "@/lib/auth/guard";
import type { ArtifactPayload, ServeableModel } from "@/lib/engine/predictor";
import { modelArtifactPath } from "@/lib/server/artifacts";
import type { ModelCard } from "@/lib/types";

/** Load the artifact JSON from disk and shape it for the predictor. */
export async function loadServeable(modelId: string, task: string): Promise<ServeableModel> {
  let card: (ModelCard & { artifactPayload?: ArtifactPayload }) | null = null;
  try {
    const raw = await fs.readFile(modelArtifactPath(modelId), "utf8");
    card = JSON.parse(raw) as ModelCard & { artifactPayload?: ArtifactPayload };
  } catch {
    card = null;
  }
  if (!card) throw notFoundError("The model artifact is missing on disk.");
  return {
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
  };
}
