/**
 * True neural network — a real multi-layer perceptron trained by backprop.
 *
 * `deep-learning.ts` is a distributed histogram-GBM (a gradient-boosted tree
 * ensemble, however parallelised). It is NOT a neural net. This engine is:
 *
 *  1. A dense MLP (arbitrary layer sizes, relu/tanh/sigmoid hidden, linear/
 *     sigmoid/softmax output) trained by genuine reverse-mode backprop —
 *     every ∂loss/∂weight is computed by the chain rule through the graph,
 *     not by numeric approximation;
 *  2. Deterministic: initialisation uses a seeded PRNG, so a run with the
 *     same seed and data is bit-identical — the repo's reproducibility bar;
 *  3. Verifiable: `numericalGradient` exposes central-difference gradients so
 *     the oracle test can prove backprop against a numeric gradient check,
 *     the same way SciPy's check_grad works.
 *
 * No GPU, no autodiff graph, no frameworks — just the real maths, honestly
 * labelled. Single-node scale: this trains toy-to-moderate nets, not foundation
 * models, and the header says so.
 */

export class NeuralNetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeuralNetError";
  }
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic initialisation
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
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
// Types
// ---------------------------------------------------------------------------

export type HiddenActivation = "relu" | "tanh" | "sigmoid";
export type OutputActivation = "linear" | "sigmoid" | "softmax";
export type LossKind = "mse" | "cross-entropy";

export interface Layer {
  /** weights[out][in] */
  w: number[][];
  b: number[];
}

export interface Mlp {
  sizes: number[];
  hiddenActivation: HiddenActivation;
  outputActivation: OutputActivation;
  layers: Layer[];
}

const gauss = (rnd: () => number): number => {
  // Box–Muller with the seeded uniform.
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/** He initialisation (sqrt(2/fan_in)) — the standard for relu; tanh/sigmoid use Xavier. */
export function initMlp(
  sizes: number[],
  hiddenActivation: HiddenActivation,
  outputActivation: OutputActivation,
  seed: number,
): Mlp {
  if (sizes.length < 2) throw new NeuralNetError("An MLP needs at least input and output layers.");
  if (sizes.some((s) => s < 1)) throw new NeuralNetError("Layer sizes must be positive.");
  const rnd = mulberry32(seed);
  const layers: Layer[] = [];
  for (let l = 0; l < sizes.length - 1; l++) {
    const fanIn = sizes[l]!;
    const scale = hiddenActivation === "relu" ? Math.sqrt(2 / fanIn) : Math.sqrt(1 / fanIn);
    const w: number[][] = [];
    for (let o = 0; o < sizes[l + 1]!; o++) {
      w.push(Array.from({ length: fanIn }, () => gauss(rnd) * scale));
    }
    layers.push({ w, b: Array.from({ length: sizes[l + 1]! }, () => 0) });
  }
  return { sizes: [...sizes], hiddenActivation, outputActivation, layers };
}

// ---------------------------------------------------------------------------
// Forward pass — activations retained for backprop
// ---------------------------------------------------------------------------

const applyAct = (xs: number[], act: HiddenActivation | OutputActivation): number[] => {
  switch (act) {
    case "relu":
      return xs.map((x) => (x > 0 ? x : 0));
    case "tanh":
      return xs.map(Math.tanh);
    case "sigmoid":
      return xs.map((x) => 1 / (1 + Math.exp(-x)));
    case "linear":
      return [...xs];
    case "softmax": {
      const m = Math.max(...xs);
      const exps = xs.map((x) => Math.exp(x - m));
      const s = exps.reduce((a, b) => a + b, 0);
      return exps.map((e) => e / s);
    }
  }
};

export interface ForwardTrace {
  /** Pre-activations per layer (z). */
  zs: number[][];
  /** Post-activations per layer (a), a[0] = input. */
  as: number[][];
  output: number[];
}

export function forward(net: Mlp, input: readonly number[]): ForwardTrace {
  if (input.length !== net.sizes[0]) {
    throw new NeuralNetError(`Input dimension ${input.length} != expected ${net.sizes[0]}.`);
  }
  const zs: number[][] = [];
  const as: number[][] = [[...input]];
  let a = as[0]!;
  for (let l = 0; l < net.layers.length; l++) {
    const layer = net.layers[l]!;
    const isOutput = l === net.layers.length - 1;
    const act = isOutput ? net.outputActivation : net.hiddenActivation;
    const z = layer.w.map((row, o) => row.reduce((s, wi, i) => s + wi * a[i]!, 0) + layer.b[o]!);
    zs.push(z);
    a = applyAct(z, act);
    as.push(a);
  }
  return { zs, as, output: a };
}

const dAct = (z: number, act: HiddenActivation | OutputActivation, softmaxRow?: { y: number; s: number }): number => {
  switch (act) {
    case "relu":
      return z > 0 ? 1 : 0;
    case "tanh":
      return 1 - Math.tanh(z) ** 2;
    case "sigmoid": {
      const s = 1 / (1 + Math.exp(-z));
      return s * (1 - s);
    }
    case "linear":
      return 1;
    case "softmax":
      // Handled inline in backprop (full Jacobian row), never per-element.
      return softmaxRow ? softmaxRow.y * (1 - softmaxRow.y) : 1;
  }
};

// ---------------------------------------------------------------------------
// Loss
// ---------------------------------------------------------------------------

export function lossOf(net: Mlp, pred: readonly number[], target: readonly number[]): number {
  if (pred.length !== target.length) throw new NeuralNetError("Prediction/target length mismatch.");
  if (
    net.outputActivation === "softmax" ||
    (net.outputActivation === "sigmoid" && target.some((t) => t === 0 || t === 1))
  ) {
    if (net.outputActivation === "softmax") {
      // Cross-entropy with softmax: -Σ t·log(p)
      let l = 0;
      for (let i = 0; i < pred.length; i++) {
        if (target[i]! > 0) l -= target[i]! * Math.log(Math.max(pred[i]!, 1e-12));
      }
      return l;
    }
  }
  let s = 0;
  for (let i = 0; i < pred.length; i++) {
    const d = pred[i]! - target[i]!;
    s += d * d;
  }
  return s / pred.length;
}

/** dL/d(output-activation-input) — combined output-layer delta. */
function outputDelta(net: Mlp, z: number[], pred: number[], target: number[]): number[] {
  const n = pred.length;
  if (net.outputActivation === "softmax") {
    // dL/dz_i = p_i − t_i  (softmax + cross-entropy)
    return pred.map((p, i) => p - target[i]!);
  }
  if (net.outputActivation === "sigmoid") {
    // MSE + sigmoid: dL/dz = 2(p−t)/n · σ'(z)
    return pred.map((p, i) => ((2 * (p - target[i]!)) / n) * dAct(z[i]!, "sigmoid"));
  }
  // linear + MSE
  return pred.map((p, i) => (2 * (p - target[i]!)) / n);
}

// ---------------------------------------------------------------------------
// Backprop — one (x, y) pair → gradients over every weight/bias
// ---------------------------------------------------------------------------

export interface Grads {
  /** dL/dw per layer, same shape as net layers. */
  dw: number[][][];
  db: number[][];
}

export function backward(net: Mlp, input: readonly number[], target: readonly number[]): Grads {
  const trace = forward(net, input);
  const L = net.layers.length;
  const dw: number[][][] = net.layers.map((layer) => layer.w.map((row) => row.map(() => 0)));
  const db: number[][] = net.layers.map((layer) => layer.b.map(() => 0));

  let delta: number[] = outputDelta(net, trace.zs[L - 1]!, trace.output, [...target]);

  for (let l = L - 1; l >= 0; l--) {
    const aPrev = trace.as[l]!;
    for (let o = 0; o < delta.length; o++) {
      db[l]![o]! += delta[o]!;
      for (let i = 0; i < aPrev.length; i++) {
        dw[l]![o]![i]! += delta[o]! * aPrev[i]!;
      }
    }
    if (l > 0) {
      // Propagate: δ_prev = (W^T δ) ⊙ act'(z_prev)
      const zPrev = trace.zs[l - 1]!;
      const next: number[] = new Array(net.sizes[l]!).fill(0);
      for (let i = 0; i < net.sizes[l]!; i++) {
        let s = 0;
        for (let o = 0; o < delta.length; o++) s += net.layers[l]!.w[o]![i]! * delta[o]!;
        next[i] = s * dAct(zPrev[i]!, net.hiddenActivation);
      }
      delta = next;
    }
  }
  return { dw, db };
}

// ---------------------------------------------------------------------------
// Numerical gradient (central differences) — for the oracle gradient check
// ---------------------------------------------------------------------------

export function numericalGradient(net: Mlp, input: readonly number[], target: readonly number[], eps = 1e-5): Grads {
  const f = (): number => lossOf(net, forward(net, input).output, [...target]);
  const dw: number[][][] = net.layers.map((layer) => layer.w.map((row) => row.map(() => 0)));
  const db: number[][] = net.layers.map((layer) => layer.b.map(() => 0));
  for (let l = 0; l < net.layers.length; l++) {
    for (let o = 0; o < net.layers[l]!.w.length; o++) {
      for (let i = 0; i < net.layers[l]!.w[o]!.length; i++) {
        const orig = net.layers[l]!.w[o]![i]!;
        net.layers[l]!.w[o]![i] = orig + eps;
        const plus = f();
        net.layers[l]!.w[o]![i] = orig - eps;
        const minus = f();
        net.layers[l]!.w[o]![i] = orig;
        dw[l]![o]![i] = (plus - minus) / (2 * eps);
      }
      const origB = net.layers[l]!.b[o]!;
      net.layers[l]!.b[o] = origB + eps;
      const plusB = f();
      net.layers[l]!.b[o] = origB - eps;
      const minusB = f();
      net.layers[l]!.b[o] = origB;
      db[l]![o] = (plusB - minusB) / (2 * eps);
    }
  }
  return { dw, db };
}

// ---------------------------------------------------------------------------
// Adam optimiser + training loop (mini-batch, deterministic shuffling)
// ---------------------------------------------------------------------------

interface AdamState {
  mW: number[][][];
  vW: number[][][];
  mB: number[][];
  vB: number[][];
  t: number;
}

export interface TrainOptions {
  epochs: number;
  batchSize: number;
  lr: number;
  beta1?: number;
  beta2?: number;
  epsAdam?: number;
  /** Ordered dataset; shuffling is seeded, never Math.random. */
  inputs: number[][];
  targets: number[][];
  seed?: number;
}

export interface TrainResult {
  net: Mlp;
  /** Mean loss per epoch. */
  lossHistory: number[];
  finalLoss: number;
  steps: number;
}

export function trainMlp(net: Mlp, opts: TrainOptions): TrainResult {
  const { epochs, batchSize, lr, inputs, targets } = opts;
  const beta1 = opts.beta1 ?? 0.9;
  const beta2 = opts.beta2 ?? 0.999;
  const epsAdam = opts.epsAdam ?? 1e-8;
  const n = inputs.length;
  if (n === 0 || n !== targets.length)
    throw new NeuralNetError("inputs and targets must be non-empty and equal length.");

  const adam: AdamState = {
    mW: net.layers.map((l) => l.w.map((r) => r.map(() => 0))),
    vW: net.layers.map((l) => l.w.map((r) => r.map(() => 0))),
    mB: net.layers.map((l) => l.b.map(() => 0)),
    vB: net.layers.map((l) => l.b.map(() => 0)),
    t: 0,
  };

  const rnd = mulberry32(opts.seed ?? 42);
  const order = Array.from({ length: n }, (_, i) => i);
  const lossHistory: number[] = [];
  let steps = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Fisher–Yates with the seeded PRNG.
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = order[i]!;
      order[i] = order[j]!;
      order[j] = tmp;
    }
    let epochLoss = 0;
    for (let start = 0; start < n; start += batchSize) {
      const batch = order.slice(start, start + batchSize);
      const gSum = {
        dw: net.layers.map((l) => l.w.map((r) => r.map(() => 0))),
        db: net.layers.map((l) => l.b.map(() => 0)),
      };
      for (const idx of batch) {
        const g = backward(net, inputs[idx]!, targets[idx]!);
        epochLoss += lossOf(net, forward(net, inputs[idx]!).output, targets[idx]!);
        for (let l = 0; l < net.layers.length; l++) {
          for (let o = 0; o < g.dw[l]!.length; o++) {
            for (let i = 0; i < g.dw[l]![o]!.length; i++) gSum.dw[l]![o]![i]! += g.dw[l]![o]![i]!;
            gSum.db[l]![o]! += g.db[l]![o]!;
          }
        }
      }
      const m = batch.length;
      adam.t += 1;
      const bc1 = 1 - Math.pow(beta1, adam.t);
      const bc2 = 1 - Math.pow(beta2, adam.t);
      for (let l = 0; l < net.layers.length; l++) {
        for (let o = 0; o < net.layers[l]!.w.length; o++) {
          for (let i = 0; i < net.layers[l]!.w[o]!.length; i++) {
            const g = gSum.dw[l]![o]![i]! / m;
            adam.mW[l]![o]![i] = beta1 * adam.mW[l]![o]![i]! + (1 - beta1) * g;
            adam.vW[l]![o]![i] = beta2 * adam.vW[l]![o]![i]! + (1 - beta2) * g * g;
            const mHat = adam.mW[l]![o]![i]! / bc1;
            const vHat = adam.vW[l]![o]![i]! / bc2;
            net.layers[l]!.w[o]![i]! -= (lr * mHat) / (Math.sqrt(vHat) + epsAdam);
          }
          const gb = gSum.db[l]![o]! / m;
          adam.mB[l]![o] = beta1 * adam.mB[l]![o]! + (1 - beta1) * gb;
          adam.vB[l]![o] = beta2 * adam.vB[l]![o]! + (1 - beta2) * gb * gb;
          const mHatB = adam.mB[l]![o]! / bc1;
          const vHatB = adam.vB[l]![o]! / bc2;
          net.layers[l]!.b[o]! -= (lr * mHatB) / (Math.sqrt(vHatB) + epsAdam);
        }
      }
      steps += 1;
    }
    const mean = epochLoss / n;
    lossHistory.push(mean);
  }
  const finalLoss = lossOf(net, forward(net, inputs[0]!).output, targets[0]!);
  return { net, lossHistory, finalLoss, steps };
}
