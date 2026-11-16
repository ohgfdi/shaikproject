import { z } from "zod";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";

/**
 * tenancy-audit: global-operator — dataset analyses API runs analyses
 * against workspace datasets. This is a deployment-wide aggregate rather than a
 * per-tenant query.
 */
import { prisma } from "@/lib/db";
import { runAnalysis } from "@/lib/engine/analyses";
import { loadParsedDataset, ndjsonPath } from "@/lib/engine/dataset";
import { insightsFromAnalysis } from "@/lib/engine/insights";
import { serverEnv } from "@/lib/env";
import { parseJsonArray, stringifyJson } from "@/lib/json";
import { logActivity, notify } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { createAnalysisVersion, datasetRowsAtVersion } from "@/lib/server/versioning";
import type { AnalysisConfig, ColumnDef } from "@/lib/types";

const configSchema = z
  .object({
    kind: z.enum([
      "eda",
      "trend",
      "kpi",
      "correlation",
      "distribution",
      "forecast",
      "variance",
      "segmentation",
      "cohort",
      "funnel",
      // Advanced statistical kinds — see lib/types.ts AnalysisKind.
      // CA financial-statement and tax engines are supported too; the runner
      // dispatches them to lib/engine/ca-financial-analysis.ts.
      "regression",
      "abtest",
      "automl",
      "arimax",
      "dataquality",
      "accounting",
      "syntheticcontrol",
      "uplift",
      "sprt",
      "drift",
      "compliance",
      // Newly wired kinds.
      "whatif",
      "did",
      "survival",
      "bayesian",
      "sarima",
      "distributed",
      "streaming",
      "deep-learning",
      "nlp",
      "feature-store",
      "real-time-serving",
      "hte",
      "iv-calculus",
      "geospatial",
    ]),
    title: z.string().max(200).optional(),
    // Analysis-specific parameters (validated semantically by the engine)
    config: z
      .object({
        dateCol: z.string().nullish(),
        metric: z.string().nullish(),
        dimensionCol: z.string().nullish(),
        filterCol: z.string().nullish(),
        filterValue: z.string().nullish(),
        granularity: z.enum(["day", "week", "month", "quarter", "year"]).optional(),
        columns: z.array(z.string()).max(30).optional(),
        column: z.string().nullish(),
        bins: z.number().int().min(0).max(60).optional(),
        horizon: z.number().int().min(1).max(12).optional(),
        k: z.number().int().min(2).max(6).optional(),
        entityCol: z.string().nullish(),
        stageCol: z.string().nullish(),
        stages: z.array(z.string()).max(50).optional(),
        // Advanced-kind parameters. Bounds are deliberately generous: the
        // engine re-validates semantically and raises a specific
        // AnalysisInputError, which produces a better message than a zod
        // rejection naming a raw field.
        groupCol: z.string().nullish(),
        valueCol: z.string().nullish(),
        successesCol: z.string().nullish(),
        trialsCol: z.string().nullish(),
        armCol: z.string().nullish(),
        targetColumn: z.string().nullish(),
        featureColumns: z.array(z.string()).max(30).optional(),
        regressors: z.array(z.string()).max(10).optional(),
        task: z.enum(["regression", "binary-classification", "multiclass-classification"]).optional(),
        test: z.enum(["welch", "student", "mann-whitney"]).optional(),
        level: z.union([z.literal(0.8), z.literal(0.95)]).optional(),
        alpha: z.number().gt(0).lt(1).optional(),
        power: z.number().gt(0).lt(1).optional(),
        adjust: z.boolean().optional(),
        cvFolds: z.number().int().min(2).max(10).optional(),
        maxCandidates: z.number().int().min(2).max(60).optional(),
        // dataquality
        requiredCol: z.string().nullish(),
        uniqueCol: z.string().nullish(),
        inSetCol: z.string().nullish(),
        allowedValues: z.array(z.string()).max(200).optional(),
        rangeCol: z.string().nullish(),
        min: z.number().nullish(),
        max: z.number().nullish(),
        severity: z.enum(["error", "warn"]).optional(),
        // accounting
        accountCol: z.string().nullish(),
        debitCol: z.string().nullish(),
        creditCol: z.string().nullish(),
        narrationCol: z.string().nullish(),
        referenceCol: z.string().nullish(),
        from: z.string().nullish(),
        to: z.string().nullish(),
        // syntheticcontrol
        unitCol: z.string().nullish(),
        treatedValue: z.string().nullish(),
        prePeriods: z.number().int().min(2).max(120).optional(),
        maxIter: z.number().int().min(50).max(5000).optional(),
        // uplift
        features: z.array(z.string()).max(30).optional(),
        treatmentCol: z.string().nullish(),
        outcomeCol: z.string().nullish(),
        folds: z.number().int().min(2).max(10).optional(),
        // sprt
        mdeRelative: z.number().gt(0).lt(1).optional(),
        beta: z.number().gt(0).lt(1).optional(),
        // drift
        referenceSplit: z.number().gt(0).lt(1).optional(),
        // compliance
        period: z.string().max(20).optional(),
        kindCol: z.string().nullish(),
        rateCol: z.string().nullish(),
        taxableCol: z.string().nullish(),
        reverseChargeCol: z.string().nullish(),
        sectionCol: z.string().nullish(),
        panCol: z.string().nullish(),
        gstinCol: z.string().nullish(),
        openingCredit: z.number().optional(),
        auditSampleSize: z.number().int().min(0).max(10000).optional(),
        // whatif / did / survival / bayesian / sarima
        driverColumn: z.string().nullish(),
        outcomeColumn: z.string().nullish(),
        pctChange: z.number().nullish(),
        controlColumns: z.array(z.string()).max(20).optional(),
        periodCol: z.string().nullish(),
        postValue: z.string().nullish(),
        interventionDate: z.string().nullish(),
        timeCol: z.string().nullish(),
        eventCol: z.string().nullish(),
        covariates: z.array(z.string()).max(20).optional(),
        target: z.string().nullish(),
        model: z.enum(["regression", "gp"]).optional(),
        credibleLevel: z.number().gt(0.5).lt(1).optional(),
        priorSD: z.number().gt(0).optional(),
        mcmcSamples: z.number().int().min(0).max(20000).optional(),
        lengthScale: z.number().gt(0).optional(),
        noiseSD: z.number().gt(0).optional(),
        seasonalPeriods: z.number().int().min(0).max(24).optional(),
        maxOrder: z.number().int().min(0).max(3).optional(),
        maxSeasonalOrder: z.number().int().min(0).max(2).optional(),
        // distributed / streaming / deep-learning / nlp / feature-store
        op: z.string().nullish(),
        workers: z.number().int().min(1).max(64).optional(),
        saltingFactor: z.number().int().min(0).max(16).optional(),
        window: z.string().nullish(),
        windowSize: z.number().int().min(1).max(1000).optional(),
        slide: z.number().int().min(1).max(1000).optional(),
        allowedLateness: z.number().int().min(0).max(1000).optional(),
        watermark: z.string().nullish(),
        architecture: z.enum(["xgboost", "mlp"]).optional(),
        hidden: z.number().int().min(1).max(512).optional(),
        epochs: z.number().int().min(1).max(2000).optional(),
        learningRate: z.number().gt(0).optional(),
        batchSize: z.number().int().min(1).max(4096).optional(),
        depth: z.number().int().min(1).max(16).optional(),
        patience: z.number().int().min(1).max(100).optional(),
        device: z.enum(["auto", "cpu", "gpu"]).optional(),
        textCol: z.string().nullish(),
        numTopics: z.number().int().min(2).max(30).optional(),
        topK: z.number().int().min(1).max(50).optional(),
        minDf: z.number().int().min(1).max(50).optional(),
        sampleSize: z.number().int().min(2).max(5000).optional(),
        labelCol: z.string().nullish(),
        featureCols: z.array(z.string()).max(30).optional(),
        eventTimeCol: z.string().nullish(),
        maxFeatureAgeDays: z.number().min(0).optional(),
        onlineSnapshotVersion: z.number().optional(),
        targetKind: z.enum(["binary", "regression"]).optional(),
        cacheSize: z.number().int().min(16).max(10000).optional(),
        canaryShare: z.number().min(0).max(1).optional(),
        shadow: z.boolean().optional(),
        slaMs: z.number().int().min(1).max(10000).optional(),
        learner: z.string().nullish(),
        regularization: z.number().min(0).optional(),
        minLeaf: z.number().int().min(2).max(1000).optional(),
        quantileSegments: z.number().int().min(2).max(20).optional(),
        instrumentCols: z.array(z.string()).max(10).optional(),
        controlCols: z.array(z.string()).max(20).optional(),
        estimator: z.enum(["2sls", "liml"]).optional(),
        latCol: z.string().nullish(),
        lonCol: z.string().nullish(),
        regionCol: z.string().nullish(),
        weightCol: z.string().nullish(),
        bandKm: z.number().gt(0).optional(),
        permutations: z.number().int().min(0).max(9999).optional(),
      })
      .passthrough(),
    // Phase 1.5: re-run this analysis pinned to a specific dataset version
    // ("latest" when omitted) and record it as a new AnalysisVersion.
    datasetVersionId: z.string().optional(),
    analysisId: z.string().optional(), // re-run an existing analysis → new version of it
  })
  .passthrough();

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = configSchema.parse(await readJsonBody(request));
    const dataset = await withTenantDb(ctx, (db) =>
    db.dataset.findUnique({ where: { id: params.id } }),
  );
    await requireRowRole(ctx, dataset, "EDITOR");
    if (dataset!.status !== "READY")
      throw new ApiError(
        400,
        "DATASET_NOT_READY",
        "This dataset is not ready for analysis yet. What happened: the dataset is still processing or has failed to parse. How to fix: wait for the dataset to finish processing, or re-upload the file if it failed.",
      );

    const columns = parseJsonArray<ColumnDef>(dataset!.columns, []);
    const limit = serverEnv().DATASET_ANALYSIS_LIMIT;

    // Phase 1.5: when re-running against a pinned dataset version, load the
    // version's immutable snapshot instead of the live rows.
    const pinnedVersion = body.datasetVersionId
      ? await prisma.datasetVersion.findFirst({
          where: { id: body.datasetVersionId, datasetId: dataset!.id, workspaceId: ctx.workspace.id },
        })
      : null;
    if (body.datasetVersionId && !pinnedVersion) {
      throw new ApiError(
        400,
        "VERSION_MISMATCH",
        "The chosen dataset version does not belong to this dataset. What happened: the version ID refers to a different dataset. How to fix: select a version from this dataset's version history.",
      );
    }
    const { rows, totalRows } = pinnedVersion
      ? await datasetRowsAtVersion(dataset!.id, pinnedVersion.id, limit)
      : await loadParsedDataset(dataset!.id, limit);
    if (rows.length === 0)
      throw new ApiError(
        400,
        "DATA_MISSING",
        "The dataset file is missing on disk. What happened: the parsed data file could not be found. How to fix: re-upload the dataset file to restore it.",
      );

    const cfg = { ...(body.config ?? {}), kind: body.kind } as AnalysisConfig;
    const result = runAnalysis(
      {
        datasetId: dataset!.id,
        datasetName: dataset!.name,
        totalRows,
        columns,
        rows,
        datasetWarnings: parseJsonArray<string>(dataset!.qualityWarnings, []),
      },
      cfg,
    );
    if (body.title) result.title = body.title;

    // Phase 1.5: re-running an existing analysis records a new version of it
    // (the live row keeps its current result); first runs create version 1.
    const existingAnalysis = body.analysisId
      ? await prisma.analysis.findFirst({
          where: { id: body.analysisId, datasetId: dataset!.id, workspaceId: ctx.workspace.id },
        })
      : null;
    if (body.analysisId && !existingAnalysis) {
      throw new ApiError(404, "NOT_FOUND", "The analysis to re-run was not found on this dataset.");
    }

    const analysis = existingAnalysis
      ? await withTenantDb(ctx, (db) =>
          db.analysis.update({
            where: { id: existingAnalysis.id },
            data: { result: stringifyJson(result), config: stringifyJson(cfg) },
          })
        : await withTenantDb(ctx, (db) =>
          db.analysis.create({
            data: {
              workspaceId: ctx.workspace.id,
              projectId: dataset!.projectId,
              datasetId: dataset!.id,
              kind: body.kind,
              title: result.title,
              config: stringifyJson(cfg),
              result: stringifyJson(result),
              createdById: ctx.user.id,
            },
          }),
  );
    const analysisVersion = await createAnalysisVersion({
      analysisId: analysis.id,
      workspaceId: ctx.workspace.id,
      result,
      config: cfg as unknown as Record<string, unknown>,
      createdById: ctx.user.id,
      datasetVersionId: pinnedVersion?.id ?? null,
    });

    // Auto-derive lightweight insight cards from quick findings.
    const derived = insightsFromAnalysis(result, dataset!.name).slice(0, 3);
    const createdInsights = [];
    for (const insight of derived) {
      createdInsights.push(
        await withTenantDb(ctx, (db) =>
          db.insight.create({
            data: {
              workspaceId: ctx.workspace.id,
              projectId: dataset!.projectId,
              datasetId: dataset!.id,
              analysisId: analysis.id,
              title: insight.title,
              severity: insight.severity,
              metric: insight.metric,
              observedChange: insight.observedChange,
              evidence: stringifyJson(insight.evidence),
              possibleCause: insight.possibleCause,
              businessImplication: insight.businessImplication,
              recommendedNextStep: insight.recommendedNextStep,
              confidence: insight.confidence,
              extra: insight.extra ? stringifyJson(insight.extra) : null,
            },
          }),
        );
    }

    await logActivity(ctx, "ANALYSIS_RUN", `Analysis “${result.title}” completed`, dataset!.projectId, {
      datasetId: dataset!.id,
      analysisId: analysis.id,
    });
    await notify(ctx.user.id, {
      type: "analysis",
      title: "Analysis completed",
      message: `“${result.title}” is ready to explore.`,
    });

    void ndjsonPath;
    return ok({
      analysis: { id: analysis.id },
      analysisVersionId: analysisVersion.id,
      analysisVersion: analysisVersion.version,
      version: analysisVersion.version,
      reRun: Boolean(existingAnalysis),
      insightIds: createdInsights.map((i) => i.id),
      warnings: result.qualityWarnings,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
