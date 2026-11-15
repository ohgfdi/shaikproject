/**
 * Oracle & invariant tests for five Analysis-Lab-wired elite engines that
 * shipped with no test file (E3 IV/do-calculus, E4 survival, E5 Bayesian,
 * E6 HTE, E12 SARIMA). Every fixture is deterministic (seeded LCG) and every
 * assertion is either hand-computable or a statistical invariant the engine
 * must satisfy — nothing is asserted against the engine's own output alone.
 */
import { describe, expect, it } from "@jest/globals";

import { bayesianLinearRegression } from "@/lib/engine/bayes";
import { fitSarima } from "@/lib/engine/forecast-seasonal";
import { fitHte, type HteRow } from "@/lib/engine/hte";
import { estimateIv, fTestPValue } from "@/lib/engine/iv-calculus";
import { coxProportionalHazards } from "@/lib/engine/survival";

/** Deterministic LCG — every fixture below is reproducible bit-for-bit. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ---------------------------------------------------------------------------
// E3 — Instrumental variables / do-calculus
// ---------------------------------------------------------------------------

describe("iv-calculus (E3)", () => {
  it("F-distribution upper tail is exact (df1=2 closed form)", () => {
    // For df1 = 2: P(F > f) = (1 + 2f/df2)^(-df2/2). At f=4, df2=20:
    // (1.4)^-10 = 0.0345679… (the engine uses the regularised incomplete
    // beta, so agree to ~5 digits)
    expect(fTestPValue(4, 2, 20)).toBeCloseTo(0.0345679, 4);
    expect(fTestPValue(0.001, 2, 20)).toBeGreaterThan(0.99);
  });

  it("2SLS recovers the structural coefficient through a strong instrument", () => {
    const rand = lcg(42);
    const n = 400;
    const z: number[] = [];
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const zi = rand();
      const ui = rand() - 0.5;
      z.push(zi);
      x.push(1 + 2 * zi + 0.8 * ui); // first stage: strong (coef 2, real noise)
      y.push(0.5 + 1.5 * x[i]! + ui); // structural: beta = 1.5
    }
    const r = estimateIv({ y, x, z: [z], estimator: "2sls" });
    expect(r.beta).toBeCloseTo(1.5, 1); // OLS would be attenuated; IV is not
    expect(r.firstStageF).toBeGreaterThan(10);
    expect(r.strength.verdict).toBe("strong");
    expect(r.ci[0]).toBeLessThan(r.beta);
    expect(r.ci[1]).toBeGreaterThan(r.beta);
    expect(r.pValue).toBeLessThan(0.01);
    expect(Number.isFinite(r.olsBeta)).toBe(true);
  });

  it("flags a noise-only instrument as weak, never as strong", () => {
    const rand = lcg(7);
    const n = 200;
    const z: number[] = [];
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const ui = rand() - 0.5;
      const zi = rand(); // independent of x by construction
      z.push(zi);
      x.push(1 + 2 * (rand() - 0.5));
      y.push(0.5 + 1.5 * x[i]! + ui);
    }
    const r = estimateIv({ y, x, z: [z], estimator: "2sls" });
    expect(r.strength.verdict).not.toBe("strong");
    expect(r.firstStageF).toBeLessThan(10);
    expect(r.warnings.length + (r.andersonRubin.note ? 1 : 0)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// E4 — Survival analysis (Cox PH)
// ---------------------------------------------------------------------------

describe("survival (E4)", () => {
  it("Cox assigns a positive coefficient and HR>1 to a risk-increasing covariate", () => {
    // 120 subjects, half high-risk (x=1): their failure times centre ~4 units
    // earlier, with overlap so the partial likelihood is not separated.
    const time: number[] = [];
    const event: (0 | 1)[] = [];
    const X: number[][] = [];
    for (let i = 0; i < 120; i++) {
      const high = i % 2;
      X.push([high]);
      time.push((high ? 8 : 12) + (i % 20));
      event.push(1);
    }
    const r = coxProportionalHazards({ time, event, X, names: ["high_risk"] });
    const term = r.coefficients[0]!;
    expect(term.coefficient).toBeGreaterThan(0.3);
    expect(term.hazardRatio / Math.exp(term.coefficient)).toBeCloseTo(1, 6);
    expect(term.hazardRatio).toBeGreaterThan(1.3);
    expect(r.converged).toBe(true);
    expect(r.concordance).toBeGreaterThan(0.55);
    expect(term.pValue).toBeLessThan(0.001);
    expect(r.events).toBe(120);
  });

  it("is deterministic — identical input reproduces identical coefficients", () => {
    const time = [10, 12, 14, 20, 22, 25];
    const event: (0 | 1)[] = [1, 1, 0, 1, 1, 1]; // ≥5 events (the engine's floor)
    const X = [[0], [0], [1], [1], [0], [1]];
    const a = coxProportionalHazards({ time, event, X });
    const b = coxProportionalHazards({ time, event, X });
    expect(a.coefficients).toEqual(b.coefficients);
  });
});

// ---------------------------------------------------------------------------
// E5 — Bayesian linear regression
// ---------------------------------------------------------------------------

describe("bayes (E5)", () => {
  it("posterior concentrates on the true slope of noiseless data", () => {
    // y = 3 + 2x exactly; the model carries its own intercept, so the design
    // holds only the slope column. With a weak prior the posterior mean ≈ OLS.
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 1; i <= 12; i++) {
      X.push([i]);
      y.push(3 + 2 * i);
    }
    const r = bayesianLinearRegression({ X, y, names: ["slope"], seed: 11 });
    const slope = r.terms[0]!;
    expect(slope.posteriorMean).toBeCloseTo(2, 1);
    expect(slope.posteriorSD).toBeGreaterThan(0);
    expect(slope.ciLow).toBeLessThan(slope.posteriorMean);
    expect(slope.ciHigh).toBeGreaterThan(slope.posteriorMean);
    expect(slope.probPositive).toBeGreaterThan(0.99);
    expect(r.sigma2PosteriorMean).toBeGreaterThanOrEqual(0);
    expect(r.n).toBe(12);
  });

  it("is seed-deterministic — same seed, same posterior", () => {
    const X = [[1], [2], [3], [4], [5]];
    const y = [2.1, 3.9, 6.2, 7.8, 10.1];
    const a = bayesianLinearRegression({ X, y, seed: 3 });
    const b = bayesianLinearRegression({ X, y, seed: 3 });
    expect(a.terms.map((t) => t.posteriorMean)).toEqual(b.terms.map((t) => t.posteriorMean));
  });
});

// ---------------------------------------------------------------------------
// E6 — Heterogeneous treatment effects
// ---------------------------------------------------------------------------

describe("hte (E6)", () => {
  /** Effect is heterogeneous by construction: treated gain 1 + 2·x1. */
  function fixture(n = 240): HteRow[] {
    const rand = lcg(2024);
    const rows: HteRow[] = [];
    for (let i = 0; i < n; i++) {
      const x1 = rand(); // effect modifier, uniform [0,1)
      const w: 0 | 1 = (i % 2) as 0 | 1;
      const noise = (rand() - 0.5) * 0.2;
      const y = 1 + x1 + w * (1 + 2 * x1) + noise;
      rows.push({ x: [x1], w, y });
    }
    return rows;
  }

  it("recovers an ATE near the constructed average (1 + 2·E[x1] = 2)", () => {
    const fit = fitHte(fixture(), { learner: "dr-learner" }, ["x1"]);
    expect(fit.cate.ate).toBeGreaterThan(1.4);
    expect(fit.cate.ate).toBeLessThan(2.6);
    expect(Number.isFinite(fit.cate.se)).toBe(true);
    expect(fit.cate.ci[0]).toBeLessThan(fit.cate.ate);
    expect(fit.cate.ci[1]).toBeGreaterThan(fit.cate.ate);
    expect(fit.individual).toHaveLength(240);
    expect(fit.propensity.min).toBeGreaterThan(0);
    expect(fit.propensity.max).toBeLessThan(1);
    expect(fit.interpretation.length).toBeGreaterThan(0);
  });

  it("is deterministic — no RNG anywhere in the fit", () => {
    const rows = fixture();
    const a = fitHte(rows, { learner: "dr-learner" });
    const b = fitHte(rows, { learner: "dr-learner" });
    expect(a.cate.ate).toBe(b.cate.ate);
    expect(a.individual.map((i) => i.effect)).toEqual(b.individual.map((i) => i.effect));
  });

  it("refuses tiny samples with an honest error instead of guessing", () => {
    expect(() => fitHte(fixture(10), { learner: "dr-learner" })).toThrow(/at least 30/);
  });
});

// ---------------------------------------------------------------------------
// E12 — SARIMA (seasonal time series)
// ---------------------------------------------------------------------------

describe("forecast-seasonal (E12)", () => {
  /** 48 points of a deterministic monthly-seasonal trend: 10 + 0.5t + 3·sin(2πt/12). */
  function seasonal(): number[] {
    const out: number[] = [];
    for (let t = 0; t < 48; t++) out.push(10 + 0.5 * t + 3 * Math.sin((2 * Math.PI * t) / 12));
    return out;
  }

  it("fits a seasonal model and forecasts a finite horizon", () => {
    const values = seasonal();
    const fit = fitSarima(values, { horizon: 6, seasonalPeriods: 12, maxOrder: 2, maxSeasonalOrder: 1 });
    expect(fit.candidates.length).toBeGreaterThan(0);
    expect(fit.fitted).toHaveLength(values.length);
    // One residual is lost to the first difference the winner applied.
    expect(fit.residuals).toHaveLength(values.length - 1);
    const fc = fit.points.map((p) => p.point);
    expect(fc).toHaveLength(6);
    for (const v of fc) expect(Number.isFinite(v)).toBe(true);
    // The trend is +0.5/period: the last forecast must sit near the end of the
    // series' level, not collapse to the mean or explode.
    const last = values.at(-1)!;
    expect(Math.abs(fc.at(-1)! - last)).toBeLessThan(8);
  });

  it("is deterministic — same series, same selected model", () => {
    const values = seasonal();
    const opts = { horizon: 4, seasonalPeriods: 12, maxOrder: 2, maxSeasonalOrder: 1 };
    const a = fitSarima(values, opts);
    const b = fitSarima(values, opts);
    expect(a.best.name).toBe(b.best.name);
    expect(a.points.map((p) => p.point)).toEqual(b.points.map((p) => p.point));
  });
});
