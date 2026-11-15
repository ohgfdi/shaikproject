/**
 * Unit tests for the A/B serving engine (lib/engine/ab-serving.ts).
 *
 * Oracles: SHA-256 assignment is verified against node:crypto itself (the
 * reference implementation), SPRT boundaries are hand-computed Wald numbers,
 * the LLR for tiny arms is summed by hand, and guardrail z/p arithmetic is
 * checked against manual formulas plus the oracle-validated normalCdf.
 */
import { createHash } from "node:crypto";

import {
  assignVariant,
  sequentialProbabilityRatioTest,
  evaluateGuardrail,
  evaluateGuardrails,
  AbServingError,
} from "@/lib/engine/ab-serving";
import { normalCdf } from "@/lib/engine/stats";

// ---------------------------------------------------------------------------
// 1. Deterministic assignment
// ---------------------------------------------------------------------------

describe("assignVariant", () => {
  const fiftyFifty = [
    { name: "control", share: 0.5 },
    { name: "treatment", share: 0.5 },
  ];

  it("matches a hand-derived SHA-256 position exactly (auditable oracle)", () => {
    const experimentId = "exp-2024-11";
    const userId = "user-991";
    const r = assignVariant(experimentId, userId, fiftyFifty);

    // Re-derive the position from the digest the module reports AND from a
    // fresh node:crypto hash — they must agree bit-for-bit.
    const digest = createHash("sha256").update(`${experimentId}:${userId}`).digest();
    const hi = digest.readBigUInt64BE(0);
    const lo = digest.readBigUInt64BE(8);
    const position = Number((hi << 64n) + lo) / Number(1n << 128n);

    expect(r.assignmentHash).toBe(digest.toString("hex"));
    expect(r.position).toBe(position);
    // 50/50 split: control owns [0, 0.5).
    expect(r.variant).toBe(position < 0.5 ? "control" : "treatment");
    expect(r.bands).toEqual([
      { variant: "control", low: 0, high: 0.5 },
      { variant: "treatment", low: 0.5, high: 1 },
    ]);
  });

  it("is stable across calls and stateless (no peeking, no flip-flop)", () => {
    const a = assignVariant("exp", "user-1", fiftyFifty);
    const b = assignVariant("exp", "user-1", fiftyFifty);
    expect(a.variant).toBe(b.variant);
    expect(a.assignmentHash).toBe(b.assignmentHash);
  });

  it("salt = experiment id: two experiments randomize the same user independently", () => {
    const a = assignVariant("exp-a", "user-1", fiftyFifty);
    const b = assignVariant("exp-b", "user-1", fiftyFifty);
    expect(a.assignmentHash).not.toBe(b.assignmentHash);
  });

  it("honors a 90/10 split band layout", () => {
    const variants = [
      { name: "holdout", share: 0.1 },
      { name: "test", share: 0.9 },
    ];
    const r = assignVariant("exp-90", "u", variants);
    expect(r.bands).toEqual([
      { variant: "holdout", low: 0, high: 0.1 },
      { variant: "test", low: 0.1, high: 1 },
    ]);
    expect(r.variant).toBe(r.position < 0.1 ? "holdout" : "test");
  });

  it("splits uneven integer shares via normalization (2:1 → 2/3 : 1/3)", () => {
    const variants = [
      { name: "a", share: 2 },
      { name: "b", share: 1 },
    ];
    const r = assignVariant("exp-21", "u", variants);
    expect(r.bands.map((b) => b.high)).toEqual([2 / 3, 1]);
  });

  it("assigns roughly the requested split over a large deterministic cohort", () => {
    // Deterministic user ids → position is fixed; the empirical split must
    // land near 50% (hashing is uniform, and the audit trail proves why).
    let control = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const r = assignVariant("uniformity-exp", `user-${i}`, fiftyFifty);
      if (r.variant === "control") control++;
    }
    const share = control / N;
    expect(Math.abs(share - 0.5)).toBeLessThan(0.03);
  });

  it("rejects invalid configurations loudly", () => {
    expect(() => assignVariant("", "u", fiftyFifty)).toThrow(AbServingError);
    expect(() => assignVariant("exp", "  ", fiftyFifty)).toThrow(AbServingError);
    expect(() => assignVariant("exp", "u", [{ name: "only", share: 1 }])).toThrow(/At least 2 variants/);
    expect(() =>
      assignVariant("exp", "u", [
        { name: "a", share: -1 },
        { name: "b", share: 2 },
      ]),
    ).toThrow(/finite and non-negative/);
    expect(() =>
      assignVariant("exp", "u", [
        { name: "a", share: 0 },
        { name: "b", share: 0 },
      ]),
    ).toThrow(/positive/);
  });
});

// ---------------------------------------------------------------------------
// 2. Wald SPRT
// ---------------------------------------------------------------------------

describe("sequentialProbabilityRatioTest", () => {
  const boundaries = (alpha = 0.05, beta = 0.2) => ({
    upper: Math.log((1 - beta) / alpha),
    lower: Math.log(beta / (1 - alpha)),
  });

  it("uses the exact Wald boundaries log((1−β)/α) and log(β/(1−α))", () => {
    const r = sequentialProbabilityRatioTest({
      controlSuccesses: 50,
      controlTrials: 1000,
      treatmentSuccesses: 60,
      treatmentTrials: 1000,
      mdeRelative: 0.05,
    });
    const b = boundaries();
    expect(r.upperBoundary).toBeCloseTo(b.upper, 10);
    expect(r.lowerBoundary).toBeCloseTo(b.lower, 10);
    expect(r.verdict).toBe("continue"); // LLR between the boundaries
  });

  it("crosses the upper boundary for an overwhelming winner (reject-h0)", () => {
    // p_c = 0.10 vs p_t = 0.20 on very large arms — the LLR accumulates one
    // per-observation increment per row, so 10× the evidence guarantees the
    // upper boundary log((1−β)/α) ≈ 2.776 is crossed.
    const r = sequentialProbabilityRatioTest({
      controlSuccesses: 1000,
      controlTrials: 10000,
      treatmentSuccesses: 2000,
      treatmentTrials: 10000,
      mdeRelative: 0.05,
    });
    expect(r.verdict).toBe("reject-h0");
    expect(r.logLikelihoodRatio).toBeGreaterThanOrEqual(r.upperBoundary);
    expect(r.pControl).toBeCloseTo(0.1, 10);
    expect(r.pTreatment).toBeCloseTo(0.2, 10);
  });

  it("crosses the lower boundary when the lift is clearly below the MDE (accept-h0)", () => {
    // Identical arms → each observation contributes a negative increment (H1
    // posits a lift that isn't there); 10× the evidence pushes the LLR below
    // log(β/(1−α)) ≈ −1.386.
    const r = sequentialProbabilityRatioTest({
      controlSuccesses: 5000,
      controlTrials: 100000,
      treatmentSuccesses: 5010,
      treatmentTrials: 100000,
      mdeRelative: 0.05,
    });
    expect(r.verdict).toBe("accept-h0");
    expect(r.logLikelihoodRatio).toBeLessThanOrEqual(r.lowerBoundary);
  });

  it("matches a hand-summed LLR on tiny arms", () => {
    // n_c = n_t = 1, s_c = 0, s_t = 1 → p0 = 0.5, p1T = 0.5·1.5 = 0.75.
    // LLR = ln(0.75/0.5) [treated success under H1 vs H0]
    //     + ln(0.25/0.5) [treated failure term has 0 successes → 0]
    //     + 0 for control successes + ln((1−0.5)/(1−0.5)) = 0 for control failures.
    // Concretely: llH1 = ln(.5)·0 [control] ... full hand computation:
    const input = {
      controlSuccesses: 0,
      controlTrials: 1,
      treatmentSuccesses: 1,
      treatmentTrials: 1,
      mdeRelative: 0.5,
    };
    const r = sequentialProbabilityRatioTest(input);
    const p0 = 0.5;
    const p1T = 0.75;
    const clamp = (p: number) => Math.min(1 - 1e-12, Math.max(1e-12, p));
    const ll = (s: number, n: number, p: number) => s * Math.log(clamp(p)) + (n - s) * Math.log(1 - clamp(p));
    const expected = ll(0, 1, p0) + ll(1, 1, p1T) - (ll(0, 1, p0) + ll(1, 1, p0));
    expect(r.logLikelihoodRatio).toBeCloseTo(expected, 10);
    expect(r.logLikelihoodRatio).toBeCloseTo(Math.log(p1T / p0), 10);
    expect(r.h0).toContain("50.00%");
    expect(r.h1).toContain("50.0%");
  });

  it("monotone evidence: more extreme data moves the LLR further from 0", () => {
    const weak = sequentialProbabilityRatioTest({
      controlSuccesses: 55,
      controlTrials: 1000,
      treatmentSuccesses: 60,
      treatmentTrials: 1000,
      mdeRelative: 0.05,
    });
    const strong = sequentialProbabilityRatioTest({
      controlSuccesses: 50,
      controlTrials: 1000,
      treatmentSuccesses: 80,
      treatmentTrials: 1000,
      mdeRelative: 0.05,
    });
    expect(strong.logLikelihoodRatio).toBeGreaterThan(weak.logLikelihoodRatio);
  });

  it("progress stays in [0,1] and equals 0 at the lower boundary", () => {
    const losing = sequentialProbabilityRatioTest({
      controlSuccesses: 5000,
      controlTrials: 100000,
      treatmentSuccesses: 5010,
      treatmentTrials: 100000,
      mdeRelative: 0.05,
    });
    expect(losing.progress).toBe(0);
    const mid = sequentialProbabilityRatioTest({
      controlSuccesses: 50,
      controlTrials: 1000,
      treatmentSuccesses: 53,
      treatmentTrials: 1000,
      mdeRelative: 0.05,
    });
    expect(mid.progress).toBeGreaterThan(0);
    expect(mid.progress).toBeLessThan(1);
  });

  it("custom α/β shift the boundaries the right way (tighter α → higher upper)", () => {
    const base = boundaries();
    const tighter = boundaries(0.01, 0.1);
    expect(tighter.upper).toBeGreaterThan(base.upper);
    const input = {
      controlSuccesses: 100,
      controlTrials: 1000,
      treatmentSuccesses: 130,
      treatmentTrials: 1000,
      mdeRelative: 0.1,
      alpha: 0.01,
      beta: 0.1,
    };
    const r = sequentialProbabilityRatioTest(input);
    expect(r.upperBoundary).toBeCloseTo(tighter.upper, 10);
    expect(r.lowerBoundary).toBeCloseTo(tighter.lower, 10);
  });

  it("prints its assumptions and never claims causality by name-dropping the design", () => {
    const r = sequentialProbabilityRatioTest({
      controlSuccesses: 10,
      controlTrials: 100,
      treatmentSuccesses: 12,
      treatmentTrials: 100,
      mdeRelative: 0.1,
    });
    expect(r.methodology.join(" ")).toContain("SPRT");
    expect(r.methodology.join(" ")).toContain("no interference");
  });

  it("rejects invalid inputs loudly", () => {
    const good = {
      controlSuccesses: 5,
      controlTrials: 100,
      treatmentSuccesses: 5,
      treatmentTrials: 100,
      mdeRelative: 0.05,
    };
    expect(() => sequentialProbabilityRatioTest({ ...good, controlTrials: 0 })).toThrow(AbServingError);
    expect(() => sequentialProbabilityRatioTest({ ...good, treatmentTrials: 2.5 })).toThrow(AbServingError);
    expect(() => sequentialProbabilityRatioTest({ ...good, controlSuccesses: 101 })).toThrow(AbServingError);
    expect(() => sequentialProbabilityRatioTest({ ...good, mdeRelative: 0 })).toThrow(/mdeRelative/);
    expect(() => sequentialProbabilityRatioTest({ ...good, mdeRelative: Number.NaN })).toThrow(/mdeRelative/);
    expect(() => sequentialProbabilityRatioTest({ ...good, alpha: 0 })).toThrow(/alpha and beta/);
    expect(() => sequentialProbabilityRatioTest({ ...good, beta: 1 })).toThrow(/alpha and beta/);
  });
});

// ---------------------------------------------------------------------------
// 3. Guardrails
// ---------------------------------------------------------------------------

describe("evaluateGuardrail", () => {
  it("matches a hand-computed z and p on a symmetric case", () => {
    // control: mean 100, sd 10, n 100; variant: mean 110, sd 10, n 100.
    // se = sqrt(100/100 + 100/100) = sqrt(2); z = 10/sqrt(2) ≈ 7.0711.
    const r = evaluateGuardrail({
      name: "latency_ms",
      direction: "lower-is-better",
      controlMean: 100,
      variantMean: 110,
      controlSd: 10,
      variantSd: 10,
      controlN: 100,
      variantN: 100,
    });
    const se = Math.sqrt((10 * 10) / 100 + (10 * 10) / 100);
    const z = (110 - 100) / se;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    expect(r.zStatistic).toBeCloseTo(z, 8);
    expect(r.pValue).toBeCloseTo(p, 8);
    expect(r.zStatistic).toBeCloseTo(7.0710678, 4);
    // 10% worse on a lower-is-better metric > 5% breach threshold, significant.
    expect(r.severity).toBe("breach");
    expect(r.confirmed).toBe(true);
    expect(r.relativeChangeBad).toBeCloseTo(0.1, 10);
    expect(r.message).toContain("BREACH");
  });

  it("flips the bad direction for higher-is-better metrics", () => {
    const r = evaluateGuardrail({
      name: "revenue_per_user",
      direction: "higher-is-better",
      controlMean: 50,
      variantMean: 45,
      controlSd: 5,
      variantSd: 5,
      controlN: 200,
      variantN: 200,
    });
    // Variant LOST 10% — bad direction for a higher-is-better metric.
    expect(r.relativeChangeBad).toBeCloseTo(0.1, 10);
    expect(r.zStatistic).toBeLessThan(0);
    expect(r.severity).toBe("breach");
  });

  it("reports a material-but-not-significant move as warn, never breach (honesty on small n)", () => {
    // +10% latency but huge SDs on tiny arms → not significant.
    const r = evaluateGuardrail({
      name: "latency_ms",
      direction: "lower-is-better",
      controlMean: 100,
      variantMean: 110,
      controlSd: 100,
      variantSd: 100,
      controlN: 12,
      variantN: 12,
    });
    const se = Math.sqrt((100 * 100) / 12 + (100 * 100) / 12);
    const z = 10 / se;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    expect(r.pValue).toBeCloseTo(p, 8);
    expect(p).toBeGreaterThan(0.05);
    expect(r.confirmed).toBe(false);
    expect(r.severity).toBe("warn");
    expect(r.message).toContain("NOT yet significant");
  });

  it("keeps ok when the move is trivial even if significant", () => {
    // +0.1% with tiny SDs — hugely significant, but materiality is 0.
    const r = evaluateGuardrail({
      name: "error_rate",
      direction: "lower-is-better",
      controlMean: 0.01,
      variantMean: 0.01001,
      controlSd: 0.0001,
      variantSd: 0.0001,
      controlN: 5000,
      variantN: 5000,
    });
    expect(r.confirmed).toBe(true);
    expect(r.relativeChangeBad).toBeCloseTo(0.001, 6);
    expect(r.severity).toBe("ok");
  });

  it("warns between warn and breach thresholds without significance", () => {
    // +3% (between 2% warn and 5% breach), moderately significant.
    const r = evaluateGuardrail({
      name: "cpu",
      direction: "lower-is-better",
      controlMean: 100,
      variantMean: 103,
      controlSd: 40,
      variantSd: 40,
      controlN: 400,
      variantN: 400,
    });
    expect(r.relativeChangeBad).toBeCloseTo(0.03, 10);
    expect(r.severity).toBe("warn");
  });

  it("honors custom thresholds and alpha", () => {
    // +4% with breach=0.03: material enough for the custom breach threshold.
    const m = {
      name: "latency",
      direction: "lower-is-better" as const,
      controlMean: 100,
      variantMean: 104,
      controlSd: 1,
      variantSd: 1,
      controlN: 900,
      variantN: 900,
    };
    const strict = evaluateGuardrail({ ...m, breachThreshold: 0.03, warnThreshold: 0.01 });
    expect(strict.severity).toBe("breach");
    // Same data with a very tight alpha can flip confirmation off.
    const looseAlpha = evaluateGuardrail({ ...m, breachThreshold: 0.03, warnThreshold: 0.01, alpha: 1e-12 });
    expect(looseAlpha.confirmed).toBe(false);
    expect(looseAlpha.severity).toBe("warn");
  });

  it("returns insufficient-data below 2 observations per arm (NaN, not invented)", () => {
    const r = evaluateGuardrail({
      name: "latency",
      direction: "lower-is-better",
      controlMean: 100,
      variantMean: 105,
      controlSd: 1,
      variantSd: 1,
      controlN: 1,
      variantN: 1,
    });
    expect(r.severity).toBe("insufficient-data");
    expect(r.confirmed).toBe(false);
    expect(Number.isNaN(r.zStatistic)).toBe(true);
    expect(Number.isNaN(r.pValue)).toBe(true);
    expect(Number.isNaN(r.relativeChangeBad)).toBe(true);
  });

  it("rejects non-finite means/SDs and negative SDs", () => {
    const m = {
      name: "x",
      direction: "lower-is-better" as const,
      controlMean: 1,
      variantMean: 1,
      controlSd: 1,
      variantSd: 1,
      controlN: 10,
      variantN: 10,
    };
    expect(() => evaluateGuardrail({ ...m, controlMean: Number.NaN })).toThrow(AbServingError);
    expect(() => evaluateGuardrail({ ...m, variantSd: Number.POSITIVE_INFINITY })).toThrow(AbServingError);
    expect(() => evaluateGuardrail({ ...m, controlSd: -1 })).toThrow(AbServingError);
  });

  it("handles a zero-variance guardrail (identical arms) without exploding", () => {
    const r = evaluateGuardrail({
      name: "flat",
      direction: "lower-is-better",
      controlMean: 10,
      variantMean: 10,
      controlSd: 0,
      variantSd: 0,
      controlN: 50,
      variantN: 50,
    });
    expect(r.zStatistic).toBe(0);
    expect(r.pValue).toBe(1);
    expect(r.severity).toBe("ok");
  });
});

describe("evaluateGuardrails (suite)", () => {
  const okMetric = {
    name: "ok-metric",
    direction: "lower-is-better" as const,
    controlMean: 10,
    variantMean: 10.05,
    controlSd: 1,
    variantSd: 1,
    controlN: 100,
    variantN: 100,
  };
  const breachMetric = {
    name: "broken-metric",
    direction: "higher-is-better" as const,
    controlMean: 20,
    variantMean: 10,
    controlSd: 1,
    variantSd: 1,
    controlN: 100,
    variantN: 100,
  };

  it("overall severity is the WORST verdict, and safe flips on a single breach", () => {
    const good = evaluateGuardrails([okMetric, { ...okMetric, name: "ok-2" }]);
    expect(good.overall).toBe("ok");
    expect(good.safe).toBe(true);

    const bad = evaluateGuardrails([okMetric, breachMetric]);
    expect(bad.overall).toBe("breach");
    expect(bad.safe).toBe(false);
    expect(bad.verdicts.map((v) => v.name)).toEqual(["ok-metric", "broken-metric"]);
  });

  it("insufficient-data does NOT block a rollout (safe), but warn does", () => {
    const sparse = evaluateGuardrails([
      {
        name: "new-metric",
        direction: "lower-is-better",
        controlMean: 1,
        variantMean: 2,
        controlSd: 1,
        variantSd: 1,
        controlN: 1,
        variantN: 1,
      },
    ]);
    expect(sparse.overall).toBe("insufficient-data");
    expect(sparse.safe).toBe(true);

    const warn = evaluateGuardrails([
      {
        name: "watch-metric",
        direction: "lower-is-better",
        controlMean: 10,
        variantMean: 12,
        controlSd: 10,
        variantSd: 10,
        controlN: 10,
        variantN: 10,
      },
    ]);
    expect(warn.overall).toBe("warn");
    expect(warn.safe).toBe(false);
  });

  it("documents the methodology (materiality + significance, worst-of, direction flip)", () => {
    const r = evaluateGuardrails([okMetric]);
    const text = r.methodology.join(" ");
    expect(text).toContain("materiality");
    expect(text).toContain("worst");
    expect(text).toContain("lower-is-better");
  });
});
