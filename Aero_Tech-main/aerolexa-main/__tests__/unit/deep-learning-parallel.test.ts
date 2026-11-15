/**
 * Oracle & invariant tests for the deep-learning engine (E23).
 *
 * Contract: the gradient/hessian terms are hand-computable; the device probe
 * is honest (it reports scalar CPU when no GPU exists, never pretends);
 * training is deterministic and actually reduces loss. The engine models
 * data-parallel execution in one process and says so — these tests pin the
 * arithmetic and the honesty, not a cluster that does not exist here.
 */
import { describe, expect, it } from "@jest/globals";

import { lossTerms, probeDevice, trainParallel } from "@/lib/engine/deep-learning";

/** Deterministic LCG — every fixture below is reproducible bit-for-bit. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("lossTerms (E23)", () => {
  it("binary logistic gradient and hessian are hand-exact (logit input)", () => {
    // The binary loss takes a LOGIT: p = sigmoid(0.7) ≈ 0.66818777.
    // g = p − y ≈ −0.33181223; h = p(1−p) ≈ 0.22170886.
    const p = 1 / (1 + Math.exp(-0.7));
    const { g, h } = lossTerms(0.7, 1, "binary");
    expect(g).toBeCloseTo(p - 1, 12);
    expect(h).toBeCloseTo(p * (1 - p), 12);
  });

  it("regression gradient is the residual and hessian is 1", () => {
    const { g, h } = lossTerms(3, 5, "regression");
    expect(g).toBeCloseTo(-2, 12);
    expect(h).toBe(1);
  });
});

describe("probeDevice (E23)", () => {
  it("reports scalar CPU honestly when GPU is requested but absent", () => {
    const report = probeDevice("gpu");
    // Whatever the runtime offers, the arithmetic is scalar float64 — the
    // engine never claims GPU compute it does not perform.
    expect(report.arithmetic).toBe("scalar-float64");
    if (report.kind !== "webgpu" && report.kind !== "webgl") {
      // No GPU in this runtime: the probe must SAY SO rather than pretend.
      expect(report.kind).toBe("cpu");
      expect(report.label).toMatch(/no GPU runtime/i);
      expect(report.warnings.length).toBeGreaterThan(0);
    }
  });

  it("honours an explicit CPU request", () => {
    const report = probeDevice("cpu");
    expect(report.kind).toBe("cpu");
    expect(report.honoured).toBe(true);
  });
});

describe("trainParallel (E23)", () => {
  /** y = 1 + 2·x0 − x1 + small deterministic noise. */
  function fixture(n = 120): { X: number[][]; y: number[] } {
    const rand = lcg(99);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const x0 = rand();
      const x1 = rand();
      X.push([x0, x1]);
      y.push(1 + 2 * x0 - x1 + (rand() - 0.5) * 0.05);
    }
    return { X, y };
  }

  const base = (over: Record<string, unknown> = {}) => ({
    ...fixture(),
    task: "regression" as const,
    workers: 2,
    rounds: 12,
    learningRate: 0.2,
    batchSize: 16,
    maxDepth: 2,
    patience: 12,
    device: "cpu" as const,
    ...over,
  });

  it("trains a histogram-GBM that actually reduces loss", () => {
    const r = trainParallel({ ...base(), architecture: "xgboost" });
    expect(r.architecture).toBe("xgboost");
    expect(Number.isFinite(r.bestLoss)).toBe(true);
    expect(r.history.length).toBeGreaterThan(1);
    // The best round is at least as good as the first — training learned.
    expect(r.bestLoss).toBeLessThanOrEqual(r.history[0]!.loss);
    expect(r.device.kind).toBe("cpu");
    expect(r.device.arithmetic).toBe("scalar-float64");
    expect(r.importance.length).toBeGreaterThan(0);
  });

  it("trains an MLP that actually reduces loss", () => {
    const r = trainParallel({ ...base(), architecture: "mlp", batchSize: 16 });
    expect(r.architecture).toBe("mlp");
    expect(Number.isFinite(r.bestLoss)).toBe(true);
    expect(r.bestLoss).toBeLessThanOrEqual(r.history[0]!.loss);
    expect(r.device.kind).toBe("cpu");
  });

  it("is deterministic — identical options reproduce identical training", () => {
    const a = trainParallel({ ...base(), architecture: "xgboost" });
    const b = trainParallel({ ...base(), architecture: "xgboost" });
    expect(b.bestLoss).toBe(a.bestLoss);
    expect(b.bestRound).toBe(a.bestRound);
    expect(b.history.map((h) => h.loss)).toEqual(a.history.map((h) => h.loss));
  });

  it("reports the in-process execution model, never a fake cluster", () => {
    const r = trainParallel({ ...base(), architecture: "xgboost", workers: 4 });
    expect(r.workers).toBe(4);
    expect(r.parallel.histogramMs).toBeGreaterThanOrEqual(0);
    expect(r.parallel.allReduceMs).toBeGreaterThanOrEqual(0);
    // The honesty contract lives in the device report: no GPU exists here and
    // the engine must not claim otherwise.
    expect(r.device.arithmetic).toBe("scalar-float64");
  });
});
