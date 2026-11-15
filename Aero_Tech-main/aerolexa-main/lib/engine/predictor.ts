/**
 * Model serving — reconstruct a runnable predictor from any aerolexa.ml.v1
 * artifact JSON (the exact bytes `/api/models/[id]/download` hands out).
 *
 * This is the serving half of the MLOps story: a model trained in the UI
 * becomes callable — POST a row of raw feature values, get the prediction
 * back. Reconstruction is EXACT: the same preprocessing (median imputation →
 * one-hot with train-fitted levels → train-fitted standardization) and the
 * same forward paths as training, so serving answers equal what the trained
 * model would have answered on the same input. Where the standard ModelCard
 * payload is not self-sufficient (ridge/logistic on the advanced engine store
 * their weights in card-level fields; the artifact payload per algorithm is
 * optional), callers may attach `artifactPayload` — the aerolexa.ml.v1 block
 * written next to training — and the predictor prefers it.
 *
 * Served heads:
 *  - ridge: linear weights + intercept
 *  - logistic (binary): sigmoid(Wx+b); (multiclass): softmax over K weights
 *  - decision tree / random forest: stored tree walks
 *  - gradient boosting: stored boosting state (incl. OvR for multiclass)
 *  - kNN: stored exemplars
 *  - mlp: stored layer tensors (2×ReLU + head)
 *
 * Honesty rules preserved: unknown/missing numeric features are median-imputed
 * with TRAIN-fitted medians; unseen categorical levels encode all-zeros (the
 * same thing sklearn's handle_unknown='ignore' does); class labels are the
 * train-fitted sorted classes.
 */

import {
  softmaxRow,
  type BoostState,
  type MlpState,
  type Preprocessor,
  type TreeNode,
  type TreeSplit,
} from "@/lib/engine/ml-training";
import { explainPrediction, type ShapleyExplanation } from "@/lib/engine/shapley";

/** The per-algorithm payload block (subset of MlTrainResult["artifact"]). */
export interface ArtifactPayload {
  kind?: string;
  task?: string;
  algorithm?: string;
  targetColumn?: string;
  featureNames?: string[];
  preprocessor?: Preprocessor;
  weights?: number[];
  intercept?: number;
  coefficients?: number[];
  softmaxWeights?: number[][];
  softmaxBias?: number[];
  tree?: TreeNode | TreeSplit;
  forest?: { features: number[]; tree: TreeNode | TreeSplit }[];
  boosting?: BoostState;
  boostingOvr?: BoostState[];
  exemplars?: { x: number[]; y: number }[];
  k?: number;
  classes?: string[];
  mlp?: MlpState;
  conformal?: { halfWidth: number; alpha: number; nCalibration: number; methodology: string };
  hyperparams?: Record<string, number>;
  /**
   * Attached by AutoML when the blended ensemble beat the best single model:
   * the payload keeps the WINNER's fields (preprocessor etc. keep the card
   * schema valid) and serving switches to the member combiner.
   */
  ensemble?: {
    kind?: string;
    combiner?: string;
    members?: ArtifactPayload[];
    meta?: { weights: number[]; intercept: number };
  };
}

/** The minimal card + optional payload the predictor accepts. */
export interface ServeableModel {
  task: string;
  algorithm: string;
  targetColumn?: string | null;
  features: string[];
  /** Standard ModelCard fields (advanced engine fills these). */
  weights?: number[];
  intercept?: number;
  coefficients?: Record<string, number>;
  centroids?: number[][];
  classMap?: { positive: string; negative: string };
  /** Full aerolexa.ml.v1 block when available (preferred over card fields). */
  artifactPayload?: ArtifactPayload;
}

export interface PredictionRow {
  /** One prediction (regression) or positive-class probability (binary). */
  prediction: number;
  /** Full class-probability vector + labels when the model is a classifier. */
  probabilities?: { label: string; probability: number }[];
  /** The design-matrix encoding actually scored (debuggability). */
  encoded: number[];
  methodology: string;
}

function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

function argmax(v: number[]): number {
  let best = 0;
  for (let i = 1; i < v.length; i++) if ((v[i] as number) > (v[best] as number)) best = i;
  return best;
}

function toNumber(v: unknown): number {
  if (v === null || v === undefined || v === "") return Number.NaN;
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(String(v).replace(/[,$\s%€£]/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

function evalTreeNode(node: TreeNode | TreeSplit, x: number[]): number {
  while (!node.leaf) {
    node = (x[node.feature] as number) <= node.threshold ? node.left : node.right;
  }
  return node.value;
}

/**
 * Rebuild the training-time preprocessing from a stored Preprocessor and a
 * batch of RAW rows (same cell types as upload). Encoding contract:
 *  - one-hot columns: 1 when the raw value equals the train-fitted level,
 *    all-zeros for unseen/missing levels (handle_unknown='ignore');
 *  - numeric columns: toNumber → median-impute → (v − mean)/std with the
 *    train-fitted moments;
 *  - column order = preprocessor.featureNames.
 */
export function encodeRowsWithPreprocessor(rawRows: Record<string, unknown>[], pre: Preprocessor): number[][] {
  const oneHotByFeature = new Map<string, { source: string; level: string }>();
  for (const cat of pre.categoricalLevels) {
    for (const lv of cat.levels) oneHotByFeature.set(`${cat.source}=${lv}`, { source: cat.source, level: lv });
  }
  return rawRows.map((row) =>
    pre.featureNames.map((fname, j) => {
      const oh = oneHotByFeature.get(fname);
      if (oh) return String(row[oh.source]) === oh.level ? 1 : 0;
      const n = toNumber(row[fname]);
      const v = Number.isFinite(n) ? n : (pre.medians[j] ?? 0);
      const sd = pre.stds[j] || 1;
      return (v - (pre.means[j] ?? 0)) / sd;
    }),
  );
}

/**
 * The RAW input columns a caller must supply to serve/explain this model — the
 * exact inverse of {@link encodeRowsWithPreprocessor}.
 *
 * The stored design matrix is EXPANDED, not raw: a categorical column `region`
 * with levels East/West becomes two columns `region=East` and `region=West`.
 * `pre.featureNames` therefore names ENCODED columns that a client never sends,
 * so it is the wrong list to validate a request against — doing that rejected
 * every complete, correct request body (its keys are the raw columns) and, worse,
 * let a genuinely incomplete one through. Undo the one-hot expansion to recover
 * the original column names, falling back to the card's `features` for an
 * artifact that predates the fitted preprocessor.
 */
export function requiredInputFeatures(model: ServeableModel): string[] {
  const pre = model.artifactPayload?.preprocessor;
  if (!pre) return model.features ?? [];
  const oneHot = new Set<string>();
  for (const cat of pre.categoricalLevels ?? []) {
    for (const lv of cat.levels) oneHot.add(`${cat.source}=${lv}`);
  }
  const required: string[] = [];
  for (const cat of pre.categoricalLevels ?? []) {
    if (!required.includes(cat.source)) required.push(cat.source);
  }
  for (const fname of pre.featureNames ?? []) {
    if (!oneHot.has(fname) && !required.includes(fname)) required.push(fname);
  }
  return required;
}

/**
 * Names in `features` that the model needs but the caller did not supply.
 * Empty means the row is complete.
 */
export function missingInputFeatures(model: ServeableModel, features: Record<string, unknown>): string[] {
  return requiredInputFeatures(model).filter((name) => !(name in features));
}

/**
 * Build a black-box `predict(designRow) => number` closure from the stored
 * parameters. For classifiers this returns the positive-class probability
 * (binary) or the argmax class index... no — see `serve`: the closure returns
 * the RAW score and `serve` maps it through the head. Contract here:
 *  - regression → the value;
 *  - binary → P(positive);
 *  - multiclass → the argmax CLASS INDEX.
 */
export function buildPredictor(model: ServeableModel): (x: number[]) => number {
  const p = model.artifactPayload;
  const algorithm = (p?.algorithm ?? model.algorithm) as string;

  if (algorithm === "ridge") {
    const w = p?.weights ?? model.weights ?? [];
    const b = p?.intercept ?? model.intercept ?? 0;
    return (x) => b + x.reduce((s, v, j) => s + v * (w[j] ?? 0), 0);
  }
  if (algorithm === "logistic") {
    if (p?.softmaxWeights) {
      const W = p.softmaxWeights;
      const b = p.softmaxBias ?? [];
      return (x) => {
        const scores = W[0]!.map((_, c) => (b[c] ?? 0) + x.reduce((s, v, j) => s + v * (W[j]?.[c] ?? 0), 0));
        return argmax(scores);
      };
    }
    if (p?.coefficients) {
      const c = p.coefficients;
      return (x) => sigmoid(x.reduce((s, v, j) => s + v * (c[j + 1] ?? 0), c[0] ?? 0));
    }
    // Card-level fields (advanced engine cards carry weights + intercept with
    // the intercept folded into position 0 convention? No — the card stores
    // `intercept` separately and `weights` aligned to features).
    const w = model.weights ?? [];
    const b = model.intercept ?? 0;
    return (x) => sigmoid(b + x.reduce((s, v, j) => s + v * (w[j] ?? 0), 0));
  }
  if (algorithm === "decision-tree" && p?.tree) {
    const tree = p.tree;
    return (x) => evalTreeNode(tree, x);
  }
  if (algorithm === "random-forest" && p?.forest?.length) {
    const forest = p.forest;
    return (x) =>
      forest.reduce(
        (s, t) =>
          s +
          evalTreeNode(
            t.tree,
            t.features.map((f) => x[f] as number),
          ),
        0,
      ) / forest.length;
  }
  if (algorithm === "gradient-boosting") {
    if (p?.boostingOvr?.length) {
      const boosters = p.boostingOvr;
      return (x) => {
        const probs = boosters.map((st) => sigmoid(boostRaw(st, x)));
        const s = probs.reduce((a, v) => a + v, 0) || 1;
        return argmax(probs.map((v) => v / s));
      };
    }
    if (p?.boosting) {
      const st = p.boosting;
      const cls = (p.task ?? model.task) !== "regression";
      return (x) => (cls ? sigmoid(boostRaw(st, x)) : boostRaw(st, x));
    }
  }
  if (algorithm === "knn" && p?.exemplars?.length) {
    const exemplars = p.exemplars;
    const k = Math.max(1, Math.min(p.k ?? 5, exemplars.length));
    return (x) => {
      const dists = exemplars
        .map((e) => ({ d: e.x.reduce((s, v, j) => s + (v - (x[j] ?? 0)) ** 2, 0), y: e.y }))
        .sort((a, b) => a.d - b.d)
        .slice(0, k);
      return dists.reduce((s, t) => s + t.y, 0) / dists.length;
    };
  }
  if (algorithm === "mlp" && p?.mlp) {
    const mlp = p.mlp;
    return (x) => mlpForward(mlp, x);
  }
  // Nothing matched — the card lacks the payload for its algorithm.
  throw new Error(
    `This model card does not carry the artifact payload needed for serving (${algorithm}). ` +
      `Re-train the model, or attach the aerolexa.ml.v1 artifact payload.`,
  );
}

/** Friedman boosting raw score: base + Σ lr·tree(x). */
function boostRaw(st: BoostState, x: number[]): number {
  return st.trees.reduce((s, tr) => s + st.learningRate * evalTreeNode(tr, x), st.base);
}

/**
 * Hidden activation shared by the trainer (ml-training.ts) and the server.
 * Kept bit-identical: relu | tanh | the tanh-approximation GELU.
 */
function hiddenActivate(activation: MlpState["activation"], z: number): number {
  if (activation === "tanh") return Math.tanh(z);
  if (activation === "gelu") return 0.5 * z * (1 + Math.tanh(0.7978845608028654 * (z + 0.044715 * z * z * z)));
  return Math.max(0, z); // relu (default — legacy artifacts)
}

/** MLP forward: (input → hidden stack in the STORED activation → head). */
function mlpForward(mlp: MlpState, x: number[]): number {
  const layers = mlp.layers;
  const biases = mlp.biases;
  const activation = mlp.activation ?? "relu"; // legacy artifacts predate the field
  let act: number[] = x;
  for (let l = 0; l < layers.length - 1; l++) {
    const prev = act;
    act = (biases[l] ?? []).map((bj, o) =>
      hiddenActivate(activation, bj + (layers[l]?.[o] ?? []).reduce((s, w, i2) => s + w * (prev[i2] ?? 0), 0)),
    );
  }
  const last = layers.length - 1;
  const out = (biases[last] ?? []).map(
    (bj, o) => bj + (layers[last]?.[o] ?? []).reduce((s, w, i2) => s + w * (act[i2] ?? 0), 0),
  );
  const head = mlp.head;
  if (head === "identity") return out[0] ?? 0;
  if (head === "softmax") return argmax(softmaxRow(out));
  return sigmoid(out[0] ?? 0);
}

/** Serving result for one raw input row. */
export interface ServeResult {
  /** Regression value, binary positive-class probability, or the class label. */
  output: number | string;
  probabilities?: { label: string; probability: number }[];
  encoded: number[];
  methodology: string;
  /**
   * Regression + calibrated artifact: the split-conformal interval trained
   * into the artifact (± halfWidth around `output`). Distribution-free
   * coverage with the calibration provenance attached — never a Gaussian band.
   */
  interval?: { low: number; high: number; halfWidth: number; alpha: number; nCalibration: number; methodology: string };
}

/**
 * Serve one raw row through the full pipeline: encode with the TRAIN-fitted
 * preprocessor → score → map through the task head.
 */
export function serve(model: ServeableModel, rawRow: Record<string, unknown>): ServeResult {
  const p = model.artifactPayload;
  const ens = p?.ensemble;
  if (ens && ens.members && ens.members.length > 0) {
    return serveEnsemble(model, ens, rawRow);
  }
  const pre = p?.preprocessor;
  if (!pre) {
    throw new Error(
      "The model card does not carry its fitted preprocessor — serving needs the train-fitted encoding. Re-train the model.",
    );
  }
  const encoded = encodeRowsWithPreprocessor([rawRow], pre)[0] as number[];
  const score = buildPredictor(model)(encoded);
  const task = p?.task ?? model.task;
  const classes = p?.classes ?? (model.classMap ? [model.classMap.negative, model.classMap.positive] : undefined);
  const algorithm = (p?.algorithm ?? model.algorithm) as string;

  const methodology =
    `Served from the stored aerolexa.ml.v1 artifact (${algorithm}): median-impute → one-hot (train-fitted levels) → ` +
    `standardize (train-fitted moments) → forward pass. Same preprocessing as training — the served answer equals ` +
    `what the trained model computes on this input.`;

  if (task === "regression") {
    const conf = p?.conformal;
    return {
      output: score,
      encoded,
      methodology,
      ...(conf
        ? {
            interval: {
              low: score - conf.halfWidth,
              high: score + conf.halfWidth,
              halfWidth: conf.halfWidth,
              alpha: conf.alpha,
              nCalibration: conf.nCalibration,
              methodology: conf.methodology,
            },
          }
        : {}),
    };
  }
  if (algorithm === "mlp" && p?.mlp) {
    // The MLP closure already applies its head.
    if (p.mlp.head === "softmax") {
      // Rebuild the full probability vector for the response — through the
      // STORED hidden activation (same forward as buildPredictor/mlpForward).
      const layers = p.mlp.layers;
      const biases = p.mlp.biases;
      const activation = p.mlp.activation ?? "relu";
      let act: number[] = encoded;
      for (let l = 0; l < layers.length - 1; l++) {
        const prev = act;
        act = (biases[l] ?? []).map((bj, o) =>
          hiddenActivate(activation, bj + (layers[l]?.[o] ?? []).reduce((s, w, i2) => s + w * (prev[i2] ?? 0), 0)),
        );
      }
      const last = layers.length - 1;
      const out = (biases[last] ?? []).map(
        (bj, o) => bj + (layers[last]?.[o] ?? []).reduce((s, w, i2) => s + w * (act[i2] ?? 0), 0),
      );
      const probs = softmaxRow(out);
      return {
        output: (classes ?? probs.map((_, i) => String(i)))[argmax(probs)] as string,
        probabilities: probs.map((probability, i) => ({
          label: (classes ?? probs.map((_, j) => String(j)))[i] as string,
          probability,
        })),
        encoded,
        methodology,
      };
    }
    const probability = score; // sigmoid already applied
    const pos = classes?.[1] ?? "1";
    return {
      output: probability >= 0.5 ? pos : (classes?.[0] ?? "0"),
      probabilities: [
        { label: classes?.[0] ?? "0", probability: 1 - probability },
        { label: pos, probability },
      ],
      encoded,
      methodology,
    };
  }
  if (algorithm === "logistic" && p?.softmaxWeights) {
    // score is already the argmax index (multiclass softmax closure).
    const W = p.softmaxWeights;
    const b = p.softmaxBias ?? [];
    const scores = W[0]!.map((_, c) => (b[c] ?? 0) + encoded.reduce((s, v, j) => s + v * (W[j]?.[c] ?? 0), 0));
    const probs = softmaxRow(scores);
    return {
      output: (classes ?? [])[argmax(probs)] ?? String(argmax(probs)),
      probabilities: probs.map((probability, i) => ({
        label: (classes ?? [])[i] ?? String(i),
        probability,
      })),
      encoded,
      methodology,
    };
  }
  if (algorithm === "gradient-boosting" && p?.boostingOvr) {
    // score is the argmax index; recompute the vector for the response.
    const probs = p.boostingOvr.map((st) => sigmoid(boostRaw(st, encoded)));
    const s = probs.reduce((a, v) => a + v, 0) || 1;
    const norm = probs.map((v) => v / s);
    return {
      output: (classes ?? [])[argmax(norm)] ?? String(argmax(norm)),
      probabilities: norm.map((probability, i) => ({ label: (classes ?? [])[i] ?? String(i), probability })),
      encoded,
      methodology,
    };
  }
  // Multiclass scalar vote (kNN / OvR-free ensembles): the closure returns a
  // class INDEX estimate — round to the nearest trained label instead of
  // thresholding at 0.5 (which would be binary semantics).
  if ((classes?.length ?? 2) > 2 && algorithm !== "logistic") {
    const idx = Math.min(classes!.length - 1, Math.max(0, Math.round(score)));
    return { output: classes![idx] as string, encoded, methodology };
  }
  // Binary default (logistic / boosting / kNN / forest): probability of the
  // positive class, plus a thresholded label at 0.5.
  const pos = classes?.[1] ?? "1";
  return {
    output: score >= 0.5 ? pos : (classes?.[0] ?? "0"),
    probabilities: [
      { label: classes?.[0] ?? "0", probability: 1 - score },
      { label: pos, probability: score },
    ],
    encoded,
    methodology,
  };
}

/**
 * Serve through a blended ensemble: each self-contained member artifact
 * (kind aerolexa.ml.v1, with its OWN fitted preprocessor) scores the raw row
 * through the standard single-model pipeline, and the combiner aggregates.
 *
 *  - regression + "mean":      plain average of member outputs
 *  - regression + "stacked":   ridge meta-weights over member outputs
 *                               (weights fitted on OUT-OF-FOLD member
 *                               predictions in lib/engine/ensemble.ts)
 *  - classification:           "mean-prob" — mean class probability per
 *                              label across members, argmax for the label
 *
 * Members are served with the FULL single-model path (not this combiner),
 * so a nested ensemble member is rejected — depth 1 is a documented limit.
 */
function serveEnsemble(
  model: ServeableModel,
  ens: NonNullable<ArtifactPayload["ensemble"]>,
  rawRow: Record<string, unknown>,
): ServeResult {
  const members = ens.members ?? [];
  const results: ServeResult[] = [];
  for (const member of members) {
    if (member.ensemble && member.ensemble.members && member.ensemble.members.length > 0) {
      throw new Error("Nested ensemble members are not supported (ensemble depth is 1).");
    }
    if (!member.preprocessor) {
      throw new Error("An ensemble member artifact is missing its fitted preprocessor — re-run AutoML.");
    }
    results.push(
      serve(
        {
          task: model.task,
          algorithm: member.algorithm ?? model.algorithm,
          targetColumn: model.targetColumn ?? member.targetColumn ?? null,
          features: member.featureNames ?? model.features,
          artifactPayload: member,
        },
        rawRow,
      ),
    );
  }
  const task = model.task;
  const weights = ens.meta?.weights;
  const intercept = ens.meta?.intercept ?? 0;

  if (task === "regression") {
    const outputs = results.map((r) => Number(r.output));
    let value: number;
    if (ens.combiner === "stacked" && weights && weights.length === outputs.length) {
      value = intercept + outputs.reduce((s, o, i) => s + (weights[i] ?? 0) * o, 0);
    } else {
      // Plain mean over the FINITE outputs; a member that cannot score a row
      // (impossible by construction here — the preprocessor medians always
      // produce a value) would break the blend, so guard honestly.
      value = meanOf(outputs);
    }
    if (!Number.isFinite(value)) throw new Error("The ensemble produced a non-finite prediction for this row.");
    return {
      output: value,
      encoded: results[0]!.encoded,
      methodology:
        `Served from a ${results.length}-member blended ensemble (${members
          .map((m) => m.algorithm ?? "?")
          .join(
            " + ",
          )}), combiner "${ens.combiner ?? "mean"}"${ens.meta ? ` with ridge meta-weights fitted on OUT-OF-FOLD member predictions` : ""}. ` +
        `Each member encodes the raw row through its own train-fitted preprocessor, then the combiner aggregates.`,
    };
  }

  // Classification: mean class probability per label across members.
  const sums = new Map<string, { total: number; count: number }>();
  for (const r of results) {
    for (const { label, probability } of r.probabilities ?? []) {
      const slot = sums.get(label) ?? { total: 0, count: 0 };
      slot.total += probability;
      slot.count += 1;
      sums.set(label, slot);
    }
  }
  // Labels absent from a member's vector (a fold could miss a rare class)
  // contribute their slot average from the members that DID report them —
  // count-aware averaging, not a silent zero.
  const probs = [...sums.entries()].map(([label, { total, count }]) => ({
    label,
    probability: total / Math.max(1, count),
  }));
  if (probs.length === 0) throw new Error("No ensemble member produced class probabilities for this row.");
  const best = probs.reduce((a, b) => (b.probability > a.probability ? b : a));
  return {
    output: best.label,
    probabilities: probs.sort((a, b) => b.probability - a.probability),
    encoded: results[0]!.encoded,
    methodology:
      `Served from a ${results.length}-member blended ensemble, combiner "${ens.combiner ?? "mean-prob"}" — ` +
      `mean class probability per label across members (count-aware when a member misses a rare label), argmax for the label. ` +
      `Each member encodes the raw row through its own train-fitted preprocessor.`,
  };
}

function meanOf(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((a, v) => a + v, 0) / finite.length : Number.NaN;
}

/** Explain one raw row: serve + permutation-Shapley over the encoded row. */
export function explainRow(
  model: ServeableModel,
  rawRow: Record<string, unknown>,
  backgroundRaw: Record<string, unknown>[],
  opts: { seed?: number; nPermutations?: number; backgroundRows?: number } = {},
): { serve: ServeResult; explanation: ShapleyExplanation } {
  const p = model.artifactPayload;
  const pre = p?.preprocessor;
  if (!pre) throw new Error("Serving/explaining needs the fitted preprocessor — re-train the model.");
  const predict = buildPredictor(model);
  const encoded = encodeRowsWithPreprocessor([rawRow], pre)[0] as number[];
  const background = encodeRowsWithPreprocessor(backgroundRaw, pre);
  const explanation = explainPrediction(
    predict,
    encoded,
    background,
    pre.featureNames,
    opts.seed ?? 42,
    opts.nPermutations ?? 32,
  );
  const served = serve(model, rawRow);
  return { serve: served, explanation };
}
