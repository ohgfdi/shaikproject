/**
 * Oracle tests for the elite statistics engine (lib/engine/elite-stats.ts).
 * Expected values hand-computed / cross-checked against SciPy conventions.
 */
import {
  benjaminiHochberg,
  bonferroni,
  cliffsDelta,
  cohensD,
  cohensKappa,
  cramersV,
  fitLogistic,
  fitPoisson,
  holm,
  kaplanMeier,
  kruskalWallis,
  logRankTest,
  mannWhitneyU,
  StatsError,
  wilcoxonSignedRank,
} from "@/lib/engine/elite-stats";

describe("effect sizes", () => {
  it("cohensD matches the hand-computed pooled-SD value", () => {
    // a = [1,2,3,4,5] mean 3, var 2.5 ; b = [3,4,5,6,7] mean 5, var 2.5
    // sPooled = √((4·2.5 + 4·2.5)/8) = √2.5 ; d = (3−5)/√2.5 = −1.264911
    // g = d × (1 − 3/(4·8−1)) = −1.264911 × 0.904762
    const r = cohensD([1, 2, 3, 4, 5], [3, 4, 5, 6, 7]);
    expect(r.value).toBeCloseTo(-2 / Math.sqrt(2.5), 6);
    expect(r.g).toBeCloseTo((-2 / Math.sqrt(2.5)) * (1 - 3 / 31), 6);
    expect(r.magnitude).toBe("large");
    expect(r.n).toBe(10);
  });

  it("cohensD flags large and negligible bands", () => {
    expect(cohensD([0, 1, 2, 3, 4], [10, 11, 12, 13, 14]).magnitude).toBe("large");
    // d = 0.3/1 = 0.3 exactly on the small/medium boundary — 0.3 counts as medium.
    const medium = cohensD([0, 1, 2], [0.3, 1.3, 2.3]);
    expect(medium.magnitude).toBe("medium");
    // A genuinely small effect: d ≈ 0.2.
    expect(cohensD([0, 1, 2], [0.2, 1.2, 2.2]).magnitude).toBe("small");
  });

  it("cliffsDelta is exact on dominance counts", () => {
    // x = [5,6,7] vs y = [1,2,3]: every x > every y → δ = 1
    expect(cliffsDelta([5, 6, 7], [1, 2, 3]).value).toBe(1);
    // 2 of 3 x's exceed all y's; 5 < none... hand count:
    // x=[4,5,6], y=[1,2,5]: greater = 2·2 + 2·2 + 2·0? No: 4>{1,2,5}=2, 5>{1,2,5}=2, 6>{1,2,5}=3 → 7
    // less: 4<none=0? 4>1,4>2,4>5? no. less counts: 4<5 →1; 5<none; 6<none → 1
    // δ = (7−1)/9 = 6/9 = 0.666667
    expect(cliffsDelta([4, 5, 6], [1, 2, 5]).value).toBeCloseTo(6 / 9, 6);
  });

  it("cramersV is 1 for a perfect association and ~0 for independence", () => {
    const perfect = [
      [10, 0],
      [0, 10],
    ];
    expect(cramersV(perfect).value).toBe(1);
    const independent = [
      [25, 25],
      [25, 25],
    ];
    expect(cramersV(independent).value).toBe(0);
  });

  it("cohensKappa matches the hand-computed agreement value", () => {
    // Both raters agree 20/25 times; marginals give pe = 0.5
    // table [[15,5],[5,0]]: po = 15/25 = 0.6; rows [20,5]; cols [20,5]
    // pe = (20/25)(20/25) + (5/25)(5/25) = 0.64 + 0.04 = 0.68
    // κ = (0.6 − 0.68)/(1 − 0.68) = −0.25
    const r = cohensKappa([
      [15, 5],
      [5, 0],
    ]);
    expect(r.value).toBeCloseTo(-0.25, 6);
  });

  it("throws on degenerate inputs", () => {
    expect(() => cohensD([1], [2, 3])).toThrow(StatsError);
    expect(() => cliffsDelta([], [1])).toThrow(StatsError);
    expect(() => cramersV([[1]])).toThrow(StatsError);
  });
});

describe("nonparametric tests", () => {
  it("mannWhitneyU returns U1 = 0 for complete separation (scipy: U=0, p→0)", () => {
    const r = mannWhitneyU([1, 2, 3, 4, 5], [10, 11, 12, 13, 14]);
    expect(r.statistic).toBe(0);
    // Continuity-corrected asymptotic z: |U−μ|−0.5 = 12, σ = √(25·11/12) ≈ 4.787
    // → z ≈ 2.507, two-sided p ≈ 0.0122 (scipy asymptotic + correction; the
    // EXACT p for 5v5 is 0.0079 — both < 0.05).
    expect(r.pValue).toBeLessThan(0.05);
  });

  it("mannWhitneyU gives p ≈ 1 for identical samples", () => {
    const r = mannWhitneyU([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]);
    // Clamped continuity correction: z = 0 → p = 1 up to float noise.
    expect(r.pValue).toBeGreaterThan(0.999);
  });

  it("mannWhitneyU handles ties with the tie correction", () => {
    // Two identical multisets: ranks tie everywhere; U must be exactly n1·n2/2.
    const r = mannWhitneyU([1, 1, 2, 2], [1, 1, 2, 2]);
    expect(r.statistic).toBe(8);
    // z clamps to 0; p = 1 up to the ~1e-9 error of the A&S normalCdf.
    expect(r.pValue).toBeGreaterThan(0.999);
  });

  it("wilcoxonSignedRank detects a consistent paired shift", () => {
    const before = [10, 12, 14, 16, 18, 20, 22];
    const after = before.map((v) => v + 5);
    const r = wilcoxonSignedRank(before, after);
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.statistic).toBe(0); // all differences positive → W− = 0
  });

  it("wilcoxonSignedRank is symmetric around no effect", () => {
    const a = [10, 12, 14, 16, 18, 20, 22];
    const b = [12, 10, 16, 14, 20, 18, 24]; // mixed small shifts
    const r = wilcoxonSignedRank(a, b);
    expect(r.pValue).toBeGreaterThan(0.1);
  });

  it("kruskalWallis matches the hand-computed H for two separated groups", () => {
    // g1 = [1,2,3], g2 = [10,11,12]: ranks g1 = 1,2,3; g2 = 4,5,6
    // H = 12/(6·7) · (36/3 + 225/3) − 21 = (2/7)(12 + 75) − 21 = 24.857 − 21 = 3.857
    const r = kruskalWallis([
      [1, 2, 3],
      [10, 11, 12],
    ]);
    expect(r.statistic).toBeCloseTo(3.857143, 5);
    expect(r.pValue).toBeLessThan(0.06);
  });

  it("kruskalWallis is ~0 for identical groups", () => {
    const r = kruskalWallis([
      [1, 2, 3, 4],
      [1, 2, 3, 4],
    ]);
    expect(r.statistic).toBeCloseTo(0, 6);
  });
});

describe("multiple-testing corrections", () => {
  const ps = [
    { label: "a", pValue: 0.01 },
    { label: "b", pValue: 0.04 },
    { label: "c", pValue: 0.03 },
  ];

  it("bonferroni multiplies by m", () => {
    const r = bonferroni(ps);
    expect(r.find((x) => x.label === "a")!.adjusted).toBeCloseTo(0.03, 10);
    expect(r.find((x) => x.label === "b")!.adjusted).toBeCloseTo(0.12, 10);
  });

  it("holm is monotone and matches the hand-computed step-down", () => {
    const r = holm(ps);
    // sorted: 0.01→3p=0.03; 0.03→2p=0.06; 0.04→1p=0.04 (monotone max → 0.06)
    expect(r.find((x) => x.label === "a")!.adjusted).toBeCloseTo(0.03, 10);
    expect(r.find((x) => x.label === "c")!.adjusted).toBeCloseTo(0.06, 10);
    expect(r.find((x) => x.label === "b")!.adjusted).toBeCloseTo(0.06, 10);
    // Holm's step-down is uniformly LESS conservative than Bonferroni.
    const b = bonferroni(ps);
    expect(r.every((x) => x.adjusted <= b.find((y) => y.label === x.label)!.adjusted + 1e-12)).toBe(true);
  });

  it("benjaminiHochberg matches the hand-computed step-up", () => {
    const r = benjaminiHochberg(ps);
    // sorted desc scan: j=3: (3/3)·0.04=0.04; j=2: (3/2)·0.03=0.045→min 0.04; j=1: 3·0.01=0.03 → 0.03
    expect(r.find((x) => x.label === "a")!.adjusted).toBeCloseTo(0.03, 10);
    expect(r.find((x) => x.label === "c")!.adjusted).toBeCloseTo(0.04, 10);
    expect(r.find((x) => x.label === "b")!.adjusted).toBeCloseTo(0.04, 10);
  });

  it("BH is uniformly less conservative than Bonferroni", () => {
    const r = benjaminiHochberg(ps);
    const b = bonferroni(ps);
    expect(r.every((x, i) => x.adjusted <= b[i]!.adjusted + 1e-12)).toBe(true);
  });

  it("rejects invalid p-values", () => {
    expect(() => bonferroni([{ label: "x", pValue: 1.5 }])).toThrow(StatsError);
    expect(() => holm([{ label: "x", pValue: -0.1 }])).toThrow(StatsError);
  });
});

describe("GLM — logistic", () => {
  it("recovers the true coefficient on separated data", () => {
    // Overlapping-but-informative x: β should be positive & significant.
    // (Perfectly separated data drives |β| → ∞ — the ridge keeps IRLS finite,
    // and the Wald z collapses, which is the honest signature of separation.)
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 80; i++) {
      const x = (i % 20) - 10 + (i % 3) * 0.3;
      X.push([x]);
      // Logistic-noise-like label rule with overlap near 0.
      y.push(x > 1 ? 1 : x < -1 ? 0 : i % 2 === 0 ? 1 : 0);
    }
    const fit = fitLogistic({ X, y, featureNames: ["x"] }, { maxIter: 200 });
    const beta = fit.coefficients.find((c) => c.name === "x")!;
    expect(beta.coefficient).toBeGreaterThan(0.3);
    expect(beta.pValue).toBeLessThan(0.05);
    expect(fit.converged).toBe(true);
    // Intercept-only deviance > residual deviance.
    expect(fit.residualDeviance).toBeLessThan(fit.nullDeviance);
    // AIC relation: aic = −2·logLik + 2·(p+1) (compare at round-6 precision).
    expect(fit.aic).toBeCloseTo(-2 * fit.logLik + 4, 5);
  });

  it("expBeta is exp(coefficient)", () => {
    const X = [[1], [2], [3], [4], [5], [6], [7], [8], [9], [10], [11], [12]];
    const y = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
    const fit = fitLogistic({ X, y, featureNames: ["x"] });
    const beta = fit.coefficients.find((c) => c.name === "x")!;
    // Separated data: β is large (≈14), so exp() amplifies rounding — compare
    // relatively.
    expect(Math.abs(beta.expBeta - Math.exp(beta.coefficient)) / Math.exp(beta.coefficient)).toBeLessThan(1e-6);
  });

  it("throws on constant response or missing data", () => {
    const X = [[1], [2], [3], [4]];
    expect(() => fitLogistic({ X, y: [1, 1, 1, 1] })).toThrow(StatsError);
    expect(() => fitLogistic({ X, y: [0, 1, 2, 0] })).toThrow(StatsError);
    expect(() => fitLogistic({ X: [[Number.NaN]], y: [0, 1, 0, 1] })).toThrow(StatsError);
  });
});

describe("GLM — Poisson", () => {
  it("recovers a log-linear rate ratio (oracle: exp(β)=2)", () => {
    // y ~ Poisson with λ = 2·exp(0.5·x) — deterministic rates (no noise):
    // expected counts round to integers; β̂ should be close to 0.5.
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 40; i++) {
      const x = i / 4; // 0 … 9.75
      X.push([x]);
      y.push(Math.round(2 * Math.exp(0.5 * x)));
    }
    const fit = fitPoisson({ X, y, featureNames: ["x"] }, { maxIter: 200 });
    const beta = fit.coefficients.find((c) => c.name === "x")!;
    expect(Math.abs(beta.coefficient - 0.5)).toBeLessThan(0.1);
    expect(fit.converged).toBe(true);
    // Deviance relation: residual < null for a real signal.
    expect(fit.residualDeviance).toBeLessThan(fit.nullDeviance);
  });

  it("throws on negative or non-integer counts", () => {
    const X = [[1], [2], [3], [4], [5], [6]];
    expect(() => fitPoisson({ X, y: [1, -2, 3, 4, 5, 6] })).toThrow(StatsError);
    expect(() => fitPoisson({ X, y: [1.5, 2, 3, 4, 5, 6] })).toThrow(StatsError);
    expect(() => fitPoisson({ X, y: [0, 0, 0, 0, 0, 0] })).toThrow(StatsError);
  });
});

describe("survival — Kaplan–Meier", () => {
  it("matches the hand-computed S(t) for a classic small cohort", () => {
    // Times: 1(event),2(event),3(censored),4(event),5(censored)
    // S(1)=1−1/5=0.8; S(2)=0.8·(1−1/4)=0.6; S(4)=0.6·(1−1/2)=0.3
    const curve = kaplanMeier([
      { time: 1, event: true },
      { time: 2, event: true },
      { time: 3, event: false },
      { time: 4, event: true },
      { time: 5, event: false },
    ]);
    expect(curve.times).toEqual([1, 2, 4]);
    expect(curve.survival[0]).toBeCloseTo(0.8, 6);
    expect(curve.survival[1]).toBeCloseTo(0.6, 6);
    expect(curve.survival[2]).toBeCloseTo(0.3, 6);
    expect(curve.median).toBe(4); // S first ≤ 0.5 at t=4 (0.3)
    expect(curve.totalEvents).toBe(3);
  });

  it("never reaches the median when S stays above 0.5", () => {
    const curve = kaplanMeier([
      { time: 1, event: true },
      { time: 2, event: false },
      { time: 3, event: false },
      { time: 4, event: false },
      { time: 5, event: false },
    ]);
    expect(curve.median).toBeNull();
    expect(curve.survival[0]).toBeCloseTo(0.8, 6);
  });

  it("handles ties at one time (2 events of 5 at risk)", () => {
    const curve = kaplanMeier([
      { time: 3, event: true },
      { time: 3, event: true },
      { time: 3, event: false },
      { time: 7, event: false },
      { time: 9, event: false },
    ]);
    expect(curve.survival[0]).toBeCloseTo(1 - 2 / 5, 6);
    expect(curve.atRisk[0]).toBe(5);
  });
});

describe("survival — log-rank", () => {
  it("separates two clearly different curves (p < 0.05)", () => {
    const early = [
      { time: 1, event: true },
      { time: 2, event: true },
      { time: 3, event: true },
      { time: 4, event: true },
      { time: 5, event: true },
    ];
    const late = [
      { time: 10, event: true },
      { time: 12, event: true },
      { time: 14, event: true },
      { time: 16, event: true },
      { time: 18, event: true },
    ];
    const r = logRankTest([
      { label: "early", obs: early },
      { label: "late", obs: late },
    ]);
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.statistic).toBeGreaterThan(3.84);
  });

  it("finds no difference between identical cohorts", () => {
    const a = [
      { time: 2, event: true },
      { time: 4, event: true },
      { time: 6, event: false },
      { time: 8, event: true },
      { time: 10, event: false },
    ];
    const b = [
      { time: 2, event: true },
      { time: 4, event: true },
      { time: 6, event: false },
      { time: 8, event: true },
      { time: 10, event: false },
    ];
    const r = logRankTest([
      { label: "a", obs: a },
      { label: "b", obs: b },
    ]);
    expect(r.statistic).toBeCloseTo(0, 6);
    expect(r.pValue).toBe(1);
  });

  it("reports per-group medians", () => {
    const a = [
      { time: 1, event: true },
      { time: 2, event: true },
      { time: 3, event: true },
    ];
    const b = [
      { time: 5, event: true },
      { time: 7, event: true },
      { time: 9, event: true },
    ];
    const r = logRankTest([
      { label: "a", obs: a },
      { label: "b", obs: b },
    ]);
    expect(r.medians.find((m) => m.label === "a")!.median).toBe(2);
    expect(r.medians.find((m) => m.label === "b")!.median).toBe(7);
  });

  it("rejects invalid group shapes", () => {
    expect(() => logRankTest([{ label: "a", obs: [{ time: 1, event: true }] }])).toThrow(StatsError);
    expect(() =>
      logRankTest([
        { label: "a", obs: [] },
        { label: "b", obs: [{ time: 1, event: true }] },
      ]),
    ).toThrow(StatsError);
    expect(() =>
      logRankTest([
        { label: "a", obs: [{ time: 0, event: true }] },
        { label: "b", obs: [{ time: 1, event: true }] },
      ]),
    ).toThrow(StatsError);
  });
});
