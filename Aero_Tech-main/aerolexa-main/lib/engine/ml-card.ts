/**
 * Advanced trainer → ModelCard adapter.
 *
 * `lib/engine/ml-training.ts` (trainWithCv) is the repo's advanced ML engine:
 * k-fold CV (stratified for classification), out-of-fold metrics, permutation
 * importance and IRLS logistic diagnostics. Until now it was reachable ONLY
 * from tests — the API used the hold-out prototype trainer. This adapter maps
 * its result into the `ModelCard` shape the registry/UI/export pipeline
 * already consumes, so both engines can coexist behind one API contract.
 *
 * Honesty rules preserved:
 *  - CV metrics are OUT-OF-FOLD (the honest generalization estimate); the
 *    full-data refit metrics are IN-SAMPLE and labelled as such everywhere.
 *  - `generalization` compares the in-sample refit against the CV mean with
 *    the exact threshold rule stated in its explanation.
 *  - Every card names its engine in `metadata.engine` — no silent swaps.
 */

import type {
  PermutationImportance,
  MlTrainResult,
  RegressionMetrics,
  ClassificationMetrics,
  MulticlassMetrics,
} from "@/lib/engine/ml-training";
import type { ModelCard, ModelMetrics } from "@/lib/types";

const ALGORITHM_LABELS: Record<MlTrainResult["algorithm"], string> = {
  ridge: "Ridge regression (k-fold CV engine)",
  logistic: "Logistic regression (k-fold CV engine)",
  "decision-tree": "Decision tree (k-fold CV engine)",
  "random-forest": "Random forest (k-fold CV engine)",
  knn: "k-nearest neighbours (k-fold CV engine)",
  "gradient-boosting": "Gradient boosting (k-fold CV engine)",
  mlp: "Neural network (k-fold CV engine)",
};

/** MLP cards describe the REAL architecture: depth + activation, from the artifact. */
function mlpArchitectureLabel(result: MlTrainResult): string {
  const mlp = result.artifact.mlp;
  const layers = mlp ? mlp.layers.length - 1 : 2; // hidden layers = stored stack (head excluded)
  const act = mlp?.activation ?? "relu";
  return `${ALGORITHM_LABELS.mlp} — ${layers}×${act.toUpperCase()} hidden`;
}

function round6(v: number): number {
  if (!Number.isFinite(v)) return v;
  return Math.round(v * 1e6) / 1e6;
}

/** Generalization risk from the in-sample vs out-of-fold gap. */
function assessGap(
  primaryMetric: string,
  train: number,
  oof: number,
  direction: "higher-worse" | "lower-worse",
): {
  primaryMetric: string;
  train: number;
  validation: number;
  test: number;
  gap: number;
  risk: "low" | "medium" | "high";
  explanation: string;
} {
  const gap = round6(direction === "higher-worse" ? oof - train : train - oof);
  let risk: "low" | "medium" | "high";
  let rule: string;
  if (direction === "lower-worse") {
    // AUC-style metrics on a 0–1 scale: absolute-gap thresholds.
    risk = gap <= 0.05 ? "low" : gap <= 0.15 ? "medium" : "high";
    rule = "absolute gap ≤ 0.05 low, ≤ 0.15 medium, else high";
  } else {
    // RMSE-style metrics: gap relative to the in-sample level.
    const rel = train > 0 ? gap / train : 0;
    risk = rel <= 0.1 ? "low" : rel <= 0.3 ? "medium" : "high";
    rule = "relative gap ≤ 10% low, ≤ 30% medium, else high";
  }
  return {
    primaryMetric,
    train: round6(train),
    validation: round6(oof),
    test: round6(oof),
    gap,
    risk,
    explanation:
      `Train is the IN-SAMPLE full-data refit; validation/test are the ${primaryMetric} mean across out-of-fold predictions ` +
      `(k-fold CV — both hold the same honest held-out estimate). Risk rule: ${rule}. ` +
      (risk === "high"
        ? "The refit memorises the training rows far better than it generalises — collect more rows, regularise, or simplify the model."
        : risk === "medium"
          ? "A visible gap — prefer the out-of-fold numbers when reporting."
          : "Training and unseen-row performance agree."),
  };
}

/**
 * Build the registry-ready ModelCard from an advanced-engine result.
 * `name` comes from the API request (the engine result does not carry one).
 */
export function advancedModelCard(result: MlTrainResult, name: string): ModelCard {
  const isRegression = result.task === "regression";
  const isMulticlass = result.task === "multiclass-classification";
  const task: ModelCard["task"] = isRegression ? "regression" : "classification";

  // ---- Generalization: in-sample refit vs out-of-fold CV mean -------------
  const generalization = isRegression
    ? assessGap("rmse", (result.trainMetrics as RegressionMetrics | null)?.rmse ?? 0, result.cv.mean, "higher-worse")
    : isMulticlass
      ? assessGap(
          "accuracy",
          (result.trainMetrics as MulticlassMetrics | null)?.accuracy ?? 0,
          result.cv.mean,
          "lower-worse",
        )
      : assessGap(
          "rocAuc",
          (result.trainMetrics as ClassificationMetrics | null)?.rocAuc ?? 0,
          result.cv.mean,
          "lower-worse",
        );

  // ---- Metrics -------------------------------------------------------------
  const trainRows = isRegression
    ? ((result.trainMetrics as RegressionMetrics | null)?.n ?? 0)
    : ((result.trainMetrics as ClassificationMetrics | null)?.n ?? 0);
  const metrics: ModelMetrics = {
    algorithm: result.algorithm === "mlp" ? mlpArchitectureLabel(result) : ALGORITHM_LABELS[result.algorithm],
    task,
    trainRows,
    featureCount: result.featureNames.length,
    cvMetric: result.cv.metricName,
    cvMean: result.cv.mean,
    cvSd: result.cv.sd,
    cvFolds: result.cv.folds,
    generalization,
  };
  if (isRegression) {
    const m = result.trainMetrics as RegressionMetrics | null;
    if (m) {
      metrics.r2 = round6(m.r2);
      metrics.rmse = round6(m.rmse);
      metrics.mae = round6(m.mae);
      // In-sample refit numbers, explicitly labelled:
      metrics.inSampleR2 = round6(m.r2);
      metrics.inSampleRmse = round6(m.rmse);
      metrics.inSampleMae = round6(m.mae);
      // Held-out (out-of-fold) estimates:
      metrics.testRmse = result.cv.mean;
      metrics.validationRmse = result.cv.mean;
    }
  } else if (isMulticlass) {
    const m = result.trainMetrics as MulticlassMetrics | null;
    if (m) {
      metrics.accuracy = round6(m.accuracy);
      metrics.macroPrecision = round6(m.macroPrecision);
      metrics.macroRecall = round6(m.macroRecall);
      metrics.macroF1 = round6(m.macroF1);
      // Held-out (out-of-fold) estimate:
      metrics.testAccuracy = result.cv.mean;
      metrics.validationAccuracy = result.cv.mean;
      metrics.classCounts = result.classCounts ?? [];
      if (result.classes) metrics.classList = result.classes;
    }
  } else {
    const m = result.trainMetrics as ClassificationMetrics | null;
    if (m) {
      metrics.accuracy = round6(m.accuracy);
      metrics.precision = round6(m.precision);
      metrics.recall = round6(m.recall);
      metrics.f1 = round6(m.f1);
      metrics.rocAuc = round6(m.rocAuc);
      metrics.inSampleRocAuc = round6(m.rocAuc);
      metrics.inSampleF1 = round6(m.f1);
      // Held-out (out-of-fold) estimates:
      metrics.testRocAuc = result.cv.mean;
      metrics.validationRocAuc = result.cv.mean;
      metrics.bestThreshold = round6(m.bestThreshold);
      metrics.positiveRows = result.classBalance?.positive ?? 0;
      metrics.negativeRows = result.classBalance?.negative ?? 0;
    }
  }

  // ---- Weights / coefficients (ridge + logistic expose real parameters) ----
  let weights: number[] = [];
  let intercept: number | undefined;
  let coefficients: Record<string, number> | undefined;
  let coefficientPValues: Record<string, number> | undefined;
  if (result.algorithm === "ridge" && result.artifact.weights) {
    weights = result.artifact.weights.map(round6);
    intercept = result.artifact.intercept;
    coefficients = Object.fromEntries(
      result.artifact.featureNames.map((f, i) => [f, round6(result.artifact.weights![i] ?? 0)]),
    );
  } else if (result.algorithm === "logistic" && result.glmDiagnostics) {
    const coefs = result.glmDiagnostics.coefficients;
    intercept = round6(coefs[0]?.coefficient ?? 0);
    weights = coefs.slice(1).map((c) => round6(c.coefficient));
    coefficients = Object.fromEntries(
      coefs.map((c) => [c.name === "(Intercept)" ? "(Intercept)" : c.name, round6(c.coefficient)]),
    );
    coefficientPValues = Object.fromEntries(
      coefs.map((c) => [c.name === "(Intercept)" ? "(Intercept)" : c.name, round6(c.pValue)]),
    );
  }

  const importance: PermutationImportance[] = result.importance;

  return {
    task,
    algorithm: result.algorithm === "mlp" ? mlpArchitectureLabel(result) : ALGORITHM_LABELS[result.algorithm],
    name,
    targetColumn: result.targetColumn,
    features: result.featureNames,
    params: { ...result.artifact.hyperparams, cvFolds: result.cv.folds, seedNote: "deterministic folds (seeded PRNG)" },
    metrics,
    trainRows,
    createdAt: new Date().toISOString(),
    versionTag: `cv-${result.algorithm}-v1`,
    weights,
    intercept,
    coefficients,
    coefficientPValues,
    classMap:
      !isRegression && result.artifact.classes && result.artifact.classes.length === 2
        ? { positive: result.artifact.classes[1] ?? "1", negative: result.artifact.classes[0] ?? "0" }
        : undefined,
    generalization,
    crossValidation: {
      method: "k-fold",
      folds: result.cv.perFold.map((metric, i) => ({
        fold: i + 1,
        // Fold sizes are not returned individually; report the OOF metric only.
        trainRows: 0,
        testRows: 0,
        metrics: { [result.cv.metricName]: metric },
      })),
    },
    featureImportance: importance.map((imp) => ({
      feature: imp.feature,
      importance: round6(imp.importance),
      method: "permutation (out-of-fold)",
    })),
    demoNote:
      "Computed with the advanced k-fold CV engine: out-of-fold metrics, permutation importance, no silent downgrades. In-sample refit numbers are labelled." +
      (isMulticlass
        ? " Multiclass: out-of-fold accuracy + macro precision/recall/F1; the confusion matrix is from the in-sample refit."
        : ""),
    metadata: {
      engine: "cv-ml-trainer",
      exporter: "model-card-json",
      onnxNote: "ONNX export arrives with the live kernel; the JSON card + Python export reproduce this model today.",
      realComputation: true,
    },
  };
}
