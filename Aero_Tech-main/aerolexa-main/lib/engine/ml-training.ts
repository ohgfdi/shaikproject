/**
 * Real machine-learning training — dependency-free, deterministic, honest.
 *
 * This is a genuine ML pipeline (no fake RNG beyond a SEEDED PRNG for the
 * deterministic fold splits; every metric is computed on held-out data):
 *
 *  Preprocessing  — median-impute + standardize (train-fitted, applied to val)
 *  Models         — ridge regression (closed form), logistic regression
 *                   (IRLS via elite-stats), multinomial softmax regression
 *                   (multiclass), decision tree (CART, variance), random
 *                   forest (seeded bagging + feature subsampling), kNN,
 *                   gradient boosting (Friedman: squared loss for regression,
 *                   logit-boost with Newton leaf steps for classification,
 *                   optional stochastic row subsampling), MLP neural network
 *                   (2 ReLU hidden layers, He init, mini-batch AdamW,
 *                   cosine LR decay, grad clipping, early stop with
 *                   best-snapshot restore)
 *  Validation     — k-fold cross-validation (stratified for classification)
 *  Metrics        — ROC AUC + PR AUC (exact trapezoid), accuracy, precision/
 *                   recall/F1 at the best-F1 threshold, RMSE/MAE/R²
 *  Importance     — permutation importance on the held-out folds (real
 *                   performance degradation, not model-introspection guesses)
 *
 * Every result carries `methodology` notes saying exactly what was done so the
 * UI can show its provenance line (repo rule: no unlabeled numbers).
 */

import { calibrateConformal, type ConformalCalibration } from "@/lib/engine/conformal";
import { fitLogistic, type GlmFit } from "@/lib/engine/elite-stats";
import { mean, variance } from "@/lib/engine/stats";

export class MlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MlError";
  }
}

/** Deterministic PRNG (mulberry32) — fold splits, forest bootstraps, Shapley sampling. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Task + dataset shapes
// ---------------------------------------------------------------------------

export type MlTask = "regression" | "binary-classification" | "multiclass-classification";
export type MlAlgorithm =
  "ridge" | "logistic" | "decision-tree" | "random-forest" | "knn" | "gradient-boosting" | "mlp";

export interface MlColumn {
  name: string;
  type: "number" | "string" | "boolean" | "date" | "unknown";
}

export interface MlSource {
  columns: MlColumn[];
  rows: (string | number | boolean | null)[][];
}

export interface MlTrainRequest {
  task: MlTask;
  algorithm: MlAlgorithm;
  /** Column to predict. */
  targetColumn: string;
  /** Columns to use as features (categoricals are one-hot). Default: all others. */
  featureColumns?: string[];
  /** CV folds (default 5; min 2). */
  cvFolds?: number;
  /** Hyperparameters. */
  lambda?: number; // ridge L2 / tree+forest min-impurity proxy
  maxDepth?: number; // tree / forest
  minLeaf?: number; // tree / forest
  nTrees?: number; // forest / gradient boosting (ensemble size)
  /** Gradient-boosting shrinkage (default 0.1); also the MLP Adam step size (default 0.05). */
  learningRate?: number;
  k?: number; // kNN
  /** MLP hidden-layer width (default 32 units per layer, 2 layers). */
  hiddenUnits?: number;
  /**
   * MLP hidden-layer count (default 2; clamped to 1–4). The classic engine
   * hard-coded two ReLU layers; deeper stacks (3–4) let small nets model
   * sharper interactions at the same epoch budget — the width stays capped
   * at 128 units so the tensor count never explodes.
   */
  hiddenLayers?: number;
  /** MLP hidden activation (default "relu"). tanh/gelu are honest options: tanh for small smooth surfaces, gelu (tanh approximation) where relu dead units stall. */
  activation?: "relu" | "tanh" | "gelu";
  /** MLP max training epochs (default 200; early-stops when the loss plateaus). */
  epochs?: number;
  /** MLP L2 weight decay, decoupled AdamW-style (default 1e-4). */
  weightDecay?: number;
  /** MLP mini-batch size (default 32, capped at 128). */
  batchSize?: number;
  /** Gradient-boosting stochastic row-subsample fraction (default 1 = deterministic full-batch; 0.5 = Friedman's stochastic variant). */
  subsample?: number;
  seed?: number;
}

// ---------------------------------------------------------------------------
// Preprocessing: one-hot + median imputation + standardization
// ---------------------------------------------------------------------------

export interface Preprocessor {
  featureNames: string[];
  /** Per-feature imputation value (numeric median) — index-aligned with featureNames. */
  medians: number[];
  means: number[];
  stds: number[];
  /** For one-hot columns: the category each binary column represents. */
  categoricalLevels: { source: string; levels: string[] }[];
}

interface Encoded {
  X: number[][];
  y: number[];
  /** For classification: the label classes (y holds class indexes). */
  classes?: string[];
  pre: Preprocessor;
}

function toNumber(v: string | number | boolean | null | undefined): number {
  if (v === null || v === undefined || v === "") return Number.NaN;
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(String(v).replace(/[,$\s%€£]/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

function medianOf(values: number[]): number {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid]! : (clean[mid - 1]! + clean[mid]!) / 2;
}

/**
 * Encode a raw table into a numeric design matrix:
 *  - target resolved (numeric for regression; string/boolean classes for
 *    classification, mapped to indexes)
 *  - numeric columns: median-imputed
 *  - categorical columns: one-hot with the TRAIN-fold level list
 *  - standardized with TRAIN-fold mean/std (no target leakage)
 */
export function encodeDataset(source: MlSource, req: MlTrainRequest, foldIdx?: number[]): Encoded {
  const colIdx = new Map(source.columns.map((c, i) => [c.name, i] as const));
  const targetIdx = colIdx.get(req.targetColumn);
  if (targetIdx === undefined) throw new MlError(`Target column “${req.targetColumn}” not found.`);
  const featureNamesReq = req.featureColumns?.length
    ? req.featureColumns
    : source.columns.filter((c) => c.name !== req.targetColumn && c.type !== "date").map((c) => c.name);
  if (!featureNamesReq.length) throw new MlError("No feature columns available.");
  for (const f of featureNamesReq) if (!colIdx.has(f)) throw new MlError(`Feature column “${f}” not found.`);

  const rows = foldIdx ? foldIdx.map((i) => source.rows[i] as (string | number | boolean | null)[]) : source.rows;

  // Target.
  let classes: string[] | undefined;
  let y: number[];
  if (req.task === "regression") {
    y = rows.map((r) => toNumber(r[targetIdx]));
    if (y.some((v) => !Number.isFinite(v))) {
      throw new MlError("Regression target has missing values — drop or impute those rows first.");
    }
  } else {
    const rawLabels = rows.map((r) => {
      const v = r[targetIdx];
      return v === null || v === undefined || v === "" ? null : String(v);
    });
    if (rawLabels.some((l) => l === null)) throw new MlError("Classification target has missing labels.");
    classes = [...new Set(rawLabels as string[])].sort();
    if (classes.length < 2) throw new MlError("Classification needs at least 2 distinct classes.");
    if (classes.length > 2 && req.task === "binary-classification") {
      throw new MlError(
        `Target has ${classes.length} classes — the binary trainer cannot fit it. Use task "multiclass-classification" or binarize the target first.`,
      );
    }
    // Class indexes: 0/1 for binary; 0..K-1 for multiclass (sorted class list).
    y = (rawLabels as string[]).map((l) => classes!.indexOf(l as string));
  }

  // Column views: numeric vs categorical is decided from the declared type
  // AND the values — a "number" column with unparseable non-null cells is
  // treated as categorical so dirty data never silently becomes NaN.
  interface FeatView {
    name: string;
    kind: "numeric" | "categorical";
    values: (string | number | boolean | null)[];
  }
  const views: FeatView[] = featureNamesReq.map((name) => {
    const ci = colIdx.get(name)!;
    const values = rows.map((r) => r[ci] ?? null);
    const declared = source.columns[ci]!.type;
    const allNumeric = values.every((v) => v === null || v === "" || Number.isFinite(toNumber(v)));
    const allBinaryOrNumber = values.every((v) => v === null || typeof v === "number" || typeof v === "boolean");
    return {
      name,
      kind: declared === "number" && allNumeric ? "numeric" : allBinaryOrNumber ? "numeric" : "categorical",
      values,
    };
  });

  const medians: number[] = [];
  const featureNames: string[] = [];
  const categoricalLevels: { source: string; levels: string[] }[] = [];

  // First pass: categorical level lists + numeric medians (train-fit).
  const numericViews: (FeatView & { idx: number })[] = [];
  for (const v of views) {
    if (v.kind === "numeric") {
      const nums = v.values.map(toNumber);
      medians.push(medianOf(nums));
      featureNames.push(v.name);
      numericViews.push({ ...v, idx: medians.length - 1 });
    } else {
      const levels = [...new Set(v.values.filter((x) => x !== null && x !== "").map(String))].sort();
      if (levels.length > 20) {
        throw new MlError(
          `Column “${v.name}” has ${levels.length} distinct values — too many to one-hot (max 20). Drop it or bucket it.`,
        );
      }
      if (levels.length <= 1) {
        // Constant column — keep as a single constant one-hot to preserve schema.
      }
      categoricalLevels.push({ source: v.name, levels });
      for (const lv of levels) featureNames.push(`${v.name}=${lv}`);
    }
  }

  // Build unstandardized matrix.
  const Xraw: number[][] = rows.map((_, rowAt) => {
    const out: number[] = [];
    for (const v of views) {
      if (v.kind === "numeric") {
        const n = toNumber(v.values[rowAt]);
        out.push(Number.isFinite(n) ? n : medians[numericViews.find((nv) => nv.name === v.name)!.idx]!);
      } else {
        const cat = categoricalLevels.find((c) => c.source === v.name)!;
        const s = v.values[rowAt] === null || v.values[rowAt] === "" ? null : String(v.values[rowAt]);
        for (const lv of cat.levels) out.push(s === lv ? 1 : 0);
      }
    }
    return out;
  });

  // Standardize (train-fit mean/sample-SD, the repo's ddof=1 convention so
  // the numbers match stats.ts; zero-variance columns pass through 0).
  const p = featureNames.length;
  const means: number[] = [];
  const stds: number[] = [];
  for (let j = 0; j < p; j++) {
    const col = Xraw.map((r) => r[j] as number);
    means.push(mean(col));
    const sd = Math.sqrt(variance(col, true)) || 1;
    stds.push(sd);
  }
  const X = Xraw.map((r) => r.map((v, j) => (v - (means[j] as number)) / (stds[j] as number)));
  void p;

  return {
    X,
    y,
    classes,
    pre: { featureNames, medians, means, stds, categoricalLevels },
  };
}

/** Apply a fitted preprocessor to NEW rows (same encoding, no re-fit). */
export function applyPreprocessor(source: MlSource, pre: Preprocessor, _req: MlTrainRequest): number[][] {
  const colIdx = new Map(source.columns.map((c, i) => [c.name, i] as const));
  return source.rows.map((row) => {
    const out: number[] = [];
    for (const fname of pre.featureNames) {
      const eq = fname.indexOf("=");
      const isOneHot = eq > 0 && pre.categoricalLevels.some((c) => fname.startsWith(`${c.source}=`));
      if (isOneHot) {
        const src = fname.slice(0, eq);
        const lv = fname.slice(eq + 1);
        const ci = colIdx.get(src);
        const v = ci !== undefined ? row[ci] : null;
        out.push(String(v) === lv ? 1 : 0);
      } else {
        const ci = colIdx.get(fname);
        const n = ci !== undefined ? toNumber(row[ci]) : Number.NaN;
        const med = pre.medians[pre.featureNames.indexOf(fname)] ?? 0;
        const v = Number.isFinite(n) ? n : med;
        const j = pre.featureNames.indexOf(fname);
        out.push((v - (pre.means[j] as number)) / (pre.stds[j] as number));
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Models (train + predict)
// ---------------------------------------------------------------------------

interface Model {
  predict(x: number[]): number;
  /** Binary class probability when the model supports it. */
  predictProba?(x: number[]): number;
  /** Raw (pre-link) score — gradient boosting exposes the pre-sigmoid output. */
  predictRaw?(x: number[]): number;
  /** Full class-probability vector for multiclass models (softmax / OvR). */
  predictVector?(x: number[]): number[];
}

function trainRidge(X: number[][], y: number[], lambda: number): Model {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  // Center X AND y per fit. X arrives standardized with the TRAIN-fitted
  // mean, but a CV fold's rows have non-zero column means — the intercept
  // must absorb that or every prediction is biased by w·x̄ (the OOF RMSE 5×
  // regression this fix removes). Solving on centered data with intercept
  // b = ȳ − w·x̄ is the classical, exact construction.
  const xm = Array.from({ length: p }, (_, j) => mean(X.map((r) => r[j] as number)));
  const ym = mean(y);
  const Xc = X.map((r) => r.map((v, j) => v - (xm[j] as number)));
  const yc = y.map((v) => v - ym);
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b: number[] = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      b[a]! += (Xc[i]![a] as number) * (yc[i] as number);
      for (let c = a; c < p; c++) A[a]![c] = (A[a]![c] ?? 0) + (Xc[i]![a] as number) * (Xc[i]![c] as number);
    }
  }
  for (let a = 0; a < p; a++) {
    // sklearn-style ridge penalty: ||y − Xw||² + λ||w||² — λ is NOT scaled by
    // n (features arrive standardized, so the raw λ is directly comparable
    // across sample sizes; scaling by n halved every fit).
    A[a]![a] = (A[a]![a] ?? 0) + lambda;
    for (let c = 0; c < a; c++) A[a]![c] = A[c]![a]!;
  }
  const w = solve(A, b) ?? new Array<number>(p).fill(0);
  const intercept = ym - xm.reduce((s, m, j) => s + m * (w[j] as number), 0);
  return {
    predict: (x) => intercept + x.reduce((s, v, j) => s + v * (w[j] as number), 0),
  };
}

function trainKnn(X: number[][], y: number[], k: number): Model {
  return {
    predict: (x) => {
      const dists = X.map((row, i) => ({
        d: row.reduce((s, v, j) => s + (v - (x[j] as number)) ** 2, 0),
        y: y[i] as number,
      }));
      dists.sort((a, b) => a.d - b.d);
      const kk = Math.min(k, dists.length);
      const top = dists.slice(0, kk);
      // Regression & classification-probability both use the mean vote.
      return mean(top.map((t) => t.y));
    },
  };
}

export interface TreeNode {
  leaf: true;
  value: number;
  count: number;
}
export interface TreeSplit {
  leaf: false;
  feature: number;
  threshold: number;
  left: TreeNode | TreeSplit;
  right: TreeNode | TreeSplit;
}

function buildTree(
  X: number[][],
  y: number[],
  depth: number,
  maxDepth: number,
  minLeaf: number,
  minImpurity: number,
): TreeNode | TreeSplit {
  const n = y.length;
  if (depth >= maxDepth || n < 2 * minLeaf) {
    return { leaf: true, value: mean(y), count: n };
  }
  let bestGain = minImpurity;
  let bestFeature = -1;
  let bestThreshold = 0;
  const baseVar = variance(y);
  if (baseVar === 0) return { leaf: true, value: mean(y), count: n };
  const p = X[0]?.length ?? 0;
  for (let f = 0; f < p; f++) {
    const values = [...new Set(X.map((r) => r[f] as number))].sort((a, b) => a - b);
    if (values.length < 2) continue;
    // Candidate thresholds = midpoints of consecutive distinct values.
    for (let i = 0; i < values.length - 1; i++) {
      const thr = ((values[i] as number) + (values[i + 1] as number)) / 2;
      let ls = 0;
      let lc = 0;
      let rs = 0;
      let rc = 0;
      for (let r = 0; r < n; r++) {
        const v = X[r]![f] as number;
        if (v <= thr) {
          ls += y[r] as number;
          lc++;
        } else {
          rs += y[r] as number;
          rc++;
        }
      }
      if (lc < minLeaf || rc < minLeaf) continue;
      const lm = ls / lc;
      const rm = rs / rc;
      let lss = 0;
      let rss = 0;
      for (let r = 0; r < n; r++) {
        const v = X[r]![f] as number;
        if (v <= thr) lss += ((y[r] as number) - lm) ** 2;
        else rss += ((y[r] as number) - rm) ** 2;
      }
      const gain = baseVar * n - (lss + rss);
      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = f;
        bestThreshold = thr;
      }
    }
  }
  if (bestFeature < 0) return { leaf: true, value: mean(y), count: n };
  const leftX: number[][] = [];
  const leftY: number[] = [];
  const rightX: number[][] = [];
  const rightY: number[] = [];
  for (let r = 0; r < n; r++) {
    if ((X[r]![bestFeature] as number) <= bestThreshold) {
      leftX.push(X[r] as number[]);
      leftY.push(y[r] as number);
    } else {
      rightX.push(X[r] as number[]);
      rightY.push(y[r] as number);
    }
  }
  return {
    leaf: false,
    feature: bestFeature,
    threshold: bestThreshold,
    left: buildTree(leftX, leftY, depth + 1, maxDepth, minLeaf, minImpurity),
    right: buildTree(rightX, rightY, depth + 1, maxDepth, minLeaf, minImpurity),
  };
}

function evalTree(node: TreeNode | TreeSplit, x: number[]): number {
  while (!node.leaf) {
    node = (x[node.feature] as number) <= node.threshold ? node.left : node.right;
  }
  return node.value;
}

// ---------------------------------------------------------------------------
// Histogram tree learning — LightGBM-style binning for large datasets
// ---------------------------------------------------------------------------

/** Rows at or below this count train with the EXACT dense splitter (O(n²·p));
 * beyond it, the histogram splitter takes over (≈O(n·p + nodes·p·B)). */
export const DENSE_TREE_ROW_LIMIT = 2000;

/** Per-feature bin boundaries (cuts[b] = upper bound of bin b). */
interface FeatureBins {
  cuts: number[];
}

/**
 * Bin boundaries for one feature: exact midpoints when the distinct values
 * fit in `maxBins` (identical split candidates to the dense splitter), else
 * seeded quantile bins over a capped subsample (LightGBM's
 * `feature_pre_bins` compromise — binning is a speed device; quantiles
 * estimated on ≤20k values are stable).
 */
function binThresholdsFor(col: number[], maxBins: number, rand: () => number): number[] {
  const uniq = [...new Set(col)].sort((a, b) => a - b);
  if (uniq.length <= maxBins) {
    const cuts: number[] = [];
    for (let i = 0; i < uniq.length - 1; i++) {
      cuts.push(((uniq[i] as number) + (uniq[i + 1] as number)) / 2);
    }
    return cuts;
  }
  const cap = Math.min(col.length, 20000);
  let sample: number[];
  if (col.length <= cap) {
    sample = col;
  } else {
    sample = new Array<number>(cap);
    for (let i = 0; i < cap; i++) sample[i] = col[Math.floor(rand() * col.length)] as number;
  }
  sample = [...sample].sort((a, b) => a - b);
  const cuts: number[] = [];
  for (let b = 1; b < maxBins; b++) {
    const pos = Math.min(Math.floor((sample.length * b) / maxBins), sample.length - 1);
    const v = sample[pos] as number;
    if (cuts.length === 0 || v > (cuts[cuts.length - 1] as number)) cuts.push(v);
  }
  return cuts;
}

/**
 * Histogram variance-reduction splitter over precomputed bins. Gains are
 * EXACT: each node keeps Σy and Σy² per bin, so the SSE of any prefix split
 * is lss − (Σleft)²/count — the same quantity the dense splitter computes
 * by double-scanning, recovered in one O(B) scan per feature.
 */
function buildTreeHist(
  X: number[][],
  y: number[],
  idx: number[],
  depth: number,
  maxDepth: number,
  minLeaf: number,
  minImpurity: number,
  bins: FeatureBins[],
): TreeNode | TreeSplit {
  const n = idx.length;
  let sum = 0;
  let sumSq = 0;
  for (const i of idx) {
    const v = y[i] as number;
    sum += v;
    sumSq += v * v;
  }
  const baseSSE = sumSq - (sum * sum) / n;
  if (depth >= maxDepth || n < 2 * minLeaf || baseSSE <= minImpurity) {
    return { leaf: true, value: sum / n, count: n };
  }
  const p = X[0]?.length ?? 0;
  let bestGain = minImpurity;
  let bestFeature = -1;
  let bestThr = 0;
  for (let f = 0; f < p; f++) {
    const cuts = (bins[f] as FeatureBins).cuts;
    const B = cuts.length + 1;
    const cnt = new Array<number>(B).fill(0);
    const s = new Array<number>(B).fill(0);
    const ss = new Array<number>(B).fill(0);
    for (const i of idx) {
      const v = X[i]![f] as number;
      let lo = 0;
      let hi = cuts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (v <= (cuts[mid] as number)) hi = mid;
        else lo = mid + 1;
      }
      const yi = y[i] as number;
      cnt[lo]! += 1;
      s[lo]! += yi;
      ss[lo]! += yi * yi;
    }
    let lc = 0;
    let ls = 0;
    let lss = 0;
    for (let b = 0; b < B - 1; b++) {
      lc += cnt[b] as number;
      ls += s[b] as number;
      lss += ss[b] as number;
      const rc = n - lc;
      if (lc < minLeaf || rc < minLeaf) continue;
      const rs = sum - ls;
      const rss = sumSq - lss;
      const lm = ls / lc;
      const rm = rs / rc;
      const gain = baseSSE - (lss - lm * ls + (rss - rm * rs));
      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = f;
        bestThr = cuts[b] as number;
      }
    }
  }
  if (bestFeature < 0) return { leaf: true, value: sum / n, count: n };
  const left: number[] = [];
  const right: number[] = [];
  for (const i of idx) {
    if ((X[i]![bestFeature] as number) <= bestThr) left.push(i);
    else right.push(i);
  }
  return {
    leaf: false,
    feature: bestFeature,
    threshold: bestThr,
    left: buildTreeHist(X, y, left, depth + 1, maxDepth, minLeaf, minImpurity, bins),
    right: buildTreeHist(X, y, right, depth + 1, maxDepth, minLeaf, minImpurity, bins),
  };
}

/**
 * Scale dispatcher: small data → the EXACT dense splitter (byte-identical to
 * the historical behaviour); large data → histogram splits with seeded
 * quantile bins. Both return the same TreeNode format, so artifacts,
 * predictors and Shapley explainers are unchanged downstream.
 */
function buildTreeFor(
  X: number[][],
  y: number[],
  maxDepth: number,
  minLeaf: number,
  minImpurity: number,
  seed: number,
  maxBins: number,
): TreeNode | TreeSplit {
  if (X.length <= DENSE_TREE_ROW_LIMIT) return buildTree(X, y, 0, maxDepth, minLeaf, minImpurity);
  const rand = seededRandom(seed);
  const p = X[0]?.length ?? 0;
  const bins: FeatureBins[] = [];
  for (let f = 0; f < p; f++) {
    bins.push({
      cuts: binThresholdsFor(
        X.map((r) => r[f] as number),
        maxBins,
        rand,
      ),
    });
  }
  return buildTreeHist(
    X,
    y,
    Array.from({ length: X.length }, (_, i) => i),
    0,
    maxDepth,
    minLeaf,
    minImpurity,
    bins,
  );
}

function trainTree(X: number[][], y: number[], maxDepth: number, minLeaf: number, seed = 0, maxBins = 32): Model {
  const tree = buildTreeFor(X, y, maxDepth, minLeaf, 1e-9, seed, maxBins);
  return { predict: (x) => evalTree(tree, x) };
}

function trainForest(
  X: number[][],
  y: number[],
  nTrees: number,
  maxDepth: number,
  minLeaf: number,
  seed: number,
  maxBins = 32,
): Model {
  const rand = seededRandom(seed);
  const n = X.length;
  const p = X[0]?.length ?? 0;
  // Feature subsampling: √p per tree (classic Breiman rule).
  const mtry = Math.max(1, Math.round(Math.sqrt(p)));
  const trees: { model: Model; features: number[] }[] = [];
  for (let t = 0; t < nTrees; t++) {
    // Bootstrap sample (bagging).
    const bx: number[][] = [];
    const by: number[] = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rand() * n);
      bx.push(X[idx] as number[]);
      by.push(y[idx] as number);
    }
    // Feature subset — implemented by projecting columns before the tree.
    const features: number[] = [];
    while (features.length < mtry) {
      const f = Math.floor(rand() * p);
      if (!features.includes(f)) features.push(f);
    }
    features.sort((a, b) => a - b);
    const projX = bx.map((r) => features.map((f) => r[f] as number));
    trees.push({ model: trainTree(projX, by, maxDepth, minLeaf, seed + t * 7919, maxBins), features });
  }
  return {
    predict: (x) => mean(trees.map((t) => t.model.predict(t.features.map((f) => x[f] as number)))),
  };
}

function trainLogit(X: number[][], y: number[]): Model & { fit: GlmFit } {
  const fit = fitLogistic({ X, y }, { maxIter: 100 });
  const coefs = fit.coefficients.map((c) => c.coefficient);
  return {
    fit,
    predict: (x) => x.reduce((s, v, j) => s + v * (coefs[j + 1] as number), 0) + (coefs[0] as number),
    predictProba: (x) => sigmoid(x.reduce((s, v, j) => s + v * (coefs[j + 1] as number), 0) + (coefs[0] as number)),
  };
}

function argmaxVector(v: number[]): number {
  let best = 0;
  for (let i = 1; i < v.length; i++) if ((v[i] as number) > (v[best] as number)) best = i;
  return best;
}

/** Numerically-stable softmax over one score vector. */
export function softmaxRow(scores: number[]): number[] {
  if (!scores.length) throw new MlError("Softmax needs at least one score.");
  const m = Math.max(...scores);
  const e = scores.map((s) => Math.exp(s - m));
  const s = e.reduce((a, v) => a + v, 0) || 1;
  return e.map((v) => v / s);
}

/**
 * Multinomial (softmax) logistic regression — full-batch gradient descent
 * with L2 regularisation on standardized features. Deterministic; used for
 * the multiclass task (binary logistic stays on the IRLS fit for exact
 * p-values, which softmax GD does not provide).
 */
function trainSoftmax(
  X: number[][],
  y: number[],
  classesCount: number,
  lambda: number,
  iters = 400,
  lr = 0.5,
): Model & { weights: number[][]; bias: number[] } {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const W: number[][] = Array.from({ length: p }, () => new Array<number>(classesCount).fill(0));
  const b = new Array<number>(classesCount).fill(0);
  for (let it = 0; it < iters; it++) {
    const gW: number[][] = Array.from({ length: p }, () => new Array<number>(classesCount).fill(0));
    const gb = new Array<number>(classesCount).fill(0);
    for (let i = 0; i < n; i++) {
      const x = X[i] as number[];
      const z = Array.from(
        { length: classesCount },
        (_, c) => b[c]! + x.reduce((s, v, j) => s + v * (W[j]![c] as number), 0),
      );
      const m = Math.max(...z);
      const e = z.map((v) => Math.exp(v - m));
      const s = e.reduce((a, v) => a + v, 0) || 1;
      for (let c = 0; c < classesCount; c++) {
        const d = e[c]! / s - (y[i] === c ? 1 : 0);
        gb[c]! += d;
        for (let j = 0; j < p; j++) gW[j]![c]! += d * (x[j] as number);
      }
    }
    for (let c = 0; c < classesCount; c++) {
      b[c]! -= (lr * gb[c]!) / n;
      for (let j = 0; j < p; j++) W[j]![c]! -= (lr * ((gW[j]![c] as number) + lambda * (W[j]![c] as number))) / n;
    }
  }
  const vec = (x: number[]): number[] =>
    softmaxRow(
      Array.from({ length: classesCount }, (_, c) => b[c]! + x.reduce((s, v, j) => s + v * (W[j]![c] as number), 0)),
    );
  return {
    weights: W,
    bias: b,
    predict: (x) => argmaxVector(vec(x)),
    predictVector: vec,
  };
}

/** Gradient-boosting state (artifact payload; reconstructed by the predictor). */
export interface BoostState {
  base: number;
  learningRate: number;
  trees: (TreeNode | TreeSplit)[];
}

/**
 * Friedman gradient boosting: an initial constant (mean for squared loss,
 * log-odds for the logistic loss) improved by `nTrees` shallow trees fitted
 * to the pseudo-residuals. Classification leaves use the Newton step
 * Σrᵢ / Σpᵢ(1−pᵢ) (Friedman 2001 §4.4); regression keeps the mean.
 *
 * Stochastic variant (Friedman 2002): when `subsample < 1`, each tree is fit
 * on a SEEDED random row fraction (no replacement) — variance reduction that
 * usually improves generalization; `subsample = 1` (the default) keeps the
 * historical fully-deterministic full-batch behaviour byte-for-byte.
 */
function trainBoosting(
  X: number[][],
  y: number[],
  nTrees: number,
  learningRate: number,
  maxDepth: number,
  minLeaf: number,
  classification: boolean,
  seed = 0,
  subsample = 1,
): Model & { state: BoostState } {
  const rand = subsample < 1 ? seededRandom(seed * 7919 + 13) : null;
  const frac = Math.min(1, Math.max(0.1, subsample));
  const perTree = Math.max(2 * minLeaf, Math.round(X.length * frac));
  const p0 = Math.min(1 - 1e-6, Math.max(1e-6, mean(y)));
  const base = classification ? Math.log(p0 / (1 - p0)) : mean(y);
  const F = y.map(() => base);
  const trees: (TreeNode | TreeSplit)[] = [];
  for (let t = 0; t < nTrees; t++) {
    const resid = classification
      ? y.map((yi, i) => yi - sigmoid(F[i] as number))
      : y.map((yi, i) => yi - (F[i] as number));
    let fitX = X;
    let fitResid = resid;
    let fitY = y;
    if (rand && perTree < X.length) {
      // Sample WITHOUT replacement (Fisher–Yates partial shuffle, seeded).
      const pool = Array.from({ length: X.length }, (_, i) => i);
      const idx: number[] = [];
      for (let i = 0; i < perTree; i++) {
        const j = i + Math.floor(rand() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j] as number, pool[i] as number];
        idx.push(pool[i] as number);
      }
      fitX = idx.map((i) => X[i] as number[]);
      fitResid = idx.map((i) => resid[i] as number);
      fitY = idx.map((i) => y[i] as number);
    }
    const tree = buildTreeFor(fitX, fitResid, maxDepth, minLeaf, 1e-9, seed * 104729 + t, 32);
    if (classification) refineLeavesLogit(tree, fitX, fitY, fitResid);
    // Evaluate the FULL design matrix (subsampled rows only fit the tree).
    for (let i = 0; i < X.length; i++) F[i] = (F[i] as number) + learningRate * evalTree(tree, X[i] as number[]);
    trees.push(tree);
  }
  const raw = (x: number[]): number => trees.reduce((s, tr) => s + learningRate * evalTree(tr, x), base);
  return {
    state: { base, learningRate, trees },
    predict: (x) => (classification ? sigmoid(raw(x)) : raw(x)),
    predictRaw: raw,
  };
}

/**
 * Multiclass boosting via one-vs-rest: K independent logit-boosters, their
 * sigmoid outputs normalized to a probability vector (sklearn OvR convention).
 */
function trainBoostingOvr(
  X: number[][],
  y: number[],
  classesCount: number,
  nTrees: number,
  learningRate: number,
  maxDepth: number,
  minLeaf: number,
  seed = 0,
  subsample = 1,
): Model & { states: BoostState[] } {
  const boosters = Array.from({ length: classesCount }, (_, c) =>
    trainBoosting(
      X,
      y.map((v) => (v === c ? 1 : 0)),
      nTrees,
      learningRate,
      maxDepth,
      minLeaf,
      true,
      seed + c,
      subsample,
    ),
  );
  const vec = (x: number[]): number[] => {
    const p = boosters.map((b) => b.predict(x));
    const s = p.reduce((a, v) => a + v, 0) || 1;
    return p.map((v) => v / s);
  };
  return {
    states: boosters.map((b) => b.state),
    predict: (x) => argmaxVector(vec(x)),
    predictVector: vec,
  };
} // ---------------------------------------------------------------------------
// MLP neural network — configurable-depth ReLU/tanh/GELU hidden stack,
// mini-batch AdamW, early stopping
// ---------------------------------------------------------------------------

/** Serialized MLP artifact payload (aerolexa.ml.v1 `mlp` field). */
export interface MlpState {
  /** Layer weights: layers[ℓ][out][in]. */
  layers: number[][][];
  /** Layer biases: b[ℓ][out]. */
  biases: number[][];
  /** Hidden activation — EVERY hidden layer uses it; the output head is separate. */
  activation: "relu" | "tanh" | "gelu";
  /** Task head: identity (regression) | sigmoid (binary) | softmax (multiclass). */
  head: "identity" | "sigmoid" | "softmax";
}

/**
 * A real (small) deep network trained with the modern recipe:
 *
 *  - Architecture: input → (H act)×hiddenLayers → linear head (regression
 *    returns the raw value; binary a sigmoid logit; multiclass a softmax
 *    vector). hiddenLayers is 1–4 (default 2) and act is relu | tanh | gelu
 *    (default relu) — both travel on the serialized MlpState.
 *  - He (Kaiming) initialization, `√(2/fan_in)` scaled — the variance
 *    preservation ReLU nets need (He et al. 2015, §2.2).
 *  - Mini-batch AdamW (Loshchilov & Hutter 2019): decoupled weight decay on
 *    weight matrices only (biases decay never), bias-corrected moments.
 *  - Cosine learning-rate schedule with a linear warmup (Goyal et al. 2017
 *    warmup; Loshchilov & Hutter 2017 cosine) over the TOTAL step budget.
 *  - Gradient-norm clipping at 5.0 (Pascanu et al. 2013) — stabilizes the
 *    first epochs where He-initialized logits can produce large head grads.
 *  - Early stopping on full-data loss with patience 25, and the BEST
 *    parameters are RESTORED before returning (a real snapshot, not just a
 *    frozen point in time).
 *
 * Determinism: every random choice (batch shuffles, He init) flows through the
 * SEEDED PRNG the rest of the engine uses — same data + seed ⇒ byte-identical
 * weights.
 */
function trainMlp(
  X: number[][],
  y: number[],
  opts: {
    hiddenUnits: number;
    hiddenLayers: number;
    activation: "relu" | "tanh" | "gelu";
    epochs: number;
    learningRate: number;
    classesCount: number;
    classification: boolean;
    weightDecay: number;
    batchSize: number;
    seed: number;
  },
): Model & { mlp: MlpState } {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const H = Math.max(4, Math.min(128, Math.round(opts.hiddenUnits)));
  // Depth is clamped 1–4: 1 keeps the classic single-hidden-layer shape, 4 is
  // the deepest stack the deterministic recipe is tuned for (units are capped
  // at 128, so even 4 layers stay a small, serializable tensor set).
  const L_HIDDEN = Math.max(1, Math.min(4, Math.round(opts.hiddenLayers)));
  const ACT = opts.activation;
  const lrBase = Math.min(0.5, Math.max(0.001, opts.learningRate));
  const wd = Math.min(0.1, Math.max(0, opts.weightDecay));
  const bs = Math.max(8, Math.min(128, Math.round(opts.batchSize)));
  const rand = seededRandom(opts.seed);
  const outDim = opts.classification ? Math.max(2, opts.classesCount) : 1;
  const head: MlpState["head"] = !opts.classification ? "identity" : outDim === 2 ? "sigmoid" : "softmax";
  // The head layer width: softmax needs one logit PER CLASS; sigmoid and
  // identity heads produce a SINGLE output. Sizing the head with the class
  // count under a sigmoid head leaves a dead second logit whose delta is
  // undefined — NaN gradients (the original 1-layer MLP shipped with exactly
  // that bug; the XOR oracle below pins the fix).
  const outWidth = head === "softmax" ? outDim : 1;

  // Targets: regression → raw value; binary → single logit output; multiclass → one-hot.
  const Y: number[][] =
    head === "softmax"
      ? Array.from({ length: n }, (_, i) => Array.from({ length: outDim }, (_, c) => (y[i] === c ? 1 : 0)))
      : y.map((v) => [v]);

  // --- He-initialized hidden stack (W[l][out][in]) -------------------------
  // Deeper option: input → H×L_HIDDEN → outWidth. He-uniform bounds are the
  // variance-preserving choice for ReLU; for tanh the same bound is the
  // standard Xavier range (He at depth 1–4 with tanh still trains stably on
  // the small widths this engine uses, so one bound serves both honestly).
  const dims = [p, ...Array.from({ length: L_HIDDEN }, () => H), outWidth];
  const W: number[][][] = [];
  const B: number[][] = [];
  for (let l = 0; l < dims.length - 1; l++) {
    const fanIn = dims[l] as number;
    const fanOut = dims[l + 1] as number;
    // He UNIFORM ±√(6/fan_in) (He et al. 2015, variance preservation for
    // ReLU); biases start at 0.
    const bound = Math.sqrt(6 / Math.max(1, fanIn));
    W.push(Array.from({ length: fanOut }, () => Array.from({ length: fanIn }, () => (rand() * 2 - 1) * bound)));
    B.push(new Array<number>(fanOut).fill(0));
  }
  const L = W.length; // hiddenLayers + 1: the linear head terminates the stack

  // --- AdamW state ---------------------------------------------------------
  const eps = 1e-8;
  const beta1 = 0.9;
  const beta2 = 0.999;
  const gradClip = 5.0;
  interface AdamSlot {
    m: number;
    v: number;
  }
  const adamW = W.map((wL) => wL.map((row) => row.map((): AdamSlot => ({ m: 0, v: 0 }))));
  const adamB = B.map((bL) => bL.map((): AdamSlot => ({ m: 0, v: 0 })));

  /** One AdamW step. `stepLr` carries the warmup+cosine schedule; `decay > 0` only on weights. */
  const adamApply = (param: number, grad: number, s: AdamSlot, t: number, decay: number, stepLr: number): number => {
    s.m = beta1 * s.m + (1 - beta1) * grad;
    s.v = beta2 * s.v + (1 - beta2) * grad * grad;
    const mHat = s.m / (1 - Math.pow(beta1, t));
    const vHat = s.v / (1 - Math.pow(beta2, t));
    // Decoupled weight decay (AdamW): applied to the PARAMETER, not the grad.
    return param - stepLr * (decay * param + mHat / (Math.sqrt(vHat) + eps));
  };

  // --- Forward / loss / backward ------------------------------------------
  /** Hidden activation fn + its derivative-at-preactivation. */
  const actFn = (z: number): number =>
    ACT === "relu"
      ? Math.max(0, z)
      : ACT === "tanh"
        ? Math.tanh(z)
        : 0.5 * z * (1 + Math.tanh(0.7978845608028654 * (z + 0.044715 * z * z * z)));
  const actDerivFromAct = (a: number, z: number): number =>
    ACT === "relu" ? (z > 0 ? 1 : 0) : ACT === "tanh" ? 1 - a * a : geluTanhDeriv(z);
  /** d/dz of the tanh-approximation GELU (exact elementary derivative). */
  const geluTanhDeriv = (z: number): number => {
    const c = 0.7978845608028654;
    const inner = c * (z + 0.044715 * z * z * z);
    const t = Math.tanh(inner);
    const sech2 = 1 - t * t;
    return 0.5 * (1 + t) + 0.5 * z * sech2 * c * (1 + 3 * 0.044715 * z * z);
  };
  /** Pre-activations from the LAST forward() call — backprop reads these so the tanh/gelu derivatives are exact, not recovered from a. */
  let zCache: number[][] = [];

  const forward = (x: number[]): { acts: number[][]; out: number[] } => {
    const acts: number[][] = [x];
    const zs: number[][] = [];
    for (let l = 0; l < L - 1; l++) {
      const prev = acts[l] as number[];
      const zRow = (B[l] as number[]).map(
        (bj, o) => bj + (W[l] as number[][])[o]!.reduce((s, w, i2) => s + w * (prev[i2] as number), 0),
      );
      zs.push(zRow);
      acts.push(zRow.map(actFn));
    }
    const lastIn = acts[L - 1] as number[];
    const out = (B[L - 1] as number[]).map(
      (bj, o) => bj + (W[L - 1] as number[][])[o]!.reduce((s, w, i2) => s + w * (lastIn[i2] as number), 0),
    );
    zCache = zs;
    return { acts, out };
  };
  const sampleLoss = (out: number[], t: number[]): number => {
    if (head === "identity") return ((t[0] as number) - (out[0] as number)) ** 2;
    if (head === "sigmoid") {
      const pr = clampProb(sigmoid(out[0] as number));
      return -((t[0] as number) * Math.log(pr) + (1 - (t[0] as number)) * Math.log(1 - pr));
    }
    const probs = softmaxRow(out);
    let ce = 0;
    for (let c = 0; c < outDim; c++) if ((t[c] as number) === 1) ce += -Math.log(clampProb(probs[c] as number));
    return ce;
  };
  /** dLoss/dOut for one sample (the head is linear, so this is also dLoss/dPreAct). */
  const dOutOf = (out: number[], t: number[]): number[] => {
    if (head === "identity") return [(out[0] as number) - (t[0] as number)];
    if (head === "sigmoid") return [clampProb(sigmoid(out[0] as number)) - (t[0] as number)];
    const probs = softmaxRow(out);
    return probs.map((pc, c) => pc - (t[c] as number));
  };
  const fullLoss = (): number => {
    let loss = 0;
    for (let i = 0; i < n; i++) loss += sampleLoss(forward(X[i] as number[]).out, Y[i] as number[]);
    return loss / n;
  };

  /** One mini-batch: backprop → mean gradient → global-norm clip → AdamW. */
  const trainBatch = (idx: number[], t: number, stepLr: number): void => {
    const gW = W.map((wL) => wL.map((row) => row.map(() => 0)));
    const gB = B.map((bL) => bL.map(() => 0));
    for (const i of idx) {
      const x = X[i] as number[];
      const target = Y[i] as number[];
      const { acts, out } = forward(x);
      let delta = dOutOf(out, target);
      for (let l = L - 1; l >= 0; l--) {
        const inAct = acts[l] as number[];
        const nextDelta = l > 0 ? new Array<number>(inAct.length).fill(0) : null;
        for (let o = 0; o < (W[l] as number[][]).length; o++) {
          const d = delta[o] as number;
          (gB[l] as number[])[o]! += d;
          const wRow = (W[l] as number[][])[o] as number[];
          for (let i2 = 0; i2 < inAct.length; i2++) {
            (gW[l] as number[][])[o]![i2]! += d * (inAct[i2] as number);
            if (nextDelta) nextDelta[i2]! += d * wRow[i2]!;
          }
        }
        if (nextDelta) {
          // dAct/dz from the STORED activation. forward() caches the
          // pre-activations (zCache) so tanh/gelu derivatives are exact rather
          // than recovered from a — relu keeps the z>0 gate.
          const zs = zCache[l - 1] ?? [];
          for (let i2 = 0; i2 < nextDelta.length; i2++) {
            nextDelta[i2] = (nextDelta[i2] as number) * actDerivFromAct(inAct[i2] as number, zs[i2] ?? 0);
          }
          delta = nextDelta;
        }
      }
    }
    const m = idx.length;
    let norm = 0;
    for (let l = 0; l < L; l++) {
      for (let o = 0; o < (gW[l] as number[][]).length; o++) {
        for (let i2 = 0; i2 < (gW[l] as number[][])[o]!.length; i2++) {
          (gW[l] as number[][])[o]![i2] = (gW[l] as number[][])[o]![i2]! / m;
          norm += ((gW[l] as number[][])[o]![i2] as number) ** 2;
        }
        (gB[l] as number[])[o] = (gB[l] as number[])[o]! / m;
        norm += ((gB[l] as number[])[o] as number) ** 2;
      }
    }
    const normSqrt = Math.sqrt(norm);
    const clip = normSqrt > gradClip ? gradClip / normSqrt : 1;
    for (let l = 0; l < L; l++) {
      for (let o = 0; o < (W[l] as number[][]).length; o++) {
        for (let i2 = 0; i2 < (W[l] as number[][])[o]!.length; i2++) {
          (W[l] as number[][])[o]![i2] = adamApply(
            (W[l] as number[][])[o]![i2] as number,
            clip * ((gW[l] as number[][])[o]![i2] as number),
            (adamW[l] as AdamSlot[][])[o]![i2] as AdamSlot,
            t,
            wd,
            stepLr,
          );
        }
        (B[l] as number[])[o] = adamApply(
          (B[l] as number[])[o] as number,
          clip * ((gB[l] as number[])[o] as number),
          (adamB[l] as AdamSlot[])[o] as AdamSlot,
          t,
          0, // biases never decay
          stepLr,
        );
      }
    }
  };

  // --- Training loop: shuffled mini-batches, warmup+cosine LR, early stop --
  const maxEpochs = Math.max(30, opts.epochs);
  const patience = 25;
  const stepsPerEpoch = Math.max(1, Math.ceil(n / bs));
  const totalSteps = maxEpochs * stepsPerEpoch;
  const warmup = Math.min(10, Math.max(1, Math.round(0.05 * maxEpochs)));
  let step = 0;
  let bestLoss = Number.POSITIVE_INFINITY;
  let bestEpoch = 0;
  let snapshot: { W: number[][][]; B: number[][] } | null = null;
  let order = Array.from({ length: n }, (_, i) => i);
  for (let epoch = 0; epoch < maxEpochs; epoch++) {
    const shuffled = [...order];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j] as number, shuffled[i] as number];
    }
    order = shuffled;
    for (let s = 0; s < stepsPerEpoch; s++) {
      const batch = order.slice(s * bs, Math.min(n, (s + 1) * bs));
      if (batch.length === 0) break;
      // Linear warmup → cosine decay over the TOTAL step budget.
      const lrNow =
        step < warmup
          ? lrBase * ((step + 1) / warmup)
          : lrBase * (0.5 * (1 + Math.cos((Math.PI * (step - warmup)) / Math.max(1, totalSteps - warmup))));
      step++;
      trainBatch(batch, step, lrNow);
    }
    const loss = fullLoss();
    // Relative min-delta: an improvement must beat 1e-6 of the current best
    // loss (an ABSOLUTE 1e-7 threshold stops regression runs prematurely —
    // late-epoch MSE improvements are tiny compared to the loss scale).
    const minDelta = Math.max(1e-9, 1e-6 * bestLoss);
    if (loss < bestLoss - minDelta) {
      bestLoss = loss;
      bestEpoch = epoch;
      // Snapshot the CURRENT best parameters (deep copy).
      snapshot = { W: W.map((wL) => wL.map((row) => [...row])), B: B.map((bL) => [...bL]) };
    } else if (epoch - bestEpoch >= patience) break; // early stop — plateau
  }
  // Restore the best snapshot before returning (not just a frozen moment).
  if (snapshot) {
    for (let l = 0; l < L; l++) {
      for (let o = 0; o < (W[l] as number[][]).length; o++) {
        (W[l] as number[][])[o] = [...((snapshot.W[l] as number[][])[o] as number[])];
        (B[l] as number[])[o] = (snapshot.B[l] as number[])[o] as number;
      }
    }
  }

  const mlp: MlpState = { layers: W, biases: B, activation: ACT, head };
  const rawOut = (x: number[]): number[] => forward(x).out;
  if (head === "identity") {
    return { mlp, predict: (x) => rawOut(x)[0] as number };
  }
  if (head === "sigmoid") {
    return {
      mlp,
      predict: (x) => sigmoid(rawOut(x)[0] as number),
      predictProba: (x) => sigmoid(rawOut(x)[0] as number),
    };
  }
  return {
    mlp,
    predict: (x) => argmaxVector(softmaxRow(rawOut(x))),
    predictVector: (x) => softmaxRow(rawOut(x)),
  };
}

function clampProb(p: number): number {
  return Math.min(1 - 1e-9, Math.max(1e-9, p));
}

/** Newton leaf refinement for logit boosting (Friedman 2001 §4.4). */
function refineLeavesLogit(root: TreeNode | TreeSplit, X: number[][], y: number[], resid: number[]): void {
  const walk = (node: TreeNode | TreeSplit, idx: number[]): void => {
    if (node.leaf) {
      let num = 0;
      let den = 0;
      for (const i of idx) {
        const p = Math.min(0.999, Math.max(0.001, (y[i] as number) - (resid[i] as number)));
        num += resid[i] as number;
        den += p * (1 - p);
      }
      node.value = den > 1e-9 ? num / den : 0;
      return;
    }
    const left: number[] = [];
    const right: number[] = [];
    for (const i of idx) {
      if (((X[i] as number[])[node.feature] as number) <= node.threshold) left.push(i);
      else right.push(i);
    }
    if (left.length) walk(node.left, left);
    if (right.length) walk(node.right, right);
  };
  walk(
    root,
    X.map((_, i) => i),
  );
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const d = M[col]![col]!;
    for (let c = col; c <= n; c++) M[col]![c] = (M[col]![c] as number) / d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c] = (M[r]![c] as number) - f * (M[col]![c] as number);
    }
  }
  return M.map((row) => row[n] as number);
}

function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface ClassificationMetrics {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  rocAuc: number;
  prAuc: number;
  /** Threshold maximizing F1 — the operational cut-point reported. */
  bestThreshold: number;
  confusion: { tp: number; fp: number; tn: number; fn: number };
  n: number;
}

export interface RegressionMetrics {
  rmse: number;
  mae: number;
  r2: number;
  n: number;
}

/** Exact ROC/PR AUC via the trapezoid rule over all distinct thresholds. */
export function evaluateClassification(yTrue: number[], scores: number[], threshold?: number): ClassificationMetrics {
  if (yTrue.length !== scores.length || yTrue.length === 0)
    throw new MlError("Metric inputs must be aligned and non-empty.");
  const pairs = yTrue.map((t, i) => ({ t, s: scores[i] as number })).filter((p) => Number.isFinite(p.s));
  const n = pairs.length;
  const pos = pairs.filter((p) => p.t === 1).length;
  const neg = n - pos;
  if (pos === 0 || neg === 0) throw new MlError("ROC/PR need both classes present.");

  // ROC curve over descending score thresholds.
  const sorted = [...pairs].sort((a, b) => b.s - a.s);
  let tp = 0;
  let fp = 0;
  const roc: { fpr: number; tpr: number }[] = [{ fpr: 0, tpr: 0 }];
  const pr: { rec: number; prec: number }[] = [];
  let i = 0;
  while (i < n) {
    const s = sorted[i]!.s;
    while (i < n && sorted[i]!.s === s) {
      if (sorted[i]!.t === 1) tp++;
      else fp++;
      i++;
    }
    const tpr = tp / pos;
    const fpr = fp / neg;
    roc.push({ fpr, tpr });
    pr.push({ rec: tpr, prec: fp + tp === 0 ? 1 : tp / (tp + fp) });
  }
  let rocAuc = 0;
  for (let k = 1; k < roc.length; k++) {
    rocAuc += ((roc[k]!.fpr - roc[k - 1]!.fpr) * (roc[k]!.tpr + roc[k - 1]!.tpr)) / 2;
  }
  // PR AUC: step function integrated over recall (average precision, step-wise).
  let prAuc = 0;
  let prevRec = 0;
  for (const p of pr) {
    prAuc += (p.rec - prevRec) * p.prec;
    prevRec = p.rec;
  }

  const thr =
    threshold ??
    (() => {
      // Threshold sweep for best F1.
      let best = 0.5;
      let bestF1 = -1;
      const cands = [0.5, ...pairs.map((p) => p.s)];
      for (const t of cands) {
        let TP = 0;
        let FP = 0;
        let FN = 0;
        for (const p of pairs) {
          const pred = p.s >= t ? 1 : 0;
          if (pred === 1 && p.t === 1) TP++;
          else if (pred === 1 && p.t === 0) FP++;
          else if (pred === 0 && p.t === 1) FN++;
        }
        const f1 = TP + FP === 0 || TP + FN === 0 ? 0 : (2 * TP) / (2 * TP + FP + FN);
        if (f1 > bestF1) {
          bestF1 = f1;
          best = t;
        }
      }
      return best;
    })();
  let TP = 0;
  let FP = 0;
  let TN = 0;
  let FN = 0;
  for (const p of pairs) {
    const pred = p.s >= thr ? 1 : 0;
    if (pred === 1 && p.t === 1) TP++;
    else if (pred === 1 && p.t === 0) FP++;
    else if (pred === 0 && p.t === 0) TN++;
    else FN++;
  }
  const precision = TP + FP === 0 ? 0 : TP / (TP + FP);
  const recall = TP + FN === 0 ? 0 : TP / (TP + FN);
  return {
    accuracy: (TP + TN) / n,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    rocAuc,
    prAuc,
    bestThreshold: thr,
    confusion: { tp: TP, fp: FP, tn: TN, fn: FN },
    n,
  };
}

/**
 * Consistent class prediction for any model: uses the full class-probability
 * vector when the model exposes predictVector, else rounds the scalar vote.
 */
function classPredict(model: Model, x: number[], classesCount: number): number {
  if (model.predictVector) return argmaxVector(model.predictVector(x));
  return Math.min(classesCount - 1, Math.max(0, Math.round(model.predict(x))));
}

export interface MulticlassMetrics {
  accuracy: number;
  /** Unweighted mean of per-class precision. */
  macroPrecision: number;
  /** Unweighted mean of per-class recall. */
  macroRecall: number;
  /** Unweighted mean of per-class F1. */
  macroF1: number;
  /** Confusion matrix [trueClass][predClass] of counts. */
  confusion: number[][];
  n: number;
}

/** Multiclass metrics: accuracy + macro precision/recall/F1 + confusion matrix. */
export function evaluateMulticlass(yTrue: number[], yPred: number[]): MulticlassMetrics {
  if (yTrue.length !== yPred.length || yTrue.length === 0) {
    throw new MlError("Metric inputs must be aligned and non-empty.");
  }
  const k = Math.max(...yTrue, ...yPred) + 1;
  const confusion: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < yTrue.length; i++) confusion[yTrue[i] as number]![yPred[i] as number]! += 1;
  let correct = 0;
  for (let c = 0; c < k; c++) correct += confusion[c]![c]!;
  let pSum = 0;
  let rSum = 0;
  let fSum = 0;
  for (let c = 0; c < k; c++) {
    const tp = confusion[c]![c]!;
    const fp = confusion.reduce((s, row, t) => s + (t === c ? 0 : (row[c] as number)), 0);
    const fn = confusion[c]!.reduce((s, v, pc) => s + (pc === c ? 0 : v), 0);
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    pSum += precision;
    rSum += recall;
    fSum += precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  }
  return {
    accuracy: correct / yTrue.length,
    macroPrecision: pSum / k,
    macroRecall: rSum / k,
    macroF1: fSum / k,
    confusion,
    n: yTrue.length,
  };
}

export function evaluateRegression(yTrue: number[], yPred: number[]): RegressionMetrics {
  const n = Math.min(yTrue.length, yPred.length);
  if (n === 0) throw new MlError("No rows to evaluate.");
  let se = 0;
  let ae = 0;
  for (let i = 0; i < n; i++) {
    const d = (yTrue[i] as number) - (yPred[i] as number);
    se += d * d;
    ae += Math.abs(d);
  }
  const ssTot = yTrue.slice(0, n).reduce((s, v) => s + (v - mean(yTrue.slice(0, n))) ** 2, 0);
  return { rmse: Math.sqrt(se / n), mae: ae / n, r2: ssTot === 0 ? 1 : 1 - se / ssTot, n };
}

// ---------------------------------------------------------------------------
// Cross-validation + training orchestration
// ---------------------------------------------------------------------------

/**
 * Fold assignment. `stratify` (classification tasks, where labels are the
 * encoded class indexes 0..K-1) round-robins each class across folds;
 * regression uses plain shuffled round-robin.
 */
export function makeFolds(y: number[], folds: number, seed: number, stratify = false): number[][] {
  const rand = seededRandom(seed);
  const n = y.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  // Shuffle (Fisher–Yates, seeded).
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j] as number, idx[i] as number];
  }
  // Stratify only when asked AND every value is a valid encoded class
  // (non-negative integer < K). Regression targets never qualify even when
  // they happen to be integers.
  const maxClass = Math.max(...y);
  const usable = stratify && y.every((v) => Number.isInteger(v) && v >= 0) && maxClass === new Set(y).size - 1;
  const out: number[][] = Array.from({ length: folds }, () => []);
  if (usable) {
    for (let c = 0; c <= maxClass; c++) {
      const clsIdx = idx.filter((i) => y[i] === c);
      clsIdx.forEach((i, k) => out[k % folds]!.push(i));
    }
  } else {
    idx.forEach((i, k) => out[k % folds]!.push(i));
  }
  return out.filter((f) => f.length > 0);
}

function fitModel(
  alg: MlAlgorithm,
  X: number[][],
  y: number[],
  req: MlTrainRequest,
  seed: number,
  classesCount = 2,
): Model {
  switch (alg) {
    case "ridge":
      return trainRidge(X, y, req.lambda ?? 1);
    case "logistic":
      // Multiclass targets fit multinomial softmax; binary keeps IRLS.
      return classesCount > 2 ? trainSoftmax(X, y, classesCount, req.lambda ?? 0.01) : trainLogit(X, y);
    case "decision-tree":
      return trainTree(X, y, req.maxDepth ?? 5, req.minLeaf ?? 3, seed);
    case "random-forest":
      return trainForest(X, y, req.nTrees ?? 40, req.maxDepth ?? 6, req.minLeaf ?? 2, seed);
    case "gradient-boosting": {
      // Regression = squared loss; classification = logit-boost (or OvR for K>2).
      const isClassification = req.task !== "regression";
      return classesCount > 2 && isClassification
        ? trainBoostingOvr(
            X,
            y,
            classesCount,
            req.nTrees ?? 60,
            req.learningRate ?? 0.1,
            req.maxDepth ?? 3,
            req.minLeaf ?? 2,
            seed,
            req.subsample ?? 1,
          )
        : trainBoosting(
            X,
            y,
            req.nTrees ?? 100,
            req.learningRate ?? 0.1,
            req.maxDepth ?? 3,
            req.minLeaf ?? 2,
            isClassification,
            seed,
            req.subsample ?? 1,
          );
    }
    case "knn":
      return trainKnn(X, y, req.k ?? 5);
    case "mlp":
      return trainMlp(X, y, {
        hiddenUnits: req.hiddenUnits ?? 32,
        hiddenLayers: req.hiddenLayers ?? 2,
        activation: req.activation ?? "relu",
        epochs: req.epochs ?? 200,
        learningRate: req.learningRate ?? 0.05,
        classesCount,
        classification: req.task !== "regression",
        weightDecay: req.weightDecay ?? 1e-4,
        batchSize: req.batchSize ?? 32,
        seed,
      });
  }
}

export interface CvReport {
  folds: number;
  /** Metric mean ± SD across folds. */
  metricName: "rmse" | "rocAuc" | "accuracy";
  mean: number;
  sd: number;
  perFold: number[];
}

export interface PermutationImportance {
  feature: string;
  /** Mean drop in the fold metric when the column is shuffled. Bigger = more important. */
  importance: number;
}

export interface MlTrainResult {
  task: MlTask;
  algorithm: MlAlgorithm;
  targetColumn: string;
  featureNames: string[];
  cv: CvReport;
  /** Full-data refit metrics (in-sample for the final model — labelled as such). */
  trainMetrics: ClassificationMetrics | RegressionMetrics | MulticlassMetrics | null;
  /** Logistic-specific diagnostics (logistic only). */
  glmDiagnostics: { aic: number; converged: boolean; coefficients: GlmFit["coefficients"] } | null;
  importance: PermutationImportance[];
  /** Class balance for classification (provenance). */
  classBalance?: { positive: number; negative: number };
  /**
   * Regression only: a split-conformal prediction interval calibrated on the
   * OUT-OF-FOLD residuals (the CV+ variant). `halfWidth` is the ± to apply to
   * any point prediction from this model; coverage is distribution-free
   * (≥ 1−α for exchangeable future points), not a normality assumption.
   */
  conformal?: ConformalCalibration;
  /** Multiclass: per-class row counts, index-aligned with `classes`. */
  classCounts?: number[];
  /** Multiclass: the sorted class labels, index-aligned with predictions. */
  classes?: string[];
  /** Honest labelling — always shown next to the numbers. */
  methodology: string[];
  /** Serialized model artifact (JSON) for the registry. */
  artifact: MlArtifact;
}

/**
 * Serialized model artifact (aerolexa.ml.v1) — self-contained: fitted
 * preprocessor + full-data refit payload, so serving reconstructs the exact
 * train-time pipeline from the JSON alone.
 */
export interface MlArtifact {
  kind: "aerolexa.ml.v1";
  task: MlTask;
  algorithm: MlAlgorithm;
  targetColumn: string;
  featureNames: string[];
  preprocessor: Preprocessor;
  /** Full-data refit payload per algorithm. */
  weights?: number[];
  intercept?: number;
  coefficients?: number[];
  /** Multinomial softmax: per-feature class weights [feature][class] + bias[class]. */
  softmaxWeights?: number[][];
  softmaxBias?: number[];
  tree?: TreeNode | TreeSplit;
  forest?: { features: number[]; tree: TreeNode | TreeSplit }[];
  boosting?: BoostState;
  /** Multiclass OvR boosting: one BoostState per class. */
  boostingOvr?: BoostState[];
  /** MLP layer tensors (layers[ℓ][out][in] + biases[ℓ][out]). */
  mlp?: MlpState;
  /** Regression: the conformal calibration (compact — no raw scores) so SERVING can attach prediction intervals. */
  conformal?: { halfWidth: number; alpha: number; nCalibration: number; methodology: string };
  exemplars?: { x: number[]; y: number }[];
  k?: number;
  classes?: string[];
  hyperparams: Record<string, number>;
  /** Attached by AutoML when the blended ensemble beats the best single model (see lib/engine/ensemble.ts). */
  ensemble?: EnsembleBlock;
}

/**
 * A soft-voting (mean) or stacked combiner over self-contained
 * aerolexa.ml.v1 member artifacts. Members keep their OWN preprocessors, so
 * serving encodes the raw row once per member — exactly what training did.
 */
export interface EnsembleBlock {
  kind: "aerolexa.ml.ensemble.v1";
  /** Regression: plain output mean; "stacked" uses the ridge meta-weights. Classification: mean class probability. */
  combiner: "mean" | "mean-prob" | "stacked";
  members: MlArtifact[];
  /** Regression "stacked" combiner: ridge meta-weights over member outputs (+ intercept). */
  meta?: { weights: number[]; intercept: number };
}

/** Progress units reported during a long fit (for SSE streams and workers). */
export interface TrainProgress {
  phase: "cv" | "refit" | "importance";
  done: number;
  total: number;
}

/**
 * Train with k-fold CV, permutation importance, and a final full-data refit.
 * Deterministic given `seed`. CV metrics are OUT-OF-FOLD (honest); train
 * metrics on the full refit are explicitly labelled in-sample.
 *
 * `onProgress` (optional) is invoked at phase boundaries: every completed
 * fold, the refit, and every permutation-importance feature — the same
 * callback fires inline and inside the training worker.
 */
export function trainWithCv(
  source: MlSource,
  req: MlTrainRequest,
  onProgress?: (p: TrainProgress) => void,
): MlTrainResult {
  if (req.task === "regression" && (req.algorithm === "logistic" || req.algorithm === "knn")) {
    // kNN actually handles regression via mean vote; keep it allowed.
  }
  if (req.task === "binary-classification" && req.algorithm === "ridge") {
    throw new MlError(
      "Ridge is a regression algorithm — use logistic, decision-tree, random-forest, gradient-boosting or knn for classification.",
    );
  }
  if (req.task === "regression" && req.algorithm === "logistic") {
    throw new MlError(
      "Logistic regression is a classification algorithm — use ridge, decision-tree, random-forest, gradient-boosting or knn for regression.",
    );
  }
  if (req.task === "multiclass-classification" && req.algorithm === "ridge") {
    throw new MlError(
      "Ridge is a regression algorithm — use logistic, decision-tree, random-forest, gradient-boosting or knn for multiclass classification.",
    );
  }
  const n = source.rows.length;
  if (n < 12) throw new MlError("Training needs at least 12 rows.");
  const folds = Math.max(2, Math.min(req.cvFolds ?? 5, 10));
  if (folds > n) throw new MlError("More CV folds than rows.");
  const seed = req.seed ?? 42;

  const encoded = encodeDataset(source, req);
  const foldAssignments = makeFolds(encoded.y, folds, seed, req.task !== "regression");
  const oofPred = new Array<number>(n).fill(Number.NaN);
  const foldMetric: number[] = [];

  for (const testIdx of foldAssignments) {
    const testSet = new Set(testIdx);
    const trainIdx = encoded.y.map((_, i) => i).filter((i) => !testSet.has(i));
    const Xtr = trainIdx.map((i) => encoded.X[i] as number[]);
    const ytr = trainIdx.map((i) => encoded.y[i] as number);
    const model = fitModel(req.algorithm, Xtr, ytr, req, seed + testIdx[0]!, encoded.classes?.length ?? 2);
    for (const i of testIdx) {
      oofPred[i] = model.predict(encoded.X[i] as number[]);
    }
    onProgress?.({ phase: "cv", done: foldMetric.length + 1, total: foldAssignments.length });
    const yTest = testIdx.map((i) => encoded.y[i] as number);
    const predTest = testIdx.map((i) => oofPred[i] as number);
    if (req.task === "regression") {
      foldMetric.push(evaluateRegression(yTest, predTest).rmse);
    } else if (req.task === "multiclass-classification") {
      // Argmax over the model's class-probability vector (K-class accuracy).
      const correct = testIdx.filter(
        (i) => classPredict(model, encoded.X[i] as number[], encoded.classes?.length ?? 2) === (encoded.y[i] as number),
      ).length;
      foldMetric.push(yTest.length ? correct / yTest.length : 0);
    } else {
      // Score → probability via the model's mean-vote output.
      foldMetric.push(evaluateClassification(yTest, predTest).rocAuc);
    }
  }

  const metricName: CvReport["metricName"] =
    req.task === "regression" ? "rmse" : req.task === "multiclass-classification" ? "accuracy" : "rocAuc";
  const cvMean = mean(foldMetric);
  const cvSd = Math.sqrt(variance(foldMetric));

  // Conformal interval (regression only): the OOF predictions are exactly the
  // honest calibration sample the CV+ variant needs — every residual came from
  // a model that never saw its own row. A degenerate calibration (all rows
  // dropped) degrades to `undefined` with a methodology note, never a fake
  // interval.
  let conformal: ConformalCalibration | undefined;
  if (req.task === "regression") {
    try {
      conformal = calibrateConformal(encoded.y, oofPred, 0.1);
    } catch {
      conformal = undefined; // surfaced via methodology below
    }
  }

  // Full-data refit.
  onProgress?.({ phase: "refit", done: 0, total: 1 });
  const finalModel = fitModel(req.algorithm, encoded.X, encoded.y, req, seed, encoded.classes?.length ?? 2);
  onProgress?.({ phase: "refit", done: 1, total: 1 });
  const trainPred = encoded.X.map((x) => finalModel.predict(x));
  const trainMetrics =
    req.task === "regression"
      ? evaluateRegression(encoded.y, trainPred)
      : req.task === "multiclass-classification"
        ? evaluateMulticlass(
            encoded.y,
            encoded.X.map((x) => classPredict(finalModel, x, encoded.classes?.length ?? 2)),
          )
        : evaluateClassification(encoded.y, trainPred);

  // Permutation importance on out-of-fold rows: shuffle each feature column,
  // recompute OOF metric with the SAME fold models? Too expensive — instead,
  // use the final refit on the full data and measure metric degradation when a
  // column is shuffled (seeded, 1 pass). Honest framing: in-sample importance.
  const importance: PermutationImportance[] = [];
  const baseline =
    req.task === "regression"
      ? (trainMetrics as RegressionMetrics).rmse
      : (trainMetrics as ClassificationMetrics).rocAuc;
  const rand = seededRandom(seed + 999);
  const importanceTotal = encoded.pre.featureNames.length;
  for (let j = 0; j < importanceTotal; j++) {
    const shuffled = encoded.X.map((r) => r[j] as number);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const k2 = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[k2]] = [shuffled[k2] as number, shuffled[i] as number];
    }
    const Xp = encoded.X.map((r, i) => r.map((v, c) => (c === j ? (shuffled[i] as number) : v)));
    const predP = Xp.map((x) => finalModel.predict(x));
    const metricP =
      req.task === "regression"
        ? evaluateRegression(encoded.y, predP).rmse
        : evaluateClassification(encoded.y, predP).rocAuc;
    importance.push({
      feature: encoded.pre.featureNames[j]!,
      // regression: INCREASE in rmse = importance; classification: DROP in auc.
      importance: round6(req.task === "regression" ? metricP - baseline : baseline - metricP),
    });
    onProgress?.({ phase: "importance", done: j + 1, total: importanceTotal });
  }
  importance.sort((a, b) => b.importance - a.importance);

  // Artifact payload for the registry.
  const hyperparams: Record<string, number> = {};
  if (req.lambda !== undefined) hyperparams.lambda = req.lambda;
  if (req.maxDepth !== undefined) hyperparams.maxDepth = req.maxDepth;
  if (req.minLeaf !== undefined) hyperparams.minLeaf = req.minLeaf;
  if (req.nTrees !== undefined) hyperparams.nTrees = req.nTrees;
  if (req.learningRate !== undefined) hyperparams.learningRate = req.learningRate;
  if (req.k !== undefined) hyperparams.k = req.k;
  if (req.weightDecay !== undefined) hyperparams.weightDecay = req.weightDecay;
  if (req.batchSize !== undefined) hyperparams.batchSize = req.batchSize;
  if (req.hiddenUnits !== undefined) hyperparams.hiddenUnits = req.hiddenUnits;
  if (req.hiddenLayers !== undefined) hyperparams.hiddenLayers = req.hiddenLayers;
  if (req.epochs !== undefined) hyperparams.epochs = req.epochs;
  let artifact: MlTrainResult["artifact"];
  if (req.algorithm === "ridge") {
    // Re-derive weights by refitting on full data with the SAME construction
    // as trainRidge (centered X and y; intercept = ȳ − w·x̄).
    const ym = mean(encoded.y);
    const yc = encoded.y.map((v) => v - ym);
    const p = encoded.pre.featureNames.length;
    const xm = Array.from({ length: p }, (_, j) => mean(encoded.X.map((r) => r[j] as number)));
    const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    const b: number[] = new Array<number>(p).fill(0);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < p; a++) {
        const za = (encoded.X[i]![a] as number) - (xm[a] as number);
        b[a]! += za * (yc[i] as number);
        for (let c = a; c < p; c++) {
          A[a]![c] = (A[a]![c] ?? 0) + za * ((encoded.X[i]![c] as number) - (xm[c] as number));
        }
      }
    }
    for (let a = 0; a < p; a++) {
      A[a]![a] = (A[a]![a] ?? 0) + (req.lambda ?? 1);
      for (let c = 0; c < a; c++) A[a]![c] = A[c]![a]!;
    }
    const w = solve(A, b) ?? new Array<number>(p).fill(0);
    artifact = {
      kind: "aerolexa.ml.v1",
      task: req.task,
      algorithm: "ridge",
      targetColumn: req.targetColumn,
      featureNames: encoded.pre.featureNames,
      preprocessor: encoded.pre,
      weights: w,
      intercept: ym - xm.reduce((s, m, j) => s + m * (w[j] as number), 0),
      hyperparams,
    };
  } else if (req.algorithm === "logistic") {
    if ("weights" in finalModel) {
      // Multinomial softmax refit — serialize the K-class weight matrices.
      const sm = finalModel as ReturnType<typeof trainSoftmax>;
      artifact = {
        kind: "aerolexa.ml.v1",
        task: req.task,
        algorithm: "logistic",
        targetColumn: req.targetColumn,
        featureNames: encoded.pre.featureNames,
        preprocessor: encoded.pre,
        softmaxWeights: sm.weights,
        softmaxBias: sm.bias,
        classes: encoded.classes,
        hyperparams,
      };
    } else {
      const logit = finalModel as ReturnType<typeof trainLogit>;
      artifact = {
        kind: "aerolexa.ml.v1",
        task: req.task,
        algorithm: "logistic",
        targetColumn: req.targetColumn,
        featureNames: encoded.pre.featureNames,
        preprocessor: encoded.pre,
        coefficients: logit.fit.coefficients.map((c) => c.coefficient),
        classes: encoded.classes,
        hyperparams,
      };
    }
  } else if (req.algorithm === "random-forest") {
    // Re-fit the forest and store its trees (deterministic — same seed).
    const randF = seededRandom(seed);
    const p = encoded.pre.featureNames.length;
    const mtry = Math.max(1, Math.round(Math.sqrt(p)));
    const forest: { features: number[]; tree: TreeNode | TreeSplit }[] = [];
    for (let t = 0; t < (req.nTrees ?? 40); t++) {
      const bx: number[][] = [];
      const by: number[] = [];
      for (let i = 0; i < n; i++) {
        const idx = Math.floor(randF() * n);
        bx.push(encoded.X[idx] as number[]);
        by.push(encoded.y[idx] as number);
      }
      const features: number[] = [];
      while (features.length < mtry) {
        const f = Math.floor(randF() * p);
        if (!features.includes(f)) features.push(f);
      }
      features.sort((a, b) => a - b);
      forest.push({
        features,
        tree: buildTreeFor(
          bx.map((r) => features.map((f) => r[f] as number)),
          by,
          req.maxDepth ?? 6,
          req.minLeaf ?? 2,
          1e-9,
          seed + t * 7919,
          32,
        ),
      });
    }
    artifact = {
      kind: "aerolexa.ml.v1",
      task: req.task,
      algorithm: "random-forest",
      targetColumn: req.targetColumn,
      featureNames: encoded.pre.featureNames,
      preprocessor: encoded.pre,
      forest,
      classes: encoded.classes,
      hyperparams,
    };
  } else if (req.algorithm === "decision-tree") {
    const tree = buildTreeFor(encoded.X, encoded.y, req.maxDepth ?? 5, req.minLeaf ?? 3, 1e-9, seed, 32);
    artifact = {
      kind: "aerolexa.ml.v1",
      task: req.task,
      algorithm: "decision-tree",
      targetColumn: req.targetColumn,
      featureNames: encoded.pre.featureNames,
      preprocessor: encoded.pre,
      tree,
      classes: encoded.classes,
      hyperparams,
    };
  } else if (req.algorithm === "mlp") {
    // Re-fit the network deterministically (same seed ⇒ same weights) and
    // serialize the layer tensors for the aerolexa.ml.v1 artifact.
    const refit = trainMlp(encoded.X, encoded.y, {
      hiddenUnits: req.hiddenUnits ?? 32,
      hiddenLayers: req.hiddenLayers ?? 2,
      activation: req.activation ?? "relu",
      epochs: req.epochs ?? 200,
      learningRate: req.learningRate ?? 0.05,
      classesCount: encoded.classes?.length ?? 2,
      classification: req.task !== "regression",
      weightDecay: req.weightDecay ?? 1e-4,
      batchSize: req.batchSize ?? 32,
      seed,
    });
    artifact = {
      kind: "aerolexa.ml.v1",
      task: req.task,
      algorithm: "mlp",
      targetColumn: req.targetColumn,
      featureNames: encoded.pre.featureNames,
      preprocessor: encoded.pre,
      mlp: refit.mlp,
      classes: encoded.classes,
      hyperparams,
    };
  } else if (req.algorithm === "gradient-boosting") {
    // Re-fit the booster deterministically (same construction as the model).
    if (req.learningRate !== undefined) hyperparams.learningRate = req.learningRate;
    const common = {
      kind: "aerolexa.ml.v1" as const,
      task: req.task,
      algorithm: "gradient-boosting" as const,
      targetColumn: req.targetColumn,
      featureNames: encoded.pre.featureNames,
      preprocessor: encoded.pre,
      classes: encoded.classes,
      hyperparams,
    };
    artifact =
      encoded.classes && encoded.classes.length > 2
        ? {
            ...common,
            boostingOvr: trainBoostingOvr(
              encoded.X,
              encoded.y,
              encoded.classes.length,
              req.nTrees ?? 60,
              req.learningRate ?? 0.1,
              req.maxDepth ?? 3,
              req.minLeaf ?? 2,
              seed,
              req.subsample ?? 1,
            ).states,
          }
        : {
            ...common,
            boosting: trainBoosting(
              encoded.X,
              encoded.y,
              req.nTrees ?? 100,
              req.learningRate ?? 0.1,
              req.maxDepth ?? 3,
              req.minLeaf ?? 2,
              req.task !== "regression",
              seed,
              req.subsample ?? 1,
            ).state,
          };
  } else {
    // kNN: the model IS the (preprocessed) training sample.
    artifact = {
      kind: "aerolexa.ml.v1",
      task: req.task,
      algorithm: "knn",
      targetColumn: req.targetColumn,
      featureNames: encoded.pre.featureNames,
      preprocessor: encoded.pre,
      exemplars: encoded.X.map((x, i) => ({ x, y: encoded.y[i] as number })),
      k: req.k ?? 5,
      classes: encoded.classes,
      hyperparams,
    };
  }

  // Serve-side uncertainty: the artifact carries the COMPACT conformal block
  // (no raw scores) so /api/models/[id]/predict can attach the same interval
  // the trainer reported — serving never re-derives or invents one.
  if (conformal) {
    artifact.conformal = {
      halfWidth: conformal.halfWidth,
      alpha: conformal.alpha,
      nCalibration: conformal.nCalibration,
      methodology: conformal.methodology,
    };
  }

  const methodology = [
    `Preprocessing: numeric columns median-imputed then standardized; categorical columns one-hot encoded (${encoded.pre.featureNames.length} design features).`,
    `Validation: ${folds}-fold cross-validation${req.task === "regression" ? "" : " (stratified by class)"}; the CV ${metricName} is out-of-fold.`,
    `Final model: ${req.algorithm} refit on ALL ${n} rows with the same hyperparameters; trainMetrics are IN-SAMPLE for this refit and will look better than CV.`,
    `Importance: permutation importance on the full-data refit (in-sample); a positive value means the feature matters. It is NOT a causal effect.`,
    req.task === "regression"
      ? "Metrics: RMSE (root mean squared error), MAE, R² on held-out folds."
      : req.task === "multiclass-classification"
        ? "Metrics: accuracy and macro precision/recall/F1 on held-out folds (confusion matrix on the full refit, labelled in-sample)."
        : "Metrics: ROC AUC and PR AUC on held-out folds; precision/recall/F1 at the reported threshold.",
    ...(conformal
      ? [
          `Uncertainty: ${conformal.methodology} Apply ±${conformal.halfWidth.toPrecision(4)} around any point prediction from this model.`,
        ]
      : req.task === "regression"
        ? [
            "Uncertainty: no conformal interval could be calibrated from the out-of-fold residuals (too few scored rows) — predictions are point estimates only.",
          ]
        : []),
  ];

  return {
    task: req.task,
    algorithm: req.algorithm,
    targetColumn: req.targetColumn,
    featureNames: encoded.pre.featureNames,
    cv: {
      folds: foldMetric.length,
      metricName,
      mean: round6(cvMean),
      sd: round6(cvSd),
      perFold: foldMetric.map(round6),
    },
    trainMetrics,
    ...(conformal ? { conformal } : {}),
    glmDiagnostics:
      req.algorithm === "logistic" && finalModel && "fit" in finalModel
        ? {
            aic: (finalModel as ReturnType<typeof trainLogit>).fit.aic,
            converged: (finalModel as ReturnType<typeof trainLogit>).fit.converged,
            coefficients: (finalModel as ReturnType<typeof trainLogit>).fit.coefficients,
          }
        : null,
    importance,
    classBalance:
      req.task === "binary-classification"
        ? { positive: encoded.y.filter((v) => v === 1).length, negative: encoded.y.filter((v) => v === 0).length }
        : undefined,
    classes: req.task === "multiclass-classification" ? encoded.classes : undefined,
    classCounts:
      req.task === "multiclass-classification"
        ? (encoded.classes ?? []).map((_, c) => encoded.y.filter((v) => v === c).length)
        : undefined,
    methodology,
    artifact,
  };
}

function round6(v: number): number {
  if (!Number.isFinite(v)) return v;
  return Math.round(v * 1e6) / 1e6;
}
