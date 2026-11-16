import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - model training is a deployment-wide aggregate operation
import { ApiError, requireAuth } from "@/lib/auth/guard";
import { notFoundError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDatasetSampled } from "@/lib/engine/dataset";
import { advancedModelCard } from "@/lib/engine/ml-card";
import { MlError, type MlAlgorithm, type MlTask } from "@/lib/engine/ml-training";
import { trainModel, TrainingError } from "@/lib/engine/training";
import { runTraining } from "@/lib/engine/training-worker";
import { serverEnv } from "@/lib/env";
import { datasetColumns } from "@/lib/serialize";
import { logActivity, notify } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { modelArtifactPath, ensureDirs } from "@/lib/server/artifacts";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import { moduleEnabled, moduleEnabledForRequest } from "@/lib/server/modules";
import { completeRun, failRun, recordProgress, startRun } from "@/lib/server/training-progress";

export const dynamic = "force-dynamic";

const TASKS = ["classification", "regression", "clustering"] as const;

export async function POST(request: Request) {
  try {
    // moduleEnabled() rather than raw env, so this agrees with the nav (the
    // /models entry is shown from the same predicate). Raw env made the nav
    // and this 503 disagree under LEDGERLY_PROFILE.
    if (!(await moduleEnabledForRequest("TRAINING_ENABLED"))) {
      throw new ApiError(
        503,
        "TRAINING_DISABLED",
        "Model training is disabled. Set TRAINING_ENABLED=true (or LEDGERLY_PROFILE=pro) to run the trainer.",
      );
    }
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      datasetId?: string;
      projectId?: string;
      task?: string;
      name?: string;
      targetColumn?: string | null;
      algorithm?:
        "linear-regression" | "logistic-regression" | "random-forest" | "gradient-boosting" | "k-means" | "mlp";
      testRatio?: number;
      cvFolds?: number;
      hyperparams?: Record<string, number | string | boolean>;
      /** "advanced" opts into the k-fold CV engine (ml-training.ts); default "standard". */
      engine?: "standard" | "advanced";
    }>(request);
    if (!body.datasetId) throw new ApiError(400, "VALIDATION", "Choose the dataset to train on.");
    if (!body.task || !TASKS.includes(body.task as (typeof TASKS)[number])) {
      throw new ApiError(400, "VALIDATION", "Task must be one of: classification, regression, clustering.");
    }
    if ((body.task === "classification" || body.task === "regression") && !body.targetColumn) {
      throw new ApiError(400, "VALIDATION", `Choose a target column for ${body.task}.`);
    }

    const dataset = await prisma.dataset.findUnique({ where: { id: body.datasetId } });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "EDITOR");

    // UNBIASED training sample: a seeded reservoir over ALL rows on disk —
    // never a head slice, so capped files train on representative data.
    const {
      rows: sampledRows,
      totalRows,
      sampled,
    } = await loadParsedDatasetSampled(
      dataset.id,
      serverEnv().DATASET_ANALYSIS_LIMIT,
      typeof body.hyperparams?.seed === "number" ? body.hyperparams.seed : 42,
    );
    const loaded = { rows: sampledRows, totalRows };
    // RLS: a model must never be fitted on rows its future viewers may not see,
    // otherwise a restricted user's predictions memorise hidden data.
    const rls = await applyRowSecurity(ctx, dataset, {
      rows: loaded.rows,
      columns: datasetColumns(dataset),
    });

    // ---- Advanced engine (opt-in): k-fold CV + permutation importance -----
    // Same dataset, same RLS, same registry — a different, strictly stronger
    // validation protocol. Binary targets map to binary-classification; 3+
    // classes map to multiclass-classification (softmax / OvR path).
    if (body.engine === "advanced" && body.task !== "clustering") {
      // Target cardinality decides binary vs multiclass (only for classification).
      let mlTask: MlTask = body.task === "regression" ? "regression" : "binary-classification";
      if (body.task === "classification") {
        const tIdx = datasetColumns(dataset).findIndex((c) => c.name === body.targetColumn);
        if (tIdx >= 0) {
          const labels = new Set(
            rls.rows
              .map((r) => r[tIdx] as string | number | boolean | null)
              .filter((v) => v !== null && v !== undefined && v !== "")
              .map(String),
          );
          if (labels.size > 2) mlTask = "multiclass-classification";
        }
      }
      const ALG_MAP: Record<string, MlAlgorithm> = {
        "linear-regression": "ridge",
        "logistic-regression": "logistic",
        "random-forest": "random-forest",
        "gradient-boosting": "gradient-boosting",
        mlp: "mlp",
      };
      const alg = ALG_MAP[body.algorithm ?? ""] ?? (mlTask === "regression" ? "ridge" : "logistic");
      if (mlTask === "multiclass-classification" && alg === "ridge") {
        return toErrorResponse(
          new ApiError(
            400,
            "TRAINING_INPUT",
            "Ridge cannot fit a multiclass target — choose logistic, random-forest or gradient-boosting.",
          ),
        );
      }
      const hp = body.hyperparams ?? {};
      const num = (k: string): number | undefined => {
        const v = hp[k];
        return typeof v === "number" && Number.isFinite(v) ? v : undefined;
      };
      try {
        // Thread offload: the fit runs in a worker (inline fallback when
        // workers are unavailable). Progress streams to the SSE route under
        // the caller-supplied runId; the RESULT still returns on this POST.
        const runId = typeof body.hyperparams?.runId === "string" ? body.hyperparams.runId : "";
        const onProgress = (p: { phase: "cv" | "refit" | "importance"; done: number; total: number }): void => {
          if (runId) recordProgress(runId, p);
        };
        if (runId) startRun(runId);
        const trainRequest = {
          task: mlTask,
          algorithm: alg,
          targetColumn: body.targetColumn ?? "",
          cvFolds: body.cvFolds,
          lambda: num("lambda"),
          maxDepth: num("maxDepth") ?? num("estimators"),
          minLeaf: num("minLeaf"),
          nTrees: num("nTrees"),
          k: num("k"),
          hiddenUnits: num("hiddenUnits"),
          epochs: num("epochs"),
          weightDecay: num("weightDecay"),
          batchSize: num("batchSize"),
          subsample: num("subsample"),
          seed: num("seed"),
        };
        let result;
        try {
          result = await runTraining({
            source: { columns: datasetColumns(dataset), rows: rls.rows },
            request: trainRequest,
            onProgress,
          });
          if (runId) completeRun(runId);
        } catch (trainErr) {
          if (runId) failRun(runId, trainErr instanceof Error ? trainErr.message : String(trainErr));
          throw trainErr;
        }
        const card = advancedModelCard(result, (body.name ?? "").trim() || `${dataset.name} · ${body.task} (CV)`);
        if (sampled) {
          // Honest labelling: training on a sample must say so.
          card.demoNote += ` Trained on a seeded uniform sample of ${rls.rows.length.toLocaleString()} of ${totalRows.toLocaleString()} rows on disk (reservoir sampling — representative, not head-biased).`;
          card.params.trainingSample = `${rls.rows.length}/${totalRows}`;
        }

        const id = randomUUID();
        await ensureDirs();
        // The card carries the registry/UI shape; the raw aerolexa.ml.v1
        // payload rides along as `artifactPayload` so /predict and /explain
        // can reconstruct the EXACT model (preprocessor + parameters).
        await fs.writeFile(
          modelArtifactPath(id),
          JSON.stringify({ ...card, artifactPayload: result.artifact }, null, 2),
          "utf8",
        );
        const previous = await prisma.modelVersion.count({ where: { datasetId: dataset.id } });
        const model = await prisma.modelVersion.create({
          data: {
            id,
            workspaceId: dataset.workspaceId,
            projectId: dataset.projectId,
            datasetId: dataset.id,
            name: card.name,
            task: card.task,
            targetColumn: card.targetColumn ?? null,
            features: JSON.stringify(card.features),
            metrics: JSON.stringify(card.metrics),
            params: JSON.stringify(card.params),
            version: previous + 1,
            status: "READY",
            artifactPath: id,
            createdById: ctx.user.id,
          },
        });
        await logActivity(
          ctx,
          "MODEL_TRAINED",
          `Model “${model.name}” trained with the k-fold CV engine (${card.task}${result.classes ? `, ${result.classes.length} classes` : ""}) on “${dataset.name}” — v${model.version}`,
          dataset.projectId,
          { modelId: model.id, datasetId: dataset.id, algorithm: card.algorithm, engine: "advanced" },
        );
        await notify(ctx.user.id, {
          type: "analysis",
          title: "Model training finished (k-fold CV engine)",
          message: `“${model.name}” v${model.version} is ready — out-of-fold ${card.metrics.cvMetric} ${card.metrics.cvMean} ± ${card.metrics.cvSd}.`,
        });
        return ok({
          model: {
            id: model.id,
            name: model.name,
            task: model.task,
            version: model.version,
            metrics: card.metrics,
            demoNote: card.demoNote,
            engine: "advanced",
            cv: {
              metricName: result.cv.metricName,
              mean: result.cv.mean,
              sd: result.cv.sd,
              perFold: result.cv.perFold,
            },
            importance: result.importance,
            methodology: result.methodology,
          },
        });
      } catch (err) {
        if (err instanceof MlError) {
          return toErrorResponse(new ApiError(400, "TRAINING_INPUT", err.message));
        }
        return toErrorResponse(err);
      }
    }

    if (body.algorithm === "mlp") {
      // Honest routing: the neural network only exists in the advanced CV
      // engine; the hold-out prototype trainer must not silently substitute
      // a different algorithm.
      throw new ApiError(
        400,
        "TRAINING_INPUT",
        "The neural network (MLP) runs on the advanced k-fold CV engine — switch the validation engine to Advanced.",
      );
    }

    const card = trainModel(
      { columns: datasetColumns(dataset), rows: rls.rows },
      {
        task: body.task as "classification" | "regression" | "clustering",
        name: (body.name ?? "").trim() || `${dataset.name} · ${body.task}`,
        targetColumn: body.targetColumn ?? null,
        algorithm: body.algorithm,
        testRatio: body.testRatio,
        cvFolds: body.cvFolds,
        hyperparams: body.hyperparams,
      },
    );

    const id = randomUUID();
    await ensureDirs();
    await fs.writeFile(modelArtifactPath(id), JSON.stringify(card, null, 2), "utf8");

    const previous = await prisma.modelVersion.count({ where: { datasetId: dataset.id } });
    const model = await prisma.modelVersion.create({
      data: {
        id,
        workspaceId: dataset.workspaceId,
        projectId: dataset.projectId,
        datasetId: dataset.id,
        name: card.name,
        task: card.task,
        targetColumn: card.targetColumn ?? null,
        features: JSON.stringify(card.features),
        metrics: JSON.stringify(card.metrics),
        params: JSON.stringify(card.params),
        version: previous + 1,
        status: "READY",
        artifactPath: id,
        createdById: ctx.user.id,
      },
    });

    await logActivity(
      ctx,
      "MODEL_TRAINED",
      `Model “${model.name}” trained (${card.task}) on “${dataset.name}” — v${model.version}`,
      dataset.projectId,
      { modelId: model.id, datasetId: dataset.id, algorithm: card.metrics.algorithm },
    );
    await notify(ctx.user.id, {
      type: "analysis",
      title: "Model training finished",
      message: `“${model.name}” v${model.version} is ready (${card.task}).`,
    });

    return ok({
      model: {
        id: model.id,
        name: model.name,
        task: model.task,
        version: model.version,
        metrics: card.metrics,
        demoNote: card.demoNote,
      },
    });
  } catch (err) {
    if (err instanceof TrainingError) {
      return toErrorResponse(new ApiError(400, "TRAINING_INPUT", err.message));
    }
    return toErrorResponse(err);
  }
}
