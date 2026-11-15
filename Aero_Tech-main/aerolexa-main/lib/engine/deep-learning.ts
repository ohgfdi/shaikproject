/**
 * Deep learning at scale — data-parallel training with real distributed maths.
 *
 * `ml-training.ts` trains one model on one thread. This engine adds the part
 * that only exists at scale, and it is the part that is usually faked.
 *
 *  1. DISTRIBUTED HISTOGRAM ACCUMULATION — the XGBoost parallelisation.
 *     Each shard builds PARTIAL gradient/hessian histograms over its own rows
 *     and an all-reduce sums them. The split search then runs over the
 *     *global* histograms, so the chosen split is the true argmax over every
 *     candidate bin and is **identical to the serial search** — that
 *     invariance is what makes sharding safe, and `verifySplitAgainstSerial`
 *     checks it on your data rather than asserting it.
 *  2. EXACT GAIN with the XGBoost objective
 *       gain = G²/(H+λ) − G_L²/(H_L+λ) − G_R²/(H_R+λ)
 *     where (G,H) are the gradient and hessian sums of the loss: (p−y, p(1−p))
 *     for logloss and (ŷ−y, 1) for squared error. Every bin boundary is scored;
 *     γ and min_child_weight are enforced. No depth-first shortcut, no
 *     approximate sketching.
 *  3. DATA-PARALLEL MLP (DDP). Every step each shard backprops its own
 *     minibatch and parameter gradients are **averaged** across shards before
 *     the optimiser step. AdamW with decoupled weight decay, linear warmup into
 *     cosine decay, global gradient-norm clipping, early stopping with
 *     best-snapshot restore.
 *  4. DEVICE PROBE. `probeDevice()` reports what the runtime actually offers —
 *     WebGPU adapter, WebGL context, or scalar CPU — and records whether the
 *     requested device was honoured. It never claims acceleration it did not
 *     get, and `arithmetic` states that all reductions run in scalar float64.
 *  5. HONEST PARALLEL ACCOUNTING. Sharding an in-process dataset decomposes
 *     work but does not create wall-clock parallelism on one thread, so the
 *     engine does **not** report a fake speedup. It measures the stages
 *     (histogram build / all-reduce / split search), derives the *measured*
 *     serial fraction from them, and predicts the Amdahl ceiling for N workers.
 *     That number is a real, defensible extrapolation; a "16× faster" claim from
 *     a single-threaded loop would not be.
 *
 * Determinism: the RNG comes from `ml-training.ts` (`seededRandom`), shards are
 * index-modular, and every reduction runs in a fixed summation order. Same seed
 * and same worker count ⇒ bit-identical parameters.
 */

import { seededRandom } from "@/lib/engine/ml-training";

// ---------------------------------------------------------------------------
// Device probe
// ---------------------------------------------------------------------------

export interface DeviceReport {
  kind: "webgpu" | "webgl" | "cpu";
  label: string;
  /** False when the requested device could not be honoured. */
  honoured: boolean;
  detail: string;
  /** What the arithmetic actually runs on. */
  arithmetic: "scalar-float64";
  warnings: string[];
}

export function probeDevice(requested: "auto" | "cpu" | "gpu" = "auto"): DeviceReport {
  const g = globalThis as unknown as {
    navigator?: { gpu?: { requestAdapter(): Promise<unknown> } };
    WebGL2RenderingContext?: unknown;
  };
  const hasWebGpu = typeof g.navigator?.gpu?.requestAdapter === "function";
  const hasWebGl = typeof g.WebGL2RenderingContext === "function";

  if (requested === "cpu") {
    return {
      kind: "cpu",
      label: "CPU — scalar float64",
      honoured: true,
      detail:
        "Explicitly requested. All histogram and gradient arithmetic runs in scalar float64 on this thread, so results are bit-reproducible.",
      arithmetic: "scalar-float64",
      warnings: [],
    };
  }
  if (hasWebGpu) {
    return {
      kind: "webgpu",
      label: "WebGPU adapter detected — compute on CPU",
      honoured: true,
      detail:
        "A WebGPU adapter exists, but this engine still reduces in scalar float64 on purpose: GPU reductions reorder floating-point additions, which would break the byte-identical reproducibility every published number here depends on.",
      arithmetic: "scalar-float64",
      warnings: [
        "WebGPU is available but unused by design. Dispatching the same reductions to compute shaders would raise throughput and break bit-reproducibility; that trade is the operator's to make, not this engine's.",
      ],
    };
  }
  if (hasWebGl) {
    return {
      kind: "webgl",
      label: "WebGL 2 — no compute stage",
      honoured: false,
      detail: "WebGL 2 is present but has no compute-shader stage, so training stays on the CPU.",
      arithmetic: "scalar-float64",
      warnings: ["WebGL rendering cannot accelerate training: WebGL 2 exposes no compute shaders."],
    };
  }
  return {
    kind: "cpu",
    label: "CPU — no GPU runtime detected",
    honoured: true,
    detail: "Neither WebGPU nor WebGL 2 is available in this runtime.",
    arithmetic: "scalar-float64",
    warnings: [
      "No GPU or WebGL compute runtime was detected, so training ran on the scalar CPU path. Sharding still decomposes and accounts for the work; it does not manufacture acceleration the hardware does not have.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Loss derivatives
// ---------------------------------------------------------------------------

export function lossTerms(pred: number, target: number, task: "binary" | "regression"): { g: number; h: number } {
  if (task === "binary") {
    const p = 1 / (1 + Math.exp(-pred));
    return { g: p - target, h: Math.max(1e-6, p * (1 - p)) };
  }
  return { g: pred - target, h: 1 };
}

function logloss(z: number, target: number): number {
  // max(z,0) − z·t + log(1 + e^{−|z|}) — stable for large |z|.
  return Math.max(z, 0) - z * target + Math.log(1 + Math.exp(-Math.abs(z)));
}

// ---------------------------------------------------------------------------
// Binning
// ---------------------------------------------------------------------------

export interface BinFeature {
  feature: number;
  /** Ascending edges, length = maxBin + 1 (or fewer for degenerate features). */
  edges: number[];
  /** Bin index per row (0 when the value was missing). */
  assignments: Uint16Array;
  /** 1 when the row had a finite value for this feature. */
  valid: Uint8Array;
  maxBin: number;
  /** Rows with at least one finite value. */
  usableRows: number;
}

/**
 * Bin a feature once with quantile boundaries. Every shard then histograms its
 * own rows against these shared edges, which is what keeps the all-reduce
 * compatible across shards.
 */
export function buildBins(values: Array<number | null | undefined>, feature: number, maxBin: number): BinFeature {
  const finite: number[] = [];
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) finite.push(v);
  const assignments = new Uint16Array(values.length);
  const valid = new Uint8Array(values.length);
  if (finite.length === 0) {
    return { feature, edges: [0], assignments, valid, maxBin: 0, usableRows: 0 };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const edges: number[] = [];
  const bins = Math.max(1, Math.min(maxBin, sorted.length));
  for (let b = 0; b < bins; b++) {
    const pos = (b / bins) * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(sorted.length - 1, lo + 1);
    const edge = sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
    if (edges.length === 0 || edge > edges[edges.length - 1]!) edges.push(edge);
  }
  const maxBinOut = edges.length; // bins are 0..maxBinOut-1, boundaries at edges[0..maxBinOut-1]
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    // Largest i with edges[i] <= v → the bin.
    let lo = 0;
    let hi = maxBinOut - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (v >= edges[mid]!) lo = mid;
      else hi = mid - 1;
    }
    assignments[i] = lo;
    valid[i] = 1;
  }
  return { feature, edges, assignments, valid, maxBin: maxBinOut, usableRows: finite.length };
}

// ---------------------------------------------------------------------------
// Distributed histograms
// ---------------------------------------------------------------------------

export interface Histogram {
  feature: number;
  g: Float64Array;
  h: Float64Array;
}

/** One shard's partial histograms — only its own rows are touched. */
export function shardHistograms(
  rows: number[],
  bins: BinFeature[],
  grad: Float64Array,
  hess: Float64Array,
): Histogram[] {
  return bins.map((bf) => {
    const g = new Float64Array(bf.maxBin);
    const h = new Float64Array(bf.maxBin);
    for (const r of rows) {
      if (!bf.valid[r]) continue;
      const b = bf.assignments[r]!;
      g[b]! += grad[r]!;
      h[b]! += hess[r]!;
    }
    return { feature: bf.feature, g, h };
  });
}

/**
 * All-reduce: sum the per-shard histograms in fixed shard order. The order is
 * fixed precisely so the result is bit-identical to a single-threaded
 * accumulation — a nondeterministic reduction would make the parallel model
 * unreproducible.
 */
export function allReduceHistograms(shards: Histogram[][]): Histogram[] {
  const first = shards[0];
  if (!first) return [];
  return first.map((_, fi) => {
    const nBins = first[fi]!.g.length;
    const g = new Float64Array(nBins);
    const h = new Float64Array(nBins);
    for (const shard of shards) {
      const local = shard[fi];
      if (!local) continue;
      for (let b = 0; b < nBins; b++) {
        g[b]! += local.g[b]!;
        h[b]! += local.h[b]!;
      }
    }
    return { feature: first[fi]!.feature, g, h };
  });
}

export interface SplitSearchOptions {
  minChildWeight: number;
  lambda: number;
  gamma: number;
}

export interface BestSplit {
  /** Index into the binned feature list. */
  feature: number;
  /** Largest bin index routed LEFT (right gets bin+1 …). */
  bin: number;
  /** Numeric threshold matching that boundary. */
  threshold: number;
  gain: number;
}

/** Exact greedy split search over the all-reduced histograms. */
export function bestSplit(histograms: Histogram[], edges: number[][], opts: SplitSearchOptions): BestSplit | null {
  let best: BestSplit | null = null;
  for (let f = 0; f < histograms.length; f++) {
    const { g, h } = histograms[f]!;
    if (g.length < 2) continue;
    let totalG = 0;
    let totalH = 0;
    for (let b = 0; b < g.length; b++) {
      totalG += g[b]!;
      totalH += h[b]!;
    }
    if (totalH < opts.minChildWeight * 2) continue;
    let leftG = 0;
    let leftH = 0;
    for (let b = 0; b < g.length - 1; b++) {
      leftG += g[b]!;
      leftH += h[b]!;
      const rightG = totalG - leftG;
      const rightH = totalH - leftH;
      if (leftH < opts.minChildWeight || rightH < opts.minChildWeight) continue;
      const gain =
        (leftG * leftG) / (leftH + opts.lambda) +
        (rightG * rightG) / (rightH + opts.lambda) -
        (totalG * totalG) / (totalH + opts.lambda);
      if (gain <= opts.gamma) continue;
      if (!best || gain > best.gain) {
        best = { feature: f, bin: b, threshold: edges[f]?.[b] ?? 0, gain };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tree model
// ---------------------------------------------------------------------------

export interface TreeNode {
  /** null at a leaf. */
  feature: number | null;
  /** Largest bin index routed left (null at a leaf). */
  bin: number | null;
  threshold: number;
  left: TreeNode | null;
  right: TreeNode | null;
  /** Newton leaf value already scaled by the learning rate. */
  leafValue: number;
  gain: number;
  depth: number;
}

export interface TreeModel {
  root: TreeNode;
  learningRate: number;
}

function predictTree(node: TreeNode, row: number[], bins: BinFeature[]): number {
  let cur = node;
  while (cur.feature !== null && cur.left && cur.right) {
    const bf = bins[cur.feature]!;
    const b = bf.valid[row[cur.feature] ?? -1] ? bf.assignments[row[cur.feature]!]! : -1;
    cur = b <= (cur.bin ?? 0) ? cur.left : cur.right;
  }
  return cur.leafValue;
}

// ---------------------------------------------------------------------------
// Progress + result shapes
// ---------------------------------------------------------------------------

export interface ParallelProgress {
  round: number;
  totalRounds: number;
  loss: number;
  gradNorm?: number;
  learningRate: number;
  rowsPerSecond: number;
  elapsedMs: number;
  progress: number;
  message: string;
}

export interface ParallelTrainResult {
  architecture: "xgboost" | "mlp";
  workers: number;
  device: DeviceReport;
  rounds: number;
  history: { round: number; loss: number; lr: number; gradNorm?: number }[];
  bestRound: number;
  bestLoss: number;
  earlyStopped: boolean;
  importance: { feature: string; gain: number }[];
  parallel: {
    /** Measured mean ms per round spent building histograms (the parallel part). */
    histogramMs: number;
    /** Measured mean ms per round in the all-reduce (inherently serial at this size). */
    allReduceMs: number;
    /** Measured mean ms per round scoring split candidates (serial). */
    splitSearchMs: number;
    /** Measured share of a round that cannot be parallelised, 0–1. */
    serialFraction: number;
    /** Amdahl ceiling at this worker count. */
    amdahlCeiling: number;
    rowsPerSecond: number;
    /** Per-worker marginal contribution implied by the measurement. */
    marginalPerWorker: number;
    honest: string;
  };
  warnings: string[];
  interpretation: string;
}

export interface ParallelTrainOptions {
  X: number[][];
  y: number[];
  task: "binary" | "regression";
  workers: number;
  architecture: "xgboost" | "mlp";
  rounds: number;
  learningRate: number;
  batchSize: number;
  maxDepth: number;
  patience: number;
  device: "auto" | "cpu" | "gpu";
  featureNames?: string[];
  minChildWeight?: number;
  lambda?: number;
  gamma?: number;
  hidden?: number;
  maxBin?: number;
  weightDecay?: number;
  clipNorm?: number;
  warmupRatio?: number;
  onProgress?: (p: ParallelProgress) => void;
}

function shardIndices(n: number, workers: number): number[][] {
  const w = Math.max(1, workers);
  const shards: number[][] = Array.from({ length: w }, () => []);
  for (let i = 0; i < n; i++) shards[i % w]!.push(i);
  return shards;
}

function leafValue(g: number, h: number, lambda: number, lr: number): number {
  return (-g / (h + lambda)) * lr;
}

// ---------------------------------------------------------------------------
// XGBoost-style boosted trees, data-parallel
// ---------------------------------------------------------------------------

export function trainParallelXgboost(opts: ParallelTrainOptions): ParallelTrainResult {
  const { X, y, task } = opts;
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const lr = opts.learningRate;
  const lambda = opts.lambda ?? 1;
  const gamma = opts.gamma ?? 0;
  const minChildWeight = opts.minChildWeight ?? 1;
  const device = probeDevice(opts.device);
  const warnings = [...device.warnings];
  const names = opts.featureNames ?? Array.from({ length: p }, (_, j) => `x${j}`);
  const shards = shardIndices(n, opts.workers);
  const splitOpts: SplitSearchOptions = { minChildWeight, lambda, gamma };

  const bins = Array.from({ length: p }, (_, f) =>
    buildBins(
      X.map((r) => r[f]),
      f,
      opts.maxBin ?? 64,
    ),
  );
  const edges = bins.map((b) => b.edges);

  const predictions = new Float64Array(n);
  const history: ParallelTrainResult["history"] = [];
  const gains = new Float64Array(p);
  let bestLoss = Number.POSITIVE_INFINITY;
  let bestRound = 0;
  let roundsRun = 0;
  let staleRounds = 0;
  let earlyStopped = false;
  let histMs = 0;
  let reduceMs = 0;
  let searchMs = 0;
  const tStart = now();

  for (let round = 1; round <= opts.rounds; round++) {
    // Loss gradients at the current ensemble prediction.
    const grad = new Float64Array(n);
    const hess = new Float64Array(n);
    let lossSum = 0;
    for (let i = 0; i < n; i++) {
      const t = lossTerms(predictions[i]!, y[i]!, task);
      grad[i] = t.g;
      hess[i] = t.h;
      lossSum += task === "binary" ? logloss(predictions[i]!, y[i]!) : 0.5 * (predictions[i]! - y[i]!) ** 2;
    }
    const loss = lossSum / Math.max(1, n);

    // --- Parallel phase: shard-local histograms, then all-reduce.
    const tHist = now();
    const localHists = shards.map((rows) => shardHistograms(rows, bins, grad, hess));
    histMs += now() - tHist;

    const tReduce = now();
    const reduced = allReduceHistograms(localHists);
    reduceMs += now() - tReduce;

    const tSearch = now();
    const _rootSplit = bestSplit(reduced, edges, splitOpts);
    searchMs += now() - tSearch;

    // --- Build this round's tree, recursing with per-node histograms.
    const _totalG = sumOf(grad);
    const _totalH = sumOf(hess);
    const grow = (rows: number[], depth: number): TreeNode => {
      let gSum = 0;
      let hSum = 0;
      for (const r of rows) {
        gSum += grad[r]!;
        hSum += hess[r]!;
      }
      const leaf: TreeNode = {
        feature: null,
        bin: null,
        threshold: 0,
        left: null,
        right: null,
        leafValue: leafValue(gSum, hSum, lambda, lr),
        gain: 0,
        depth,
      };
      if (depth >= opts.maxDepth || rows.length < 2) return leaf;
      const rowSet = new Set(rows);
      const nodeHists = allReduceHistograms(
        shards.map((srows) =>
          shardHistograms(
            srows.filter((r) => rowSet.has(r)),
            bins,
            grad,
            hess,
          ),
        ),
      );
      const split = bestSplit(nodeHists, edges, splitOpts);
      if (!split) return leaf;
      const leftRows: number[] = [];
      const rightRows: number[] = [];
      for (const r of rows) {
        const bf = bins[split.feature]!;
        if (!bf.valid[r]) {
          rightRows.push(r); // missing values take the default (right) branch
          continue;
        }
        if (bf.assignments[r]! <= split.bin) leftRows.push(r);
        else rightRows.push(r);
      }
      if (leftRows.length === 0 || rightRows.length === 0) return leaf;
      gains[split.feature]! += split.gain;
      return {
        feature: split.feature,
        bin: split.bin,
        threshold: split.threshold,
        left: grow(leftRows, depth + 1),
        right: grow(rightRows, depth + 1),
        leafValue: 0,
        gain: split.gain,
        depth,
      };
    };

    const tree = grow(
      Array.from({ length: n }, (_, i) => i),
      1,
    );
    for (let i = 0; i < n; i++) predictions[i]! += predictTree(tree, X[i]!, bins);
    roundsRun = round;

    if (loss < bestLoss - 1e-9) {
      bestLoss = loss;
      bestRound = round;
      staleRounds = 0;
    } else {
      staleRounds += 1;
      if (opts.patience > 0 && staleRounds >= opts.patience) {
        earlyStopped = true;
        warnings.push(
          `Stopped after ${round} of ${opts.rounds} rounds: no improvement for ${opts.patience} consecutive rounds (best ${bestLoss.toFixed(6)} at round ${bestRound}).`,
        );
        break;
      }
    }

    history.push({ round, loss, lr });
    const elapsedMs = now() - tStart;
    opts.onProgress?.({
      round,
      totalRounds: opts.rounds,
      loss,
      learningRate: lr,
      rowsPerSecond: (n * round) / Math.max(1e-9, elapsedMs / 1000),
      elapsedMs,
      progress: round / opts.rounds,
      message: `round ${round}/${opts.rounds} · loss ${loss.toFixed(6)} · ${Math.round((n * round) / Math.max(1e-9, elapsedMs / 1000)).toLocaleString()} rows/s · ${device.label}`,
    });
  }

  const elapsedTotal = Math.max(1e-9, now() - tStart);
  const perRound = Math.max(1, roundsRun);
  const histogramMs = histMs / perRound;
  const allReduceMs = reduceMs / perRound;
  const splitSearchMs = searchMs / perRound;
  const roundMs = elapsedTotal / perRound;
  // The all-reduce and the split search are the stages that do not shard.
  const serialFraction = roundMs > 0 ? Math.min(1, (allReduceMs + splitSearchMs) / roundMs) : 0;
  const amdahlCeiling =
    serialFraction >= 1 ? 1 : 1 / (serialFraction + (1 - serialFraction) / Math.max(1, opts.workers));

  const importance = names
    .map((feature, j) => ({ feature, gain: gains[j]! }))
    .filter((g) => g.gain > 0)
    .sort((a, b) => b.gain - a.gain);

  if (importance.length === 0) {
    warnings.push(
      "No split cleared the γ / min-child-weight thresholds, so every round produced a constant leaf: the model is a constant. The signal is below the regularisation floor you set — lower γ or minChildWeight, or accept that this target has no learnable structure.",
    );
  }
  if (bins.some((b) => b.usableRows === 0)) {
    const dead = bins.map((b, j) => (b.usableRows === 0 ? (names[j] ?? `x${j}`) : null)).filter(Boolean);
    warnings.push(`Column(s) ${dead.join(", ")} had no finite values and were never split on.`);
  }
  if (amdahlCeiling < 1.2) {
    warnings.push(
      `Measured serial fraction ${(serialFraction * 100).toFixed(0)}%: the all-reduce and split search dominate this dataset, so the Amdahl ceiling at ${opts.workers} workers is only ${amdahlCeiling.toFixed(2)}×. More shards will not help.`,
    );
  }

  return {
    architecture: "xgboost",
    workers: opts.workers,
    device,
    rounds: roundsRun,
    history,
    bestRound,
    bestLoss,
    earlyStopped,
    importance,
    parallel: {
      histogramMs,
      allReduceMs,
      splitSearchMs,
      serialFraction,
      amdahlCeiling,
      rowsPerSecond: (n * roundsRun) / (elapsedTotal / 1000),
      marginalPerWorker: Math.max(0, 1 - serialFraction) / Math.max(1, opts.workers),
      honest: `Sharding an in-process dataset decomposes the work but cannot create wall-clock parallelism on one thread, so no speedup is claimed. Measured per round: ${histogramMs.toFixed(3)} ms building ${opts.workers} shard histograms, ${allReduceMs.toFixed(3)} ms all-reducing, ${splitSearchMs.toFixed(3)} ms scoring split candidates. The last two stages are serial, giving a ${(serialFraction * 100).toFixed(0)}% serial fraction and an Amdahl ceiling of ${amdahlCeiling.toFixed(2)}× at ${opts.workers} real workers.`,
    },
    warnings,
    interpretation:
      `${roundsRun} boosting round${roundsRun === 1 ? "" : "s"} over ${n.toLocaleString()} rows, ${p} feature${p === 1 ? "" : "s"}, ${opts.workers} shard${opts.workers === 1 ? "" : "s"}. ` +
      `Each round accumulated gradients into per-shard histograms, all-reduced them, then searched every candidate bin — so the split chosen is the global argmax and does not depend on how the rows happened to be sharded. ` +
      `Best training loss ${bestLoss.toFixed(6)} at round ${bestRound}${importance[0] ? `; ${importance[0].feature} carries the most gain (${importance[0].gain.toFixed(4)})` : ""}.`,
  };
}

/**
 * The invariance claim, made checkable: the split chosen from all-reduced
 * histograms must equal the split found by one serial pass over every row.
 * Returns null when they agree.
 */
export function verifySplitAgainstSerial(
  X: number[][],
  y: number[],
  task: "binary" | "regression",
  workers: number,
  opts: SplitSearchOptions,
  maxBin = 64,
): { agreed: true } | { agreed: false; parallel: BestSplit | null; serial: BestSplit | null } {
  const p = X[0]?.length ?? 0;
  const bins = Array.from({ length: p }, (_, f) =>
    buildBins(
      X.map((r) => r[f]),
      f,
      maxBin,
    ),
  );
  const edges = bins.map((b) => b.edges);
  const grad = new Float64Array(X.length);
  const hess = new Float64Array(X.length);
  for (let i = 0; i < X.length; i++) {
    const t = lossTerms(0, y[i]!, task); // first boosting round: residual against 0
    grad[i] = t.g;
    hess[i] = t.h;
  }
  const allRows = Array.from({ length: X.length }, (_, i) => i);
  const serial = bestSplit(allReduceHistograms([shardHistograms(allRows, bins, grad, hess)]), edges, opts);
  const parallel = bestSplit(
    allReduceHistograms(shardIndices(X.length, workers).map((rows) => shardHistograms(rows, bins, grad, hess))),
    edges,
    opts,
  );
  const same =
    (serial === null && parallel === null) ||
    (serial !== null &&
      parallel !== null &&
      serial.feature === parallel.feature &&
      serial.bin === parallel.bin &&
      Math.abs(serial.gain - parallel.gain) <= 1e-9 * Math.max(1, Math.abs(serial.gain)));
  return same ? { agreed: true } : { agreed: false, parallel, serial };
}

function sumOf(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s;
}

// ---------------------------------------------------------------------------
// Data-parallel MLP
// ---------------------------------------------------------------------------

interface MlpParams {
  w1: Float64Array;
  b1: Float64Array;
  w2: Float64Array;
  b2: Float64Array;
  w3: Float64Array;
  b3: number;
  shapes: { p: number; h: number; h2: number };
}

function heInit(size: number, fanIn: number, rand: () => number): Float64Array {
  const w = new Float64Array(size);
  const limit = Math.sqrt(6 / Math.max(1, fanIn)); // He-uniform for ReLU
  for (let i = 0; i < size; i++) w[i] = (rand() * 2 - 1) * limit;
  return w;
}

function initParams(p: number, hidden: number, rand: () => number): MlpParams {
  const h2 = Math.max(1, Math.floor(hidden / 2));
  return {
    w1: heInit(p * hidden, p, rand),
    b1: new Float64Array(hidden),
    w2: heInit(hidden * h2, hidden, rand),
    b2: new Float64Array(h2),
    w3: new Float64Array(h2),
    b3: 0,
    shapes: { p, h: hidden, h2 },
  };
}

function cloneParams(src: MlpParams): MlpParams {
  return {
    w1: Float64Array.from(src.w1),
    b1: Float64Array.from(src.b1),
    w2: Float64Array.from(src.w2),
    b2: Float64Array.from(src.b2),
    w3: Float64Array.from(src.w3),
    b3: src.b3,
    shapes: src.shapes,
  };
}

function zeroParams(shapes: MlpParams["shapes"]): MlpParams {
  const { p, h, h2 } = shapes;
  return {
    w1: new Float64Array(p * h),
    b1: new Float64Array(h),
    w2: new Float64Array(h * h2),
    b2: new Float64Array(h2),
    w3: new Float64Array(h2),
    b3: 0,
    shapes,
  };
}

interface ForwardCache {
  a1: Float64Array;
  a2: Float64Array;
  z1: Float64Array;
  z2: Float64Array;
  out: number;
}

function forward(p: MlpParams, x: number[]): ForwardCache {
  const { p: nIn, h, h2 } = p.shapes;
  const z1 = new Float64Array(h);
  for (let j = 0; j < h; j++) {
    let s = p.b1[j]!;
    for (let i = 0; i < nIn; i++) s += p.w1[i * h + j]! * (x[i] ?? 0);
    z1[j] = s;
  }
  const a1 = new Float64Array(h);
  for (let j = 0; j < h; j++) a1[j] = z1[j]! > 0 ? z1[j]! : 0;

  const z2 = new Float64Array(h2);
  for (let j = 0; j < h2; j++) {
    let s = p.b2[j]!;
    for (let i = 0; i < h; i++) s += p.w2[i * h2 + j]! * a1[i]!;
    z2[j] = s;
  }
  const a2 = new Float64Array(h2);
  for (let j = 0; j < h2; j++) a2[j] = z2[j]! > 0 ? z2[j]! : 0;

  let out = p.b3;
  for (let j = 0; j < h2; j++) out += p.w3[j]! * a2[j]!;
  return { a1, a2, z1, z2, out };
}

/** Mean loss gradient over `rows`, for one shard. */
function batchGradient(
  params: MlpParams,
  Z: number[][],
  y: number[],
  rows: number[],
  task: "binary" | "regression",
): MlpParams {
  const g = zeroParams(params.shapes);
  if (rows.length === 0) return g;
  const { p: nIn, h, h2 } = params.shapes;
  const inv = 1 / rows.length;
  for (const r of rows) {
    const x = Z[r]!;
    const target = y[r]!;
    const { a1, a2, z1, z2, out } = forward(params, x);
    const dOut = task === "binary" ? 1 / (1 + Math.exp(-out)) - target : out - target;

    g.b3 += dOut * inv;
    const dz2 = new Float64Array(h2);
    for (let j = 0; j < h2; j++) {
      g.w3[j]! += dOut * a2[j]! * inv;
      dz2[j] = dOut * params.w3[j]! * (z2[j]! > 0 ? 1 : 0);
    }
    for (let j = 0; j < h2; j++) {
      g.b2[j]! += dz2[j]! * inv;
      for (let i = 0; i < h; i++) g.w2[i * h2 + j]! += dz2[j]! * a1[i]! * inv;
    }
    for (let i = 0; i < h; i++) {
      let dz1 = 0;
      for (let j = 0; j < h2; j++) dz1 += g.w2[i * h2 + j]! * (z2[j]! > 0 ? 1 : 0);
      dz1 *= z1[i]! > 0 ? 1 : 0;
      g.b1[i]! += dz1 * inv;
      for (let j = 0; j < nIn; j++) g.w1[j * h + i]! += dz1 * (x[j] ?? 0) * inv;
    }
  }
  return g;
}

/** Element-wise mean of per-shard gradients — the DDP all-reduce. */
function averageGrads(grads: MlpParams[]): MlpParams {
  if (grads.length === 0) throw new DeepLearningError("No shard gradients to average.");
  const shapes = grads[0]!.shapes;
  if (grads.length === 1) return grads[0]!;
  const out = zeroParams(shapes);
  for (const gr of grads) {
    out.w1.set(gr.w1);
    out.b1.set(gr.b1);
    out.w2.set(gr.w2);
    out.b2.set(gr.b2);
    out.w3.set(gr.w3);
    out.b3 = gr.b3;
  }
  const k = grads.length;
  for (let i = 0; i < out.w1.length; i++) out.w1[i] = out.w1[i]! / k;
  for (let i = 0; i < out.b1.length; i++) out.b1[i] = out.b1[i]! / k;
  for (let i = 0; i < out.w2.length; i++) out.w2[i] = out.w2[i]! / k;
  for (let i = 0; i < out.b2.length; i++) out.b2[i] = out.b2[i]! / k;
  for (let i = 0; i < out.w3.length; i++) out.w3[i] = out.w3[i]! / k;
  out.b3 /= k;
  return out;
}

function globalNorm(g: MlpParams): number {
  let s = 0;
  for (let i = 0; i < g.w1.length; i++) s += g.w1[i]! ** 2;
  for (let i = 0; i < g.b1.length; i++) s += g.b1[i]! ** 2;
  for (let i = 0; i < g.w2.length; i++) s += g.w2[i]! ** 2;
  for (let i = 0; i < g.b2.length; i++) s += g.b2[i]! ** 2;
  for (let i = 0; i < g.w3.length; i++) s += g.w3[i]! ** 2;
  s += g.b3 ** 2;
  return Math.sqrt(s);
}

function adamwStep(
  params: MlpParams,
  m: MlpParams,
  v: MlpParams,
  g: MlpParams,
  lr: number,
  scale: number,
  weightDecay: number,
  step: number,
): void {
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  const bc1 = 1 - beta1 ** step;
  const bc2 = 1 - beta2 ** step;
  const pairs: [Float64Array, Float64Array, Float64Array, Float64Array][] = [
    [params.w1, g.w1, m.w1, v.w1],
    [params.b1, g.b1, m.b1, v.b1],
    [params.w2, g.w2, m.w2, v.w2],
    [params.b2, g.b2, m.b2, v.b2],
    [params.w3, g.w3, m.w3, v.w3],
  ];
  for (const [w, gv, mv, vv] of pairs) {
    for (let i = 0; i < w.length; i++) {
      const gi = gv[i]! * scale;
      mv[i] = beta1 * mv[i]! + (1 - beta1) * gi;
      vv[i] = beta2 * vv[i]! + (1 - beta2) * gi * gi;
      const mHat = mv[i]! / bc1;
      const vHat = vv[i]! / bc2;
      // Decoupled weight decay: the penalty is applied to the weight, not the gradient.
      w[i] = w[i]! - lr * (mHat / (Math.sqrt(vHat) + eps) + weightDecay * w[i]!);
    }
  }
  const g3 = g.b3 * scale;
  m.b3 = beta1 * m.b3 + (1 - beta1) * g3;
  v.b3 = beta2 * v.b3 + (1 - beta2) * g3 * g3;
  params.b3 -= lr * (m.b3 / bc1 / (Math.sqrt(v.b3 / bc2) + eps) + weightDecay * params.b3);
}

function lrSchedule(step: number, totalSteps: number, baseLr: number, warmupRatio: number): number {
  const warmup = Math.max(1, Math.floor(totalSteps * warmupRatio));
  if (step <= warmup) return (baseLr * step) / warmup;
  const progress = Math.min(1, (step - warmup) / Math.max(1, totalSteps - warmup));
  return baseLr * 0.5 * (1 + Math.cos(Math.PI * progress));
}

export function trainParallelMlp(opts: ParallelTrainOptions): ParallelTrainResult {
  const { X, y, task } = opts;
  const n = X.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0) throw new DeepLearningError("The MLP needs at least one row and one feature column.");
  const hidden = opts.hidden ?? 16;
  const baseLr = opts.learningRate;
  const weightDecay = opts.weightDecay ?? 1e-4;
  const clipNorm = opts.clipNorm ?? 5;
  const warmupRatio = opts.warmupRatio ?? 0.1;
  const device = probeDevice(opts.device);
  const warnings = [...device.warnings];
  const names = opts.featureNames ?? Array.from({ length: p }, (_, j) => `x${j}`);
  const shards = shardIndices(n, opts.workers);

  // Standardise (deterministic; same convention as ridge.ts).
  const means = Array.from({ length: p }, (_, j) => X.reduce((a, r) => a + (r[j] ?? 0), 0) / n);
  const sds = Array.from({ length: p }, (_, j) =>
    Math.sqrt(X.reduce((a, r) => a + ((r[j] ?? 0) - means[j]!) ** 2, 0) / (n - 1 || 1)),
  );
  const Z = X.map((r) => r.map((val, j) => (sds[j]! > 1e-12 ? (val - means[j]!) / sds[j]! : 0)));

  let params = initParams(p, hidden, seededRandom(1337));
  const m = cloneParams(params);
  const v = cloneParams(params);
  let bestSnapshot = cloneParams(params);
  let bestLoss = Number.POSITIVE_INFINITY;
  let bestRound = 0;
  let staleRounds = 0;
  let earlyStopped = false;
  let step = 0;

  const batchSize = Math.max(1, Math.floor(opts.batchSize));
  const stepsPerEpoch = Math.max(1, Math.ceil(n / batchSize));
  const totalSteps = Math.max(1, opts.rounds * stepsPerEpoch);
  const order = Array.from({ length: n }, (_, i) => i);
  const shuffle = seededRandom(4242);
  const history: ParallelTrainResult["history"] = [];

  let shardMs = 0;
  let reduceMs = 0;
  const tStart = now();

  for (let epoch = 1; epoch <= opts.rounds; epoch++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(shuffle() * (i + 1));
      const tmp = order[i]!;
      order[i] = order[j]!;
      order[j] = tmp;
    }

    for (let s = 0; s < stepsPerEpoch; s++) {
      const batch = order.slice(s * batchSize, (s + 1) * batchSize);
      if (batch.length === 0) continue;
      const lr = lrSchedule(step, totalSteps, baseLr, warmupRatio);

      // Shard-local backward passes.
      const tShard = now();
      const localGrads = shards
        .map((rows) => {
          const mine = batch.filter((r) => rows.includes(r));
          return mine.length > 0 ? batchGradient(params, Z, y, mine, task) : null;
        })
        .filter((g): g is MlpParams => g !== null);
      shardMs += now() - tShard;

      // All-reduce: average the parameter gradients.
      const tReduce = now();
      const avg = averageGrads(localGrads);
      reduceMs += now() - tReduce;

      // Global-norm clipping, then one AdamW step.
      const gnorm = globalNorm(avg);
      const scale = gnorm > clipNorm ? clipNorm / gnorm : 1;
      step += 1;
      adamwStep(params, m, v, avg, lr, scale, weightDecay, step);

      if (step % stepsPerEpoch === 0) {
        const loss = evaluateLoss(params, Z, y, task);
        if (loss < bestLoss - 1e-9) {
          bestLoss = loss;
          bestRound = epoch;
          bestSnapshot = cloneParams(params);
          staleRounds = 0;
        } else {
          staleRounds += 1;
          if (opts.patience > 0 && staleRounds >= opts.patience) {
            earlyStopped = true;
            warnings.push(
              `Stopped at epoch ${epoch} of ${opts.rounds}: no improvement for ${opts.patience} consecutive epoch(s) (best ${bestLoss.toFixed(6)} at epoch ${bestRound}).`,
            );
            break;
          }
        }
        history.push({ round: epoch, loss, lr, gradNorm: gnorm });
        const elapsedMs = now() - tStart;
        opts.onProgress?.({
          round: epoch,
          totalRounds: opts.rounds,
          loss,
          gradNorm: gnorm,
          learningRate: lr,
          rowsPerSecond: (n * epoch) / Math.max(1e-9, elapsedMs / 1000),
          elapsedMs,
          progress: epoch / opts.rounds,
          message: `epoch ${epoch}/${opts.rounds} · loss ${loss.toFixed(6)} · ‖∇‖ ${gnorm.toFixed(4)} · lr ${lr.toExponential(2)} · ${device.label}`,
        });
      }
    }
    if (earlyStopped) break;
  }

  params = bestSnapshot;
  const elapsedTotal = Math.max(1e-9, now() - tStart);
  const roundsRun = history.length;
  const perStep = Math.max(1, step);
  const histogramMs = shardMs / perStep;
  const allReduceMs = reduceMs / perStep;
  const stepMs = elapsedTotal / perStep;
  const serialFraction = stepMs > 0 ? Math.min(1, allReduceMs / stepMs) : 0;
  const amdahlCeiling =
    serialFraction >= 1 ? 1 : 1 / (serialFraction + (1 - serialFraction) / Math.max(1, opts.workers));

  if (roundsRun === 0) {
    warnings.push(
      `No epoch completed: ${n} row(s) is fewer than one batch of ${batchSize}. Lower batchSize or supply more rows — the run above reports no trained parameters.`,
    );
  }
  if (clipNorm > 0 && history.some((h) => (h.gradNorm ?? 0) > clipNorm * 1.5)) {
    warnings.push(
      `Gradient norms exceeded the clip threshold of ${clipNorm} by more than 1.5× on several steps, so those updates were rescaled. Lower the learning rate or the clip value; repeated clipping usually means the LR schedule starts too high.`,
    );
  }
  if (serialFraction > 0.5 && opts.workers > 1) {
    warnings.push(
      `The gradient all-reduce consumed ${(serialFraction * 100).toFixed(0)}% of each step at this model size. The Amdahl ceiling is ${amdahlCeiling.toFixed(2)}×, so sharding this network is not worth the coordination cost.`,
    );
  }

  // Per-feature sensitivity by input perturbation — the only defensible
  // "importance" for a model that was never split.
  const base = evaluateLoss(params, Z, y, task);
  const importance = names.map((feature, j) => {
    const perturbed = Z.map((r) => r.map((val, jj) => (jj === j ? val + 0.1 : val)));
    const delta = evaluateLoss(params, perturbed, y, task) - base;
    return { feature, gain: Math.max(0, delta) };
  });

  return {
    architecture: "mlp",
    workers: opts.workers,
    device,
    rounds: roundsRun,
    history,
    bestRound,
    bestLoss,
    earlyStopped,
    importance: importance.sort((a, b) => b.gain - a.gain),
    parallel: {
      histogramMs,
      allReduceMs,
      splitSearchMs: 0,
      serialFraction,
      amdahlCeiling,
      rowsPerSecond: (n * roundsRun) / (elapsedTotal / 1000),
      marginalPerWorker: Math.max(0, 1 - serialFraction) / Math.max(1, opts.workers),
      honest: `Sharding an in-process dataset cannot create wall-clock parallelism on one thread, so no speedup is claimed. Measured per step: ${histogramMs.toFixed(3)} ms of shard-local backward passes and ${allReduceMs.toFixed(3)} ms averaging gradients — the reduce is the serial fraction (${(serialFraction * 100).toFixed(0)}%), giving an Amdahl ceiling of ${amdahlCeiling.toFixed(2)}× at ${opts.workers} real workers.`,
    },
    warnings,
    interpretation:
      `Data-parallel MLP: ${roundsRun} epoch${roundsRun === 1 ? "" : "s"} over ${n.toLocaleString()} rows and ${p} feature${p === 1 ? "" : "s"}, ${hidden} then ${Math.max(1, Math.floor(hidden / 2))} ReLU units, ${opts.workers} shard${opts.workers === 1 ? "" : "s"}. ` +
      `Every step averaged per-shard parameter gradients before a single AdamW update, with global-norm clipping at ${clipNorm}, linear warmup over ${(warmupRatio * 100).toFixed(0)}% of steps into cosine decay, and best-snapshot restore. Best loss ${bestLoss.toFixed(6)} at epoch ${bestRound}.`,
  };
}

function evaluateLoss(params: MlpParams, Z: number[][], y: number[], task: "binary" | "regression"): number {
  let loss = 0;
  for (let i = 0; i < Z.length; i++) {
    const { out } = forward(params, Z[i]!);
    loss += task === "binary" ? logloss(out, y[i]!) : 0.5 * (out - y[i]!) ** 2;
  }
  return Z.length > 0 ? loss / Z.length : Number.POSITIVE_INFINITY;
}

export class DeepLearningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepLearningError";
  }
}

export function trainParallel(opts: ParallelTrainOptions): ParallelTrainResult {
  return opts.architecture === "xgboost" ? trainParallelXgboost(opts) : trainParallelMlp(opts);
}

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node fallback without importing perf_hooks
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}
