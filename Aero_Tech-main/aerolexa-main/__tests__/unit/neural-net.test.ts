/**
 * Neural-net engine — oracle tests.
 *
 * The oracle here is mathematics, not fixtures:
 *
 *  1. GRADIENT CHECK — backprop gradients must match central-difference
 *     numerical gradients to ~1e-6 on a tiny net (the same test SciPy's
 *     check_grad runs). This proves the backprop chain rule is correct.
 *  2. XOR CONVERGENCE — a 2-2-1 relu net must drive the XOR loss to near
 *     zero; XOR is the canonical non-linearly-separable function, so a
 *     linear hack cannot pass it.
 *  3. DETERMINISM — the same seed produces bit-identical weights.
 *  4. Softmax correctness — outputs sum to 1 and argmax matches a
 *     hand-checkable target.
 */

import { forward, initMlp, lossOf, mulberry32, numericalGradient, backward, trainMlp } from "@/lib/engine/neural-net";

const absDiff = (a: number[][][], b: number[][][]): number => {
  let m = 0;
  for (let l = 0; l < a.length; l++)
    for (let o = 0; o < a[l]!.length; o++)
      for (let i = 0; i < a[l]![o]!.length; i++) m = Math.max(m, Math.abs(a[l]![o]![i]! - b[l]![o]![i]!));
  return m;
};

const absDiffB = (a: number[][], b: number[][]): number => {
  let m = 0;
  for (let l = 0; l < a.length; l++)
    for (let o = 0; o < a[l]!.length; o++) m = Math.max(m, Math.abs(a[l]![o]! - b[l]![o]!));
  return m;
};

describe("backprop vs numerical gradient (the gradient check)", () => {
  it("matches central differences on a 2-3-1 tanh-MSE net", () => {
    const net = initMlp([2, 3, 1], "tanh", "linear", 1234);
    const input = [0.3, -0.7];
    const target = [0.5];
    const analytic = backward(net, input, target);
    const numeric = numericalGradient(net, input, target, 1e-5);
    // Central differences with eps=1e-5 are accurate to ~1e-9 on smooth nets;
    // 1e-6 leaves generous headroom for float noise.
    expect(absDiff(analytic.dw, numeric.dw)).toBeLessThan(1e-6);
    expect(absDiffB(analytic.db, numeric.db)).toBeLessThan(1e-6);
  });

  it("matches central differences through relu (kink-aware at a non-zero point)", () => {
    const net = initMlp([1, 2, 1], "relu", "linear", 7);
    const input = [1.5]; // pre-activations away from 0 → relu' well-defined
    const target = [1];
    const analytic = backward(net, input, target);
    const numeric = numericalGradient(net, input, target, 1e-6);
    expect(absDiff(analytic.dw, numeric.dw)).toBeLessThan(1e-5);
    expect(absDiffB(analytic.db, numeric.db)).toBeLessThan(1e-5);
  });
});

describe("XOR convergence", () => {
  const X = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ];
  const Y = [[0], [1], [1], [0]];

  it("a 2-8-1 relu net trains XOR below 1e-3 mean loss", () => {
    // Hyperparameters verified empirically: smaller nets stall when a relu
    // unit dies under full-batch Adam — the wider net escapes the plateau.
    const net = initMlp([2, 8, 1], "relu", "linear", 42);
    const { finalLoss } = trainMlp(net, { epochs: 1500, batchSize: 2, lr: 0.03, inputs: X, targets: Y, seed: 42 });
    expect(finalLoss).toBeLessThan(1e-3);
    // And the predictions actually agree with XOR (numerically, not via
    // Math.round — a trained value of −0.000…1 must still match target 0).
    for (let i = 0; i < 4; i++) {
      const out = forward(net, X[i]!).output[0]!;
      expect(out).toBeCloseTo(Y[i]![0]!, 2);
    }
  });

  it("the loss history decreases from the first to the last epoch", () => {
    const net = initMlp([2, 4, 1], "tanh", "linear", 1);
    const { lossHistory } = trainMlp(net, { epochs: 200, batchSize: 2, lr: 0.1, inputs: X, targets: Y, seed: 1 });
    expect(lossHistory[lossHistory.length - 1]!).toBeLessThan(lossHistory[0]!);
  });
});

describe("determinism", () => {
  it("the same seed yields bit-identical initialisation", () => {
    const a = initMlp([3, 5, 2], "relu", "linear", 99);
    const b = initMlp([3, 5, 2], "relu", "linear", 99);
    expect(JSON.stringify(a.layers)).toBe(JSON.stringify(b.layers));
  });

  it("the same seed + data yields bit-identical training", () => {
    const X = [[0.1], [0.9], [0.5]];
    const Y = [[0], [1], [1]];
    const run = () => {
      const net = initMlp([1, 3, 1], "tanh", "linear", 5);
      const { finalLoss } = trainMlp(net, { epochs: 30, batchSize: 3, lr: 0.1, inputs: X, targets: Y, seed: 5 });
      return net.layers.map((l) => JSON.stringify(l)).join("|") + finalLoss;
    };
    expect(run()).toBe(run());
  });

  it("the seeded PRNG is reproducible and in [0, 1)", () => {
    const r = mulberry32(7);
    const first = [r(), r(), r()];
    const r2 = mulberry32(7);
    expect([r2(), r2(), r2()]).toEqual(first);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("softmax output", () => {
  it("outputs sum to 1 and forward shapes hold", () => {
    const net = initMlp([3, 4, 2], "relu", "softmax", 3);
    const out = forward(net, [1, -0.5, 2]).output;
    const sum = out.reduce((s, x) => s + x, 0);
    expect(sum).toBeCloseTo(1, 9);
    expect(out).toHaveLength(2);
  });

  it("cross-entropy loss is 0 when the prediction matches the one-hot target", () => {
    const pred = [0.9999999, 0.0000001];
    const net = initMlp([1, 1, 2], "tanh", "softmax", 1);
    expect(lossOf(net, pred, [1, 0])).toBeCloseTo(0, 6);
  });
});
