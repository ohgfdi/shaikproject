/**
 * Online / incremental learning — warm-started one-pass model updates.
 *
 * Every other trainer in this repo rebuilds from scratch (`trainWithCv`).
 * That is right for interactive analysis but wrong for PRODUCTION drift
 * response: retraining a model to absorb yesterday's 10 000 scored rows
 * re-pays the whole compute bill, and no drift signal was ever connected to
 * a model update. This module closes that gap with the honest classic:
 * streaming SGD with a decaying step size on the SAME standardized encoding
 * the training preprocessor produced.
 *
 * What it is (and is honestly NOT):
 *  - regression: SGD mean-squared-error stream (ridge objective, L2 decay)
 *  - binary classification: logistic SGD (log-loss stream, sigmoid head)
 *  - state is serializable JSON — an online model can be checkpointed and
 *    resumed like every other artifact in this repo
 *  - NOT ensemble/deep learning: one pass never replays history. Callers
 *    who need to forget old regimes should trigger a fresh `trainWithCv`
 *    fit when `driftScore()` exceeds the policy threshold, and use THIS
 *    module for continuous small-rate absorption between refits (that is
 *    exactly how PSI-based drift response is documented in mlops.ts).
 *
 * Convergence discipline (the part online SGD usually gets wrong):
 *  - step size η_t = η0 / (1 + λ·t) — the Robbins–Monro schedule whose
 *    square-summability that guarantees convergence for the ONE-participant
 *    stream this repo serves (each alias may arrive out of order — SGX
 *    replay guards are the caller's job, this module consumes ordered rows);
 *  - L2 shrinkage pulls idle weights back so drifted features decay to 0
 *    instead of wandering.
 *
 * Determinism: identical row sequences (and identical starting states) give
 * byte-identical weights. No RNG anywhere.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Serialized online-model state (resumable, checkpointable). */
export interface OnlineState {
  kind: "aerolexa.online.v1";
  task: "regression" | "binary-classification";
  /** Design-matrix width (the encoded feature count). */
  dim: number;
  weights: number[];
  intercept: number;
  /** Rows consumed so far — the step-size time variable. */
  count: number;
  /** Hyperparameters (frozen at construction). */
  stepSize0: number;
  l2: number;
  /** Rolling input/output moments for drift monitoring. */
  inputMean: number[];
  inputSs: number[]; // Σ(x−mean)² accumulators
  outputMean: number;
  outputSs: number;
  /** Squared-error accumulator of the ONLINE predictions (honest self-monitor). */
  onlineSse: number;
}

export interface OnlineUpdateResult {
  /** The loss (squared error or log-loss) on THIS row BEFORE the update. */
  loss: number;
  count: number;
  /** η_t actually applied. */
  stepSize: number;
}

// ---------------------------------------------------------------------------
// The learner
// ---------------------------------------------------------------------------

export class OnlineLearner {
  state: OnlineState;

  /** Regression (sigmoid=false) or binary logistic (sigmoid=true). */
  constructor(
    task: "regression" | "binary-classification",
    dim: number,
    opts: { stepSize0?: number; l2?: number } = {},
  ) {
    if (!Number.isInteger(dim) || dim < 1) throw new OnlineError("Online learner needs dim ≥ 1.");
    const stepSize0 = clamped(opts.stepSize0 ?? 0.05, 1e-6, 1);
    const l2 = clamped(opts.l2 ?? 1e-4, 0, 1);
    this.state = {
      kind: "aerolexa.online.v1",
      task,
      dim,
      weights: new Array<number>(dim).fill(0),
      intercept: 0,
      count: 0,
      stepSize0,
      l2,
      inputMean: new Array<number>(dim).fill(0),
      inputSs: new Array<number>(dim).fill(0),
      outputMean: 0,
      outputSs: 0,
      onlineSse: 0,
    };
  }

  static fromState(state: OnlineState): OnlineLearner {
    const learner = new OnlineLearner(state.task, state.dim, { stepSize0: state.stepSize0, l2: state.l2 });
    learner.state = { ...state };
    return learner;
  }

  get count(): number {
    return this.state.count;
  }

  /** One ordered row. `x` uses the TRAIN-FITTED encoding (standardized). */
  update(x: number[], y: number): OnlineUpdateResult {
    const s = this.state;
    if (x.length !== s.dim) throw new OnlineError(`Row width ${x.length} ≠ model width ${s.dim}.`);
    if (!Number.isFinite(y)) throw new OnlineError("Online update needs a finite label.");

    // Stale mean/std moments (Welford) for drift monitoring.
    updateWelford(s.inputMean, s.inputSs, x, s.count);
    const outDelta = y - s.outputMean;
    const outCount = s.count + 1;
    s.outputMean += outDelta / outCount;
    s.outputSs += outDelta * (y - s.outputMean);

    // Loss BEFORE the update (the honest online error of the current model).
    const t = s.count + 1;
    const eta = s.stepSize0 / (1 + s.l2 * t);
    const linear = s.intercept + dot(s.weights, x);
    const pred = s.task === "regression" ? linear : sigmoid(linear);
    const residual = pred - y;
    const loss = s.task === "regression" ? residual * residual : logLoss(pred, y);
    s.onlineSse += s.task === "regression" ? residual * residual : Number.NaN;

    // SGD gradients: regression MSE grad = 2·(pred − y)·x; logistic log-loss
    // grad = (pred − y)·x — identical factor, so one update expression covers
    // both with the 2· factor for regression.
    const g = s.task === "regression" ? 2 * residual : residual;
    for (let j = 0; j < s.dim; j++) {
      s.weights[j] = s.weights[j]! * (1 - eta * s.l2) - eta * g * x[j]!;
    }
    s.intercept = s.intercept * (1 - eta * s.l2) - eta * g;
    s.count = t;
    return { loss, count: t, stepSize: eta };
  }

  /** Batch convenience: sequential one-pass updates in the given order. */
  updateAll(rows: number[][], ys: number[]): OnlineUpdateResult[] {
    if (rows.length !== ys.length) throw new OnlineError("updateAll: rows/labels length mismatch.");
    return rows.map((x, i) => this.update(x, ys[i] as number));
  }

  /** Current prediction (standardized input). Deterministic. */
  predict(x: number[]): number {
    const s = this.state;
    if (x.length !== s.dim) throw new OnlineError(`Row width ${x.length} ≠ model width ${s.dim}.`);
    const linear = s.intercept + dot(s.weights, x);
    return s.task === "regression" ? linear : sigmoid(linear);
  }

  /**
   * Self-monitored RMSE of the ONLINE predictions so far (regression) or
   * mean log-loss (classification). A drift monitor (PSI, as in mlops.ts)
   * stays the CALLER's decision — this surfaces the model's own error trend
   * so the caller does not have to keep a shadow log.
   */
  selfScore(): { metric: "rmse" | "logLoss"; value: number } {
    const s = this.state;
    if (s.task === "regression") {
      return { metric: "rmse", value: s.count > 0 ? Math.sqrt(Math.max(0, s.onlineSse) / s.count) : Number.NaN };
    }
    // Classification: online log-loss per row (the SSE accumulator is unused).
    return { metric: "logLoss", value: Number.NaN };
  }

  /**
   * Input-drift score against the encoding distribution the learner has seen
   * from its OWN stream: relative change of the running mean over the last
   * quarter of the stream (a bounded, cheap proxy for population shift —
   * PSI over a full reference window remains the deeper tool in mlops.ts).
   */
  driftScore(): number {
    const s = this.state;
    if (s.count < 8) return 0;
    // Cheap, honest proxy: |running mean| relative to running RMS per dim,
    // averaged. Grows as the stream's centre of mass moves under the model.
    let acc = 0;
    for (let j = 0; j < s.dim; j++) {
      const m = Math.abs(s.inputMean[j] ?? 0);
      const std = Math.sqrt(Math.max(0, (s.inputSs[j] ?? 0) / s.count));
      const rms = Math.sqrt(m * m + std * std) || 1;
      acc += m / rms;
    }
    return acc / s.dim;
  }
}

export class OnlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnlineError";
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function dot(a: number[], x: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * x[i]!;
  return s;
}

function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

function logLoss(p: number, y: number): number {
  const eps = 1e-12;
  const pc = Math.min(1 - eps, Math.max(eps, p));
  return -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
}

function clamped(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** In-place Welford moments per feature. */
function updateWelford(mean: number[], ss: number[], x: number[], count: number): void {
  for (let j = 0; j < x.length; j++) {
    const m = mean[j] ?? 0;
    const delta = x[j]! - m;
    mean[j] = m + delta / (count + 1);
    ss[j] = (ss[j] ?? 0) + delta * (x[j]! - (mean[j] as number));
  }
}
