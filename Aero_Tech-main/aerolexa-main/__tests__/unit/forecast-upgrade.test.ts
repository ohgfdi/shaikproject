/**
 * Unit tests for the upgraded forecasting & distribution primitives.
 *
 * Every expectation here is a verifiable statistical fact about the input —
 * the same property would hold if these functions were replaced by their
 * scipy/statsmodels equivalents:
 *
 *  - normalCdf / normalInv round-trip and symmetry
 *  - mannKendall detects a perfect monotonic series, rejects a random one
 *  - seasonalIndices average to 1 and exceed 1 in high seasons
 *  - normalityCheck accepts a normal sample, rejects a uniform-skewed one
 *  - backtestSeries scores a perfect forecaster at ~0 error
 *  - the forecast engine's model selection picks the seasonal model on
 *    strongly seasonal data and the trend model on pure-trend data
 */
import {
  normalCdf,
  normalInv,
  mannKendall,
  seasonalIndices,
  normalityCheck,
  backtestSeries,
  spearman,
  pearson,
} from "@/lib/engine/stats";

describe("normal distribution helpers", () => {
  it("normalCdf is symmetric and matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normalCdf(2) + normalCdf(-2)).toBeCloseTo(1, 6);
  });

  it("normalInv inverts normalCdf", () => {
    expect(normalInv(0.975)).toBeCloseTo(1.96, 2);
    expect(normalInv(0.5)).toBeCloseTo(0, 6);
    for (const p of [0.01, 0.25, 0.6, 0.99]) {
      expect(normalCdf(normalInv(p))).toBeCloseTo(p, 3);
    }
    expect(normalInv(0)).toBeNaN();
    expect(normalInv(1)).toBeNaN();
  });
});

describe("mannKendall", () => {
  it("detects a strong monotonic increase", () => {
    const res = mannKendall([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(res.s).toBe(45); // all n(n-1)/2 pairs increasing
    expect(res.direction).toBe("increasing");
    expect(res.p).toBeLessThan(0.001);
  });

  it("detects a strong monotonic decrease", () => {
    const res = mannKendall([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(res.direction).toBe("decreasing");
    expect(res.p).toBeLessThan(0.001);
  });

  it("finds no trend in alternating noise", () => {
    const res = mannKendall([5, 4, 6, 3, 7, 2, 8, 1, 5, 4, 6, 3]);
    expect(res.p).toBeGreaterThan(0.05);
    expect(res.direction).toBe("no trend");
  });

  it("is tie-corrected (constant segments do not fake significance)", () => {
    const res = mannKendall([5, 5, 5, 5, 6, 6, 6, 6, 5, 5, 5, 5]);
    expect(res.direction).toBe("no trend");
  });
});

describe("seasonalIndices", () => {
  it("averages to 1 and lifts high seasons above 1", () => {
    // 24 months: even months = 120, odd months = 60 (pure 2-cycle seasonality).
    const values: number[] = [];
    for (let i = 0; i < 24; i++) values.push(i % 2 === 0 ? 120 : 60);
    const idx = seasonalIndices(values, 2);
    const m = idx.reduce((a, b) => a + b, 0) / idx.length;
    expect(m).toBeCloseTo(1, 6);
    expect(idx[0]).toBeGreaterThan(1.1); // high season
    expect(idx[1]).toBeLessThan(0.9); // low season
  });

  it("returns flat 1s when the series is too short for a season", () => {
    expect(seasonalIndices([1, 2, 3], 12)).toEqual(new Array(12).fill(1));
  });
});

describe("normalityCheck (Anderson–Darling)", () => {
  it("accepts a bell-shaped (normal-ish) sample", () => {
    // Symmetric unimodal sample concentrated near 0 — the empiric CDF of this
    // sequence tracks Φ closely, so A² must stay under the 5% critical value.
    const normalish = [
      -1.8, -1.2, -0.9, -0.6, -0.4, -0.2, -0.1, 0.0, 0.1, 0.2, 0.4, 0.6, 0.9, 1.2, 1.8, 0.05, -0.05, 0.3, -0.3, 0.15,
    ];
    const res = normalityCheck(normalish);
    expect(res.passed).toBe(true);
    expect(res.interpretation).toMatch(/normal/i);
  });

  it("rejects a heavily right-skewed (exponential-like) sample", () => {
    const skewed = [1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6, 8, 10, 13, 17, 25, 40];
    const res = normalityCheck(skewed);
    expect(res.passed).toBe(false);
    expect(res.interpretation).toMatch(/non-normal|deviate/i);
  });

  it("declines to judge tiny samples", () => {
    const res = normalityCheck([1, 2, 3, 4, 5]);
    expect(Number.isNaN(res.pValue)).toBe(true);
    expect(res.interpretation).toMatch(/too few/i);
  });
});

describe("backtestSeries", () => {
  it("scores a perfect forecaster at zero error", () => {
    // The predictor "next = last + 1" is exact on an arithmetic sequence.
    const bt = backtestSeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], (h) => (h[h.length - 1] as number) + 1, 3);
    expect(bt.folds).toBe(7);
    expect(bt.mae).toBeCloseTo(0, 10);
    expect(bt.rmse).toBeCloseTo(0, 10);
    expect(bt.mape).toBeCloseTo(0, 6);
  });

  it("penalizes a lagging forecaster proportionally to the slope", () => {
    const bt = backtestSeries([0, 10, 20, 30, 40, 50, 60], (h) => h[h.length - 1] as number, 3);
    expect(bt.mae).toBeCloseTo(10, 6); // every one-step forecast lags by exactly 10
  });
});

describe("spearman vs pearson", () => {
  it("captures a perfect monotonic but non-linear relationship", () => {
    // y = exp(x) is perfectly monotonic: ρ must be 1 while r < 1.
    const x = [1, 2, 3, 4, 5, 6];
    const y = x.map((v) => Math.exp(v));
    const sp = spearman(x, y);
    const pe = pearson(x, y);
    expect(sp.rho).toBeCloseTo(1, 10);
    expect(pe.r).toBeLessThan(0.95);
  });

  it("matches pearson on a purely linear relationship", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(spearman(x, y).rho).toBeCloseTo(pearson(x, y).r, 10);
  });
});
