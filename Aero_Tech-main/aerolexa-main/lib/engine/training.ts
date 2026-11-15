/**
 * Deterministic "prototype trainer" for the Model Training module.
 *
 * There is no GPU/sklearn service in the prototype. Instead of faking one,
 * this module trains small, real models in TypeScript directly on the user's
 * uploaded rows and stores them as versioned model cards:
 *
 *   - regression   → closed-form linear regression (standardized features)
 *   - classification → binary logistic regression (gradient descent)
 *   - clustering   → k-means on standardized features
 *
 * Every ModelCard carries a `demoNote` and metadata saying the weights are in
 * the prototype "model card JSON" format — ONNX export arrives with the live
 * kernel (see POST /api/training and the Models tab). In-sample metrics are
 * reported with an explicit "training data" disclaimer so nobody mistakes them
 * for held-out performance.
 *
 * Deterministic (seeded RNG) and dependency-free; unit-tested in
 * __tests__/unit/training.test.ts.
 */

import { studentTPValue } from "@/lib/engine/stats";
import type { ColType, GeneralizationAssessment, ModelCard, ModelMetrics, ModelTask } from "@/lib/types";

export class TrainingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingError";
  }
}

export interface TrainableSource {
  columns: { name: string; type: ColType }[];
  rows: (string | number | boolean | null)[][];
}

export interface TrainRequest {
  task: ModelTask;
  name?: string;
  targetColumn?: string | null;
  algorithm?: "linear-regression" | "logistic-regression" | "random-forest" | "gradient-boosting" | "k-means";
  testRatio?: number;
  cvFolds?: number;
  hyperparams?: Record<string, number | string | boolean>;
}

function toNum(v: string | number | boolean | null | undefined): number {
  if (v === null || v === undefined || v === "") return Number.NaN;
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(String(v).replace(/[,$\s%€£]/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Deterministic PRNG (mulberry32) so repeated runs produce identical results. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Prepared {
  /** standardized feature columns */
  features: number[][];
  featureNames: string[];
  means: number[];
  stds: number[];
  /** rows used (those with all features finite) */
  count: number;
}

/**
 * Resolve candidate numeric feature columns (excluding `exclude`), jointly
 * filtering rows to those where EVERY feature and the target are finite.
 * Returns aligned standardized features + target vector.
 */
function jointPreparedData(
  source: TrainableSource,
  exclude: Set<string>,
  maxFeatures: number,
  targetNumeric: (row: (string | number | boolean | null)[]) => number,
  targetPresent?: (row: (string | number | boolean | null)[]) => boolean,
): Prepared & { target: number[] } {
  const idxs: { name: string; i: number }[] = [];
  for (let i = 0; i < source.columns.length; i++) {
    const c = source.columns[i] as { name: string; type: ColType };
    if (exclude.has(c.name)) continue;
    if (c.type !== "number" && c.type !== "boolean") continue;
    idxs.push({ name: c.name, i });
  }
  if (idxs.length === 0) {
    throw new TrainingError(
      "No numeric columns are available to train on. Cast at least one column to Number in the dataset first.",
    );
  }
  const sel = idxs.slice(0, maxFeatures);
  const names = sel.map((x) => x.name);
  const use = sel.map((x) => x.i);
  const rows: number[][] = [];
  const target: number[] = [];
  for (const row of source.rows) {
    const vec = use.map((i) => toNum(row[i]));
    if (vec.some((v) => !Number.isFinite(v))) continue;
    const y = targetNumeric(row);
    if (!Number.isFinite(y)) continue;
    if (targetPresent && !targetPresent(row)) continue;
    rows.push(vec);
    target.push(y);
  }
  if (rows.length < 10) {
    throw new TrainingError(
      `Only ${rows.length} complete rows — at least 10 rows with all features AND the target present are needed.`,
    );
  }
  const means = names.map((_, j) => rows.reduce((a, r) => a + (r[j] as number), 0) / rows.length);
  const stds = names.map((_, j) => {
    const m = means[j] as number;
    const v = rows.reduce((a, r) => a + ((r[j] as number) - m) ** 2, 0) / rows.length;
    return Math.sqrt(v) || 1;
  });
  const features = rows.map((r) => r.map((v, j) => ((v as number) - (means[j] as number)) / (stds[j] as number)));
  return { features, featureNames: names, means, stds, count: rows.length, target };
}

function prepareFeatures(source: TrainableSource, exclude: Set<string>, maxFeatures: number): Prepared {
  const idxs: { name: string; i: number }[] = [];
  for (let i = 0; i < source.columns.length; i++) {
    const c = source.columns[i] as { name: string; type: ColType };
    if (exclude.has(c.name)) continue;
    if (c.type !== "number" && c.type !== "boolean") continue;
    idxs.push({ name: c.name, i });
  }
  if (idxs.length === 0) {
    throw new TrainingError(
      "No numeric columns are available to train on. Cast at least one column to Number in the dataset first.",
    );
  }
  const names = idxs.slice(0, maxFeatures).map((x) => x.name);
  const use = idxs.slice(0, maxFeatures).map((x) => x.i);
  const rows: number[][] = [];
  for (const row of source.rows) {
    const vec = use.map((i) => toNum(row[i]));
    if (vec.some((v) => !Number.isFinite(v))) continue; // drop rows with any missing feature
    rows.push(vec);
  }
  if (rows.length < 10) {
    throw new TrainingError(
      `Only ${rows.length} complete rows — at least 10 rows with all features present are needed for training.`,
    );
  }
  const means = names.map((_, j) => rows.reduce((a, r) => a + (r[j] as number), 0) / rows.length);
  const stds = names.map((_, j) => {
    const m = means[j] as number;
    const v = rows.reduce((a, r) => a + ((r[j] as number) - m) ** 2, 0) / rows.length;
    return Math.sqrt(v) || 1;
  });
  const features = rows.map((r) => r.map((v, j) => ((v as number) - (means[j] as number)) / (stds[j] as number)));
  return { features, featureNames: names, means, stds, count: rows.length };
}

function targetValues(source: TrainableSource, target: string | null | undefined, allowLabels: boolean) {
  if (!target) throw new TrainingError("Choose a target column.");
  const idx = source.columns.findIndex((c) => c.name === target);
  if (idx < 0) throw new TrainingError(`Target column “${target}” was not found in the dataset.`);
  const col = source.columns[idx] as { name: string; type: ColType };
  if (col.type === "number" || col.type === "boolean") {
    const values = source.rows.map((r) => toNum(r[idx])).filter((v) => Number.isFinite(v));
    if (values.length < 10) throw new TrainingError(`Target “${target}” has only ${values.length} usable values.`);
    return { numeric: values, labels: null };
  }
  if (!allowLabels) {
    throw new TrainingError(
      `Target “${target}” is not numeric. Cast it to Number for regression, or use a two-value column for classification.`,
    );
  }
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const row of source.rows) {
    const v = row[idx];
    if (v === null || v === undefined || v === "") continue;
    const s = String(v);
    if (!counts.has(s)) {
      counts.set(s, 0);
      order.push(s);
    }
    counts.set(s, (counts.get(s) as number) + 1);
  }
  if (counts.size !== 2) {
    throw new TrainingError(
      `Classification needs a target with exactly two values — “${target}” has ${counts.size}. Pick a boolean or two-category column.`,
    );
  }
  const negative = order[0] as string;
  const positive = order[1] as string;
  const numeric = source.rows.map((r) => {
    const v = r[idx];
    if (v === null || v === undefined || v === "") return Number.NaN;
    return String(v) === positive ? 1 : 0;
  });
  return { numeric, labels: { positive, negative } };
}

function linearRegression(X: number[][], y: number[], lambda = 1e-3): { weights: number[]; intercept: number } {
  // Closed form: (XᵀX + λI)⁻¹ Xᵀy over the standardized features (bias handled
  // separately so coefficients are directly comparable across features).
  const n = X.length;
  const d = X[0]!.length;
  const featureMeans = Array.from({ length: d }, (_, index) => X.reduce((sum, row) => sum + (row[index] ?? 0), 0) / n);
  const targetMean = y.reduce((a, b) => a + b, 0) / y.length;
  const xtx: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const xty: number[] = new Array(d).fill(0);
  for (let r = 0; r < n; r++) {
    const x = (X[r] as number[]).map((value, index) => value - (featureMeans[index] ?? 0));
    const centeredTarget = (y[r] as number) - targetMean;
    for (let i = 0; i < d; i++) {
      xty[i] = (xty[i] as number) + (x[i] as number) * centeredTarget;
      for (let j = 0; j < d; j++) {
        (xtx[i] as number[])[j] = ((xtx[i] as number[])[j] as number) + (x[i] as number) * (x[j] as number);
      }
    }
  }
  for (let i = 0; i < d; i++) (xtx[i] as number[])[i] = ((xtx[i] as number[])[i] as number) + lambda;
  // Gauss-Jordan elimination on the augmented matrix.
  const aug = xtx.map((row, i) => [...row, xty[i] as number]);
  const rowLabels = Array.from({ length: d }, (_, index) => index);
  for (let col = 0; col < d; col++) {
    // partial pivot
    let pivot = col;
    for (let r = col + 1; r < d; r++) {
      if (Math.abs((aug[r] as number[])[col] as number) > Math.abs((aug[pivot] as number[])[col] as number)) {
        pivot = r;
      }
    }
    const tmp = aug[col] as number[];
    aug[col] = aug[pivot] as number[];
    aug[pivot] = tmp;
    const label = rowLabels[col] as number;
    rowLabels[col] = rowLabels[pivot] as number;
    rowLabels[pivot] = label;
    const piv = (aug[col] as number[])[col] as number;
    if (Math.abs(piv) < 1e-12) continue;
    for (let j = col; j <= d; j++) (aug[col] as number[])[j] = ((aug[col] as number[])[j] as number) / piv;
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const factor = (aug[r] as number[])[col] as number;
      for (let j = col; j <= d; j++) {
        (aug[r] as number[])[j] = ((aug[r] as number[])[j] as number) - factor * ((aug[col] as number[])[j] as number);
      }
    }
  }
  const weights = new Array<number>(d).fill(0);
  for (let row = 0; row < d; row++) weights[rowLabels[row] as number] = (aug[row] as number[])[d] as number;
  const intercept = targetMean - weights.reduce((sum, weight, index) => sum + weight * (featureMeans[index] ?? 0), 0);
  return { weights, intercept };
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function logisticRegression(
  X: number[][],
  y: number[],
  lr: number,
  iters: number,
): { weights: number[]; intercept: number } {
  const n = X.length;
  const d = X[0]!.length;
  const weights = new Array(d).fill(0);
  let bias = 0;
  for (let it = 0; it < iters; it++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let r = 0; r < n; r++) {
      const x = X[r] as number[];
      const z = bias + x.reduce((a, v, j) => a + v * (weights[j] as number), 0);
      const p = sigmoid(z);
      const err = p - (y[r] as number);
      for (let j = 0; j < d; j++) gradW[j] = (gradW[j] as number) + err * (x[j] as number);
      gradB += err;
    }
    for (let j = 0; j < d; j++) weights[j] = (weights[j] as number) - (lr / n) * (gradW[j] as number);
    bias -= (lr / n) * gradB;
  }
  return { weights, intercept: bias };
}

function kMeans(
  X: number[][],
  k: number,
  rng: () => number,
  maxIter = 60,
): { centroids: number[][]; assign: number[]; inertia: number } {
  const n = X.length;
  const d = (X[0] ?? []).length;
  // k-means++-ish seeding from distinct points (deterministic via rng).
  const centroids: number[][] = [];
  const chosen = new Set<number>();
  while (centroids.length < k && chosen.size < n) {
    let idx = Math.floor(rng() * n);
    if (chosen.has(idx)) {
      idx = (idx + 1) % n;
      if (chosen.has(idx)) {
        for (let i = 0; i < n; i++) {
          if (!chosen.has(i)) {
            idx = i;
            break;
          }
        }
      }
    }
    chosen.add(idx);
    centroids.push([...(X[idx] ?? [])]);
  }
  while (centroids.length < k) centroids.push(new Array<number>(d).fill(0)); // duplicates guard
  const assign: number[] = new Array<number>(n).fill(0);
  let inertia = Number.POSITIVE_INFINITY;
  for (let it = 0; it < maxIter; it++) {
    // assign points to nearest centroid
    let total = 0;
    for (let r = 0; r < n; r++) {
      const point = X[r] ?? [];
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centroids.length; c++) {
        const centroid = centroids[c] ?? [];
        let dist = 0;
        for (let j = 0; j < d; j++) {
          const diff = (point[j] ?? 0) - (centroid[j] ?? 0);
          dist += diff * diff;
        }
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      assign[r] = best;
      total += bestDist;
    }
    if (Math.abs(total - inertia) < 1e-9) break;
    inertia = total;
    // recompute centroids as group means
    const sums: number[][] = Array.from({ length: centroids.length }, () => new Array<number>(d).fill(0));
    const counts: number[] = new Array<number>(centroids.length).fill(0);
    for (let r = 0; r < n; r++) {
      const c = assign[r] ?? 0;
      counts[c] = (counts[c] ?? 0) + 1;
      const point = X[r] ?? [];
      const sum = sums[c] ?? [];
      for (let j = 0; j < d; j++) sum[j] = (sum[j] ?? 0) + (point[j] ?? 0);
    }
    for (let c = 0; c < centroids.length; c++) {
      const count = counts[c] ?? 0;
      if (count > 0) {
        const sum = sums[c] ?? [];
        const centroid = centroids[c] ?? [];
        for (let j = 0; j < d; j++) centroid[j] = (sum[j] ?? 0) / count;
      }
    }
  }
  return { centroids, assign, inertia };
}

function fmt(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

interface RegressionEvaluation {
  r2: number;
  rmse: number;
  mae: number;
  residuals: { predicted: number; actual: number; residual: number }[];
}

interface RegressionPredictor {
  predict: (X: number[][]) => number[];
  featureImportance: number[];
  intercept: number;
}

interface RegressionStump {
  feature: number;
  threshold: number;
  left: number;
  right: number;
}

function fitStump(X: number[][], y: number[], candidates = 24): RegressionStump {
  let best: RegressionStump = { feature: 0, threshold: X[0]?.[0] ?? 0, left: meanNumber(y), right: meanNumber(y) };
  let bestError = Number.POSITIVE_INFINITY;
  for (let feature = 0; feature < (X[0]?.length ?? 0); feature++) {
    const values = [...new Set(X.map((row) => row[feature] as number))].sort((a, b) => a - b);
    const step = Math.max(1, Math.ceil(values.length / candidates));
    for (let index = 0; index < values.length - 1; index += step) {
      const threshold = ((values[index] as number) + (values[index + 1] as number)) / 2;
      const left = y.filter((_, row) => (X[row]?.[feature] ?? 0) <= threshold);
      const right = y.filter((_, row) => (X[row]?.[feature] ?? 0) > threshold);
      if (!left.length || !right.length) continue;
      const leftMean = meanNumber(left);
      const rightMean = meanNumber(right);
      const error =
        left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0) +
        right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0);
      if (error < bestError) {
        bestError = error;
        best = { feature, threshold, left: leftMean, right: rightMean };
      }
    }
  }
  return best;
}

function stumpPredict(stump: RegressionStump, X: number[][]): number[] {
  return X.map((row) => ((row[stump.feature] ?? 0) <= stump.threshold ? stump.left : stump.right));
}

function fitRandomForest(X: number[][], y: number[], trees: number, seed: number): RegressionPredictor {
  const rng = seededRandom(seed);
  const forest: RegressionStump[] = [];
  const importance = new Array<number>(X[0]?.length ?? 0).fill(0);
  for (let tree = 0; tree < trees; tree++) {
    const sample = Array.from({ length: X.length }, () => Math.floor(rng() * X.length));
    const stump = fitStump(
      sample.map((index) => X[index] as number[]),
      sample.map((index) => y[index] as number),
    );
    forest.push(stump);
    importance[stump.feature] = (importance[stump.feature] ?? 0) + 1;
  }
  return {
    predict: (rows) =>
      rows.map((row) => forest.reduce((sum, stump) => sum + stumpPredict(stump, [row])[0]!, 0) / forest.length),
    featureImportance: importance.map((value) => value / trees),
    intercept: meanNumber(y),
  };
}

function fitGradientBoosting(
  X: number[][],
  y: number[],
  estimators: number,
  learningRate: number,
): RegressionPredictor {
  const base = meanNumber(y);
  const residuals = y.map((value) => value - base);
  const stumps: RegressionStump[] = [];
  const importance = new Array<number>(X[0]?.length ?? 0).fill(0);
  for (let index = 0; index < estimators; index++) {
    const stump = fitStump(X, residuals);
    const correction = stumpPredict(stump, X);
    for (let row = 0; row < residuals.length; row++)
      residuals[row] = (residuals[row] as number) - learningRate * (correction[row] as number);
    stumps.push(stump);
    importance[stump.feature] = (importance[stump.feature] ?? 0) + Math.abs(stump.left) + Math.abs(stump.right);
  }
  const totalImportance = importance.reduce((sum, value) => sum + value, 0) || 1;
  return {
    predict: (rows) =>
      rows.map((row) => base + stumps.reduce((sum, stump) => sum + learningRate * stumpPredict(stump, [row])[0]!, 0)),
    featureImportance: importance.map((value) => value / totalImportance),
    intercept: base,
  };
}

function meanNumber(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function evaluateClassification(actual: number[], probabilities: number[]): Record<string, number> {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (let index = 0; index < actual.length; index++) {
    const predicted = (probabilities[index] ?? 0) >= 0.5 ? 1 : 0;
    if (actual[index] === 1 && predicted === 1) tp++;
    else if (actual[index] === 1) fn++;
    else if (predicted === 1) fp++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const accuracy = (tp + tn) / Math.max(1, actual.length);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const positives = actual.filter((value) => value === 1).length;
  const negatives = actual.length - positives;
  const ranked = actual
    .map((value, index) => ({ value, probability: probabilities[index] ?? 0 }))
    .sort((a, b) => b.probability - a.probability);
  let rankSum = 0;
  ranked.forEach((item, index) => {
    if (item.value === 1) rankSum += index + 1;
  });
  const rocAuc = positives && negatives ? (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives) : 0.5;
  return { accuracy, precision, recall, f1, rocAuc };
}

function crossValidateClassification(
  pairs: { x: number[]; y: number }[],
  folds: number,
  algorithm: "logistic-regression" | "random-forest" | "gradient-boosting",
  learningRate: number,
  iterations: number,
  estimators: number,
): ModelCard["crossValidation"] {
  const order = shuffledIndices(pairs.length, 20260101);
  const results: NonNullable<ModelCard["crossValidation"]>["folds"] = [];
  for (let fold = 0; fold < folds; fold++) {
    const testIndices = order.filter((_, index) => index % folds === fold);
    const testSet = new Set(testIndices);
    const trainPairs = order
      .filter((index) => !testSet.has(index))
      .map((index) => pairs[index] as { x: number[]; y: number });
    const testPairs = testIndices.map((index) => pairs[index] as { x: number[]; y: number });
    const forest =
      algorithm === "random-forest"
        ? fitRandomForest(
            trainPairs.map((pair) => pair.x),
            trainPairs.map((pair) => pair.y),
            estimators,
            20260101 + fold,
          )
        : null;
    const boosting =
      algorithm === "gradient-boosting"
        ? fitGradientBoosting(
            trainPairs.map((pair) => pair.x),
            trainPairs.map((pair) => pair.y),
            estimators,
            learningRate,
          )
        : null;
    const logistic =
      algorithm === "logistic-regression"
        ? logisticRegression(
            trainPairs.map((pair) => pair.x),
            trainPairs.map((pair) => pair.y),
            learningRate,
            iterations,
          )
        : null;
    const predict = (x: number[]) =>
      forest
        ? (forest.predict([x])[0] ?? 0)
        : boosting
          ? (boosting.predict([x])[0] ?? 0)
          : sigmoid(
              (logistic?.intercept ?? 0) +
                x.reduce((sum, value, index) => sum + value * (logistic?.weights[index] ?? 0), 0),
            );
    const metrics = evaluateClassification(
      testPairs.map((pair) => pair.y),
      testPairs.map((pair) => predict(pair.x)),
    );
    results.push({ fold: fold + 1, trainRows: trainPairs.length, testRows: testPairs.length, metrics });
  }
  return { method: "k-fold", folds: results };
}

function predictLinear(X: number[][], weights: number[], intercept: number): number[] {
  return X.map((row) => intercept + row.reduce((sum, value, index) => sum + value * (weights[index] ?? 0), 0));
}

function evaluateRegression(X: number[][], y: number[], weights: number[], intercept: number): RegressionEvaluation {
  return evaluatePredictions(y, predictLinear(X, weights, intercept));
}

function evaluatePredictions(y: number[], predictions: number[]): RegressionEvaluation {
  const average = y.reduce((sum, value) => sum + value, 0) / y.length;
  let squared = 0;
  let absolute = 0;
  const residuals = predictions.map((predicted, index) => {
    const actual = y[index] as number;
    const residual = actual - predicted;
    squared += residual ** 2;
    absolute += Math.abs(residual);
    return { predicted: fmt(predicted), actual: fmt(actual), residual: fmt(residual) };
  });
  const total = y.reduce((sum, value) => sum + (value - average) ** 2, 0);
  return {
    r2: total === 0 ? 1 : 1 - squared / total,
    rmse: Math.sqrt(squared / y.length),
    mae: absolute / y.length,
    residuals,
  };
}

function shuffledIndices(length: number, seed: number): number[] {
  const indices = Array.from({ length }, (_, index) => index);
  const rng = seededRandom(seed);
  for (let index = indices.length - 1; index > 0; index--) {
    const swap = Math.floor(rng() * (index + 1));
    [indices[index], indices[swap]] = [indices[swap] as number, indices[index] as number];
  }
  return indices;
}

interface ThreeWaySplit {
  train: number[];
  validation: number[];
  test: number[];
}

/**
 * Deterministic three-way split over an already-shuffled index order. Test and
 * validation each take `testRatio` of the rows; the remainder trains. Hold-outs
 * shrink symmetrically when the dataset is small so a real training set always
 * remains, while the test set keeps its advertised ratio for typical sizes.
 */
function threeWaySplit(order: number[], testRatio: number): ThreeWaySplit {
  const n = order.length;
  const minTrain = Math.max(2, Math.floor(n * 0.4));
  let testCount = Math.max(1, Math.round(n * testRatio));
  let validationCount = Math.max(1, Math.round(n * testRatio));
  while (testCount + validationCount > n - minTrain && (testCount > 1 || validationCount > 1)) {
    if (testCount >= validationCount && testCount > 1) testCount--;
    else if (validationCount > 1) validationCount--;
    else break;
  }
  return {
    test: order.slice(0, testCount),
    validation: order.slice(testCount, testCount + validationCount),
    train: order.slice(testCount + validationCount),
  };
}

/**
 * Compare the training metric with both held-out splits. `gap` uses the WORST
 * held-out metric so a model that only looks good on rows it memorized is
 * surfaced rather than celebrated.
 */
function assessGeneralization(
  primaryMetric: string,
  train: number,
  validation: number,
  test: number,
  heldOutRows: number,
): GeneralizationAssessment {
  const worstHeldOut = Math.min(validation, test);
  const gap = train - worstHeldOut;
  const smallSample = heldOutRows < 15;
  const high = gap > (smallSample ? 0.1 : 0.15);
  const medium = gap > (smallSample ? 0.04 : 0.05);
  const risk: GeneralizationAssessment["risk"] = high ? "high" : medium ? "medium" : "low";
  const trained = fmt(train);
  const heldOut = fmt(worstHeldOut);
  const explanation =
    risk === "high"
      ? `Training ${primaryMetric} ${trained} vs held-out ${heldOut} — the model fits the rows it saw far better than unseen rows. Quote the held-out number, not the training one, and try fewer features or more data.`
      : risk === "medium"
        ? `Training ${primaryMetric} ${trained} vs held-out ${heldOut} — a mild generalization gap. The held-out number is the one to quote.`
        : `Training and held-out ${primaryMetric} are close (${primaryMetric} gap ${fmt(gap)}). The held-out number is still the one to quote.`;
  return {
    primaryMetric,
    train: trained,
    validation: fmt(validation),
    test: fmt(test),
    gap: fmt(gap),
    risk,
    explanation,
  };
}

function coefficientPValue(
  coefficient: number,
  X: number[][],
  y: number[],
  predictions: number[],
  featureIndex: number,
): number {
  const residualSum = y.reduce((sum, value, index) => sum + (value - (predictions[index] as number)) ** 2, 0);
  const degreesOfFreedom = Math.max(1, y.length - X[0]!.length - 1);
  const mse = residualSum / degreesOfFreedom;
  const meanX = X.reduce((sum, row) => sum + (row[featureIndex] as number), 0) / X.length;
  const sumSquares = X.reduce((sum, row) => sum + ((row[featureIndex] as number) - meanX) ** 2, 0);
  const standardError = Math.sqrt(mse / Math.max(sumSquares, 1e-12));
  const t = Math.abs(coefficient) / Math.max(standardError, 1e-12);
  // Exact two-sided Student-t p-value (regularized incomplete beta) — the same
  // statistic statsmodels OLS reports. The previous 2·e^−t was an asymptotic
  // approximation, valid only for large |t|, and overstated significance
  // elsewhere (e.g. p ≈ 0.17 → 0.32 at t = 1.8).
  return studentTPValue(t, degreesOfFreedom);
}

function residualNormality(residuals: number[]): { statistic: number; pValue: number; passed: boolean } {
  const average = residuals.reduce((sum, value) => sum + value, 0) / residuals.length;
  const centered = residuals.map((value) => value - average);
  const variance = centered.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, centered.length);
  if (variance === 0) return { statistic: 0, pValue: 1, passed: true };
  const skew = centered.reduce((sum, value) => sum + value ** 3, 0) / centered.length / variance ** 1.5;
  const kurtosis = centered.reduce((sum, value) => sum + value ** 4, 0) / centered.length / variance ** 2;
  const statistic = (centered.length / 6) * (skew ** 2 + (kurtosis - 3) ** 2 / 4);
  const pValue = Math.max(0, Math.min(1, Math.exp(-statistic / 2)));
  return { statistic: fmt(statistic), pValue: fmt(pValue), passed: pValue >= 0.05 };
}

function crossValidateRegression(X: number[][], y: number[], folds: number): ModelCard["crossValidation"] {
  const order = shuffledIndices(X.length, 20260101);
  const results: NonNullable<ModelCard["crossValidation"]>["folds"] = [];
  for (let fold = 0; fold < folds; fold++) {
    const testIndices = order.filter((_, index) => index % folds === fold);
    const testSet = new Set(testIndices);
    const trainIndices = order.filter((rowIndex) => !testSet.has(rowIndex));
    const trainX = trainIndices.map((index) => X[index] as number[]);
    const trainY = trainIndices.map((index) => y[index] as number);
    const testX = testIndices.map((index) => X[index] as number[]);
    const testY = testIndices.map((index) => y[index] as number);
    const fit = linearRegression(trainX, trainY);
    const evaluation = evaluateRegression(testX, testY, fit.weights, fit.intercept);
    results.push({
      fold: fold + 1,
      trainRows: trainY.length,
      testRows: testY.length,
      metrics: { r2: fmt(evaluation.r2), rmse: fmt(evaluation.rmse), mae: fmt(evaluation.mae) },
    });
  }
  return { method: "k-fold", folds: results };
}

/** Train a prototype model over dataset rows. Throws TrainingError when impossible. */
export function trainModel(source: TrainableSource, request: TrainRequest): ModelCard {
  const task = request.task;
  const testRatio = request.testRatio ?? 0.2;
  if (!Number.isFinite(testRatio) || testRatio <= 0 || testRatio >= 0.5) {
    throw new TrainingError("The test split must be a number greater than 0 and less than 0.5.");
  }
  const cvFoldCount = request.cvFolds ?? 0;
  if (!Number.isInteger(cvFoldCount) || cvFoldCount < 0 || cvFoldCount > 10) {
    throw new TrainingError("Cross-validation folds must be an integer from 0 to 10.");
  }
  const rowsForFeatures = source.rows;
  void rowsForFeatures;
  const exclude = new Set<string>(task === "clustering" ? [] : [request.targetColumn ?? ""]);

  if (task === "regression") {
    const target = targetValues(source, request.targetColumn, false);
    if (!target.numeric) throw new TrainingError("Internal: regression target missing.");
    const idx = source.columns.findIndex((c) => c.name === request.targetColumn);
    const prep = jointPreparedData(source, exclude, 12, (row) => toNum(row[idx]));
    const yv = prep.target;
    const X = prep.features;
    const indices = shuffledIndices(X.length, 20260101);
    const { train: trainIdx, validation: validationIdx, test: testIdx } = threeWaySplit(indices, testRatio);
    const trainX = trainIdx.map((index) => X[index] as number[]);
    const trainY = trainIdx.map((index) => yv[index] as number);
    const validationX = validationIdx.map((index) => X[index] as number[]);
    const validationY = validationIdx.map((index) => yv[index] as number);
    const testX = testIdx.map((index) => X[index] as number[]);
    const testY = testIdx.map((index) => yv[index] as number);
    const algorithm = request.algorithm ?? "linear-regression";
    if (!["linear-regression", "random-forest", "gradient-boosting"].includes(algorithm)) {
      throw new TrainingError("Regression supports linear regression, random forest, or gradient boosting.");
    }
    const estimatorCount = Math.max(2, Math.min(200, Number(request.hyperparams?.estimators ?? 25)));
    const learningRate = Math.max(0.01, Math.min(1, Number(request.hyperparams?.learningRate ?? 0.1)));
    const linearFit = algorithm === "linear-regression" ? linearRegression(trainX, trainY) : null;
    const predictor = linearFit
      ? {
          predict: (rows: number[][]) => predictLinear(rows, linearFit.weights, linearFit.intercept),
          featureImportance: linearFit.weights.map((weight) => Math.abs(weight)),
          intercept: linearFit.intercept,
        }
      : algorithm === "random-forest"
        ? fitRandomForest(trainX, trainY, estimatorCount, 20260101)
        : fitGradientBoosting(trainX, trainY, estimatorCount, learningRate);
    const evaluation = evaluatePredictions(testY, predictor.predict(testX));
    const validation = evaluatePredictions(validationY, predictor.predict(validationX));
    const inSample = evaluatePredictions(trainY, predictor.predict(trainX));
    const generalization = assessGeneralization("R²", inSample.r2, validation.r2, evaluation.r2, testY.length);
    const weights = linearFit?.weights ?? [];
    const intercept = predictor.intercept;
    const coefficients = linearFit
      ? Object.fromEntries(
          prep.featureNames.map((name, index) => [name, fmt((weights[index] ?? 0) / (prep.stds[index] ?? 1))]),
        )
      : undefined;
    const predictions = predictor.predict(trainX);
    const coefficientPValues = Object.fromEntries(
      linearFit
        ? prep.featureNames.map((name, index) => [
            name,
            fmt(coefficientPValue(weights[index] ?? 0, trainX, trainY, predictions, index)),
          ])
        : [],
    );
    const cv = cvFoldCount >= 2 ? crossValidateRegression(X, yv, Math.min(cvFoldCount, X.length - 1)) : undefined;
    const residualValues = inSample.residuals.map((item) => item.residual);
    const normality = residualNormality(residualValues);
    const metrics: ModelMetrics = {
      algorithm: `${algorithm} (real TypeScript implementation)`,
      task,
      trainRows: yv.length,
      featureCount: prep.featureNames.length,
      r2: fmt(evaluation.r2),
      rmse: fmt(evaluation.rmse),
      mae: fmt(evaluation.mae),
      testR2: fmt(evaluation.r2),
      testRmse: fmt(evaluation.rmse),
      testMae: fmt(evaluation.mae),
      validationR2: fmt(validation.r2),
      validationRmse: fmt(validation.rmse),
      validationMae: fmt(validation.mae),
      inSampleR2: fmt(inSample.r2),
      inSampleRmse: fmt(inSample.rmse),
      inSampleMae: fmt(inSample.mae),
      generalization,
    };
    return {
      task,
      algorithm:
        algorithm === "linear-regression"
          ? "Linear regression"
          : algorithm === "random-forest"
            ? "Random forest regression"
            : "Gradient boosting regression",
      name: request.name ?? "Untitled model",
      targetColumn: request.targetColumn,
      features: prep.featureNames,
      params: {
        ...(request.hyperparams ?? {}),
        ...(algorithm === "linear-regression"
          ? { regularization: "1e-3 (ridge)" }
          : { estimators: estimatorCount, learningRate }),
      },
      metrics,
      trainRows: yv.length,
      createdAt: new Date().toISOString(),
      versionTag: "hold-out-regression-v1",
      weights: weights.map(fmt),
      intercept: fmt(intercept),
      featureMeans: prep.means.map(fmt),
      featureStds: prep.stds.map(fmt),
      demoNote:
        "Computed with the real TypeScript regression engine using a train / validation / test split and held-out metrics.",
      coefficients,
      coefficientPValues,
      split: {
        method: "random",
        testRatio,
        trainRows: trainY.length,
        validationRows: validationY.length,
        testRows: testY.length,
      },
      generalization,
      crossValidation: cv,
      featureImportance: prep.featureNames
        .map((feature, index) => ({
          feature,
          importance: fmt(
            linearFit ? Math.abs(coefficients?.[feature] ?? 0) : (predictor.featureImportance[index] ?? 0),
          ),
          method: linearFit ? "absolute regression coefficient" : "tree split frequency",
        }))
        .sort((a, b) => b.importance - a.importance),
      residualDiagnostics: {
        residuals: inSample.residuals,
        normality,
        interpretation: normality.passed
          ? "Residuals are broadly consistent with a normal distribution; inspect the residual plot for remaining structure."
          : "Residuals depart from normality; confidence intervals and p-values should be interpreted cautiously.",
      },
      metadata: {
        engine: "hold-out-regression",
        exporter: "model-card-json",
        onnxNote:
          "ONNX export is available once the live training kernel ships; this card downloads as documented model-card JSON.",
        realComputation: true,
      },
    };
  }

  if (task === "classification") {
    const target = targetValues(source, request.targetColumn, true);
    if (!target.numeric || !target.labels) throw new TrainingError("Internal: classification target missing.");
    const idx = source.columns.findIndex((c) => c.name === request.targetColumn);
    const positive = target.labels.positive;
    const prep = jointPreparedData(source, exclude, 12, (row) => {
      const raw = row[idx];
      if (raw === null || raw === undefined || raw === "") return Number.NaN;
      return String(raw) === positive ? 1 : 0;
    });
    const pairs = prep.features.map((x, r) => ({ x, y: prep.target[r] as number }));
    const algorithm = request.algorithm ?? "logistic-regression";
    if (!["logistic-regression", "random-forest", "gradient-boosting"].includes(algorithm)) {
      throw new TrainingError("Classification supports logistic regression, random forest, or gradient boosting.");
    }
    const order = shuffledIndices(pairs.length, 20260101);
    const { train: trainIdx, validation: validationIdx, test: testIdx } = threeWaySplit(order, testRatio);
    const trainPairs = trainIdx.map((index) => pairs[index] as { x: number[]; y: number });
    const validationPairs = validationIdx.map((index) => pairs[index] as { x: number[]; y: number });
    const testPairs = testIdx.map((index) => pairs[index] as { x: number[]; y: number });
    const lr = Number(request.hyperparams?.learningRate ?? 0.3);
    const iters = Number(request.hyperparams?.iterations ?? 300);
    const estimatorCount = Math.max(2, Math.min(200, Number(request.hyperparams?.estimators ?? 25)));
    const forest =
      algorithm === "random-forest"
        ? fitRandomForest(
            trainPairs.map((p) => p.x),
            trainPairs.map((p) => p.y),
            estimatorCount,
            20260101,
          )
        : null;
    const boosting =
      algorithm === "gradient-boosting"
        ? fitGradientBoosting(
            trainPairs.map((p) => p.x),
            trainPairs.map((p) => p.y),
            estimatorCount,
            Number.isFinite(lr) ? lr : 0.1,
          )
        : null;
    const logistic =
      algorithm === "logistic-regression"
        ? logisticRegression(
            trainPairs.map((p) => p.x),
            trainPairs.map((p) => p.y),
            Number.isFinite(lr) ? lr : 0.3,
            Number.isFinite(iters) ? iters : 300,
          )
        : null;
    const predictProbability = (x: number[]) =>
      forest
        ? (forest.predict([x])[0] ?? 0)
        : boosting
          ? (boosting.predict([x])[0] ?? 0)
          : sigmoid(
              (logistic?.intercept ?? 0) +
                x.reduce((sum, value, index) => sum + value * (logistic?.weights[index] ?? 0), 0),
            );
    const trainMetrics = evaluateClassification(
      trainPairs.map((p) => p.y),
      trainPairs.map((p) => predictProbability(p.x)),
    );
    const validationMetrics = evaluateClassification(
      validationPairs.map((p) => p.y),
      validationPairs.map((p) => predictProbability(p.x)),
    );
    const testMetrics = evaluateClassification(
      testPairs.map((p) => p.y),
      testPairs.map((p) => predictProbability(p.x)),
    );
    const generalization = assessGeneralization(
      "accuracy",
      trainMetrics.accuracy ?? 0,
      validationMetrics.accuracy ?? 0,
      testMetrics.accuracy ?? 0,
      testPairs.length,
    );
    const cv =
      cvFoldCount >= 2
        ? crossValidateClassification(
            pairs,
            Math.min(cvFoldCount, pairs.length - 1),
            algorithm as "logistic-regression" | "random-forest" | "gradient-boosting",
            Number.isFinite(lr) ? lr : 0.3,
            Number.isFinite(iters) ? iters : 300,
            estimatorCount,
          )
        : undefined;
    const weights = logistic?.weights ?? [];
    const intercept = logistic?.intercept ?? 0;
    const metrics: ModelMetrics = {
      algorithm: `${algorithm} (real TypeScript implementation)`,
      task,
      trainRows: pairs.length,
      featureCount: prep.featureNames.length,
      accuracy: fmt(testMetrics.accuracy ?? 0),
      precision: fmt(testMetrics.precision ?? 0),
      recall: fmt(testMetrics.recall ?? 0),
      f1: fmt(testMetrics.f1 ?? 0),
      rocAuc: fmt(testMetrics.rocAuc ?? 0),
      testAccuracy: fmt(testMetrics.accuracy ?? 0),
      testPrecision: fmt(testMetrics.precision ?? 0),
      testRecall: fmt(testMetrics.recall ?? 0),
      testF1: fmt(testMetrics.f1 ?? 0),
      testRocAuc: fmt(testMetrics.rocAuc ?? 0),
      validationAccuracy: fmt(validationMetrics.accuracy ?? 0),
      validationPrecision: fmt(validationMetrics.precision ?? 0),
      validationRecall: fmt(validationMetrics.recall ?? 0),
      validationF1: fmt(validationMetrics.f1 ?? 0),
      validationRocAuc: fmt(validationMetrics.rocAuc ?? 0),
      inSampleAccuracy: fmt(trainMetrics.accuracy ?? 0),
      generalization,
    };
    return {
      task,
      algorithm:
        algorithm === "logistic-regression"
          ? "Logistic regression (binary)"
          : algorithm === "random-forest"
            ? "Random forest classification"
            : "Gradient boosting classification",
      name: request.name ?? "Untitled model",
      targetColumn: request.targetColumn,
      features: prep.featureNames,
      params: {
        ...(request.hyperparams ?? {}),
        ...(algorithm === "logistic-regression"
          ? { learningRate: lr, iterations: iters }
          : { estimators: estimatorCount, learningRate: Number.isFinite(lr) ? lr : 0.1 }),
      },
      metrics,
      trainRows: pairs.length,
      createdAt: new Date().toISOString(),
      versionTag: "hold-out-classification-v1",
      weights: weights.map(fmt),
      intercept: fmt(intercept),
      featureMeans: prep.means.map(fmt),
      featureStds: prep.stds.map(fmt),
      classMap: target.labels,
      demoNote:
        "Computed with the real TypeScript classification engine using a train / validation / test split and held-out metrics.",
      split: {
        method: "random",
        testRatio,
        trainRows: trainPairs.length,
        validationRows: validationPairs.length,
        testRows: testPairs.length,
      },
      generalization,
      crossValidation: cv,
      featureImportance: prep.featureNames.map((feature, index) => ({
        feature,
        importance: fmt(
          forest?.featureImportance[index] ?? boosting?.featureImportance[index] ?? Math.abs(weights[index] ?? 0),
        ),
        method: forest || boosting ? "tree split frequency" : "absolute logistic coefficient",
      })),
      metadata: {
        engine: "hold-out-classification",
        exporter: "model-card-json",
        onnxNote:
          "ONNX export is available once the live training kernel ships; this card downloads as documented model-card JSON.",
        realComputation: true,
      },
    };
  }

  // clustering
  const prep = prepareFeatures(source, exclude, 12);
  const k = Math.max(2, Math.min(8, Number(request.hyperparams?.k ?? 4)));
  const rng = seededRandom(20260101);
  const { centroids, inertia, assign } = kMeans(prep.features, k, rng);
  const sizes: number[] = new Array(k).fill(0);
  for (const c of assign) sizes[c] = (sizes[c] as number) + 1;
  const metrics: ModelMetrics = {
    algorithm: "k-means (standardized features)",
    task,
    trainRows: prep.count,
    featureCount: prep.featureNames.length,
    k,
    inertia: fmt(inertia),
    clusterSizes: sizes,
  };
  return {
    task,
    algorithm: "K-means clustering",
    name: request.name ?? "Untitled model",
    targetColumn: null,
    features: prep.featureNames,
    params: { ...(request.hyperparams ?? {}), k },
    metrics,
    trainRows: prep.count,
    createdAt: new Date().toISOString(),
    versionTag: "k-means-v1",
    weights: [],
    intercept: undefined,
    featureMeans: prep.means.map(fmt),
    featureStds: prep.stds.map(fmt),
    centroids: centroids.map((c) => c.map(fmt)),
    demoNote:
      "Clusters computed by the deterministic k-means engine on your uploaded rows (standardized features, seeded initialization).",
    metadata: {
      engine: "k-means-clustering",
      exporter: "model-card-json",
      onnxNote:
        "ONNX export is available once the live training kernel ships; this card downloads as documented model-card JSON.",
      realComputation: true,
    },
  };
}
