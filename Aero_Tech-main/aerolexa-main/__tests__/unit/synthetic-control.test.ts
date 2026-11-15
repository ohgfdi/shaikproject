/**
 * Unit tests for the synthetic control engine (lib/engine/synthetic-control.ts).
 *
 * Oracles: hand-computed convex weights for a perfectly-expressible treated
 * unit (the Frank–Wolfe solution must recover the exact blend), gap/ATT
 * arithmetic checked against manual sums, and the placebo permutation rank
 * verified on a constructed donor pool.
 */
import { solveSimplexLeastSquares, syntheticControl, SyntheticControlError } from "@/lib/engine/synthetic-control";

describe("solveSimplexLeastSquares", () => {
  it("recovers an exact convex blend when one exists", () => {
    // Treated = 0.5·donor1 + 0.5·donor2 over 6 pre-periods.
    const X0 = [
      [2, 4],
      [3, 5],
      [4, 6],
      [5, 7],
      [6, 8],
      [7, 9],
    ];
    const x1 = X0.map(([a, b]) => 0.5 * (a as number) + 0.5 * (b as number));
    const { w, gap } = solveSimplexLeastSquares(X0, x1, 2000, 1e-12);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    for (const weight of w) expect(weight).toBeGreaterThanOrEqual(0);
    expect(w[0]).toBeCloseTo(0.5, 4);
    expect(w[1]).toBeCloseTo(0.5, 4);
    expect(gap).toBeLessThan(1e-8);
  });

  it("stays on the simplex when the treated unit is OUTSIDE the donor hull", () => {
    // Treated = 2·donor1 — impossible with convex weights; FW must not
    // compensate with negative weights.
    const X0 = [[1], [2], [3], [4], [5], [6]];
    const x1 = X0.map(([a]) => 2 * (a as number));
    const { w } = solveSimplexLeastSquares(X0, x1, 1500, 1e-10);
    for (const weight of w) expect(weight).toBeGreaterThanOrEqual(-1e-12);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // The best convex answer is w = 1 (the largest donor values).
    expect(w[0]).toBeCloseTo(1, 6);
  });
});

describe("syntheticControl", () => {
  // 8 periods, 4 pre. Treated = donorA + trend; donors correlated.
  // Period-major panel: outcomes[t] = [treated, donorA, donorB] for period t.
  const buildPanel = () => {
    const donorA = [10, 11, 12, 13, 14, 15, 16, 17];
    const donorB = [12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5];
    const treated = donorA.map((v, t) => 0.7 * v + 0.3 * (donorB[t] as number) + (t >= 4 ? 2 : 0)); // +2 jump at t=4
    return treated.map((v, t) => [v, donorA[t] as number, donorB[t] as number]);
  };

  it("recovers the pre-fit blend and detects the post-jump ATT", () => {
    const Y = buildPanel();
    const result = syntheticControl({
      outcomes: Y,
      prePeriods: 4,
      donorNames: ["A", "B"],
      treatedName: "target",
    });
    // Pre-fit: treated's pre path is 0.7·A + 0.3·B, so weights ≈ (0.7, 0.3).
    expect(result.weights[0]).toBeCloseTo(0.7, 3);
    expect(result.weights[1]).toBeCloseTo(0.3, 3);
    // Pre-gaps ≈ 0 → pre RMSE tiny.
    expect(result.preRmse).toBeLessThan(1e-6);
    // Post gaps = exactly +2 → ATT = 2.
    expect(result.att).toBeCloseTo(2, 6);
    expect(result.postRmse).toBeCloseTo(2, 6);
    expect(result.placeboCount).toBe(2);
  });

  // The two-donor panel above is a perfect arithmetic oracle but has NO
  // placebo power: both donors are near-perfectly expressible as the treated
  // series, so every in-space placebo fit puts w = 1 on the treated unit and
  // inherits its jump. With six heterogeneous donors the same +2.5 effect is
  // correctly ranked as the most extreme of the pool.
  it("ranks a real effect first when the donor pool is heterogeneous", () => {
    const T = 10;
    const T0 = 6;
    // Deterministic idiosyncratic wiggle — each donor has its own path, so no
    // single series (least of all the treated one) predicts them all.
    const wig = (j: number, t: number) => 0.35 * Math.sin(1.7 * j + 2.3 * t) + 0.21 * Math.cos(0.9 * j + 1.1 * t);
    const donors = Array.from({ length: 6 }, (_, j) =>
      Array.from({ length: T }, (_, t) => Number((8 + j * 2 + t * 0.7 + wig(j, t)).toFixed(4))),
    );
    const mix = [0.25, 0.2, 0.18, 0.15, 0.12, 0.1];
    const treated = Array.from({ length: T }, (_, t) => {
      const blend = mix.reduce((a, x, j) => a + (x as number) * ((donors[j] as number[])[t] as number), 0);
      return blend + (t >= T0 ? 2.5 : 0);
    });
    const Y = treated.map((v, t) => [v, ...donors.map((d) => (d as number[])[t] as number)]);

    const r = syntheticControl({ outcomes: Y, prePeriods: T0 });
    // The pre-path IS a convex blend of the donors, so the fit recovers it.
    expect(r.preRmse).toBeLessThan(0.05);
    expect(r.att).toBeCloseTo(2.5, 1);
    // Most extreme of 6 placebos → the minimum attainable permutation p.
    expect(r.placeboCount).toBe(6);
    expect(r.placeboRank).toBe(1);
    expect(r.placeboPValue).toBeCloseTo(1 / 7, 9);
    // The engine must still say so out loud: 6 donors cannot reach p < 0.05.
    expect(r.warnings.join(" ")).toContain("placebo");
  });

  it("computes gaps, ATT and relative ATT against manual arithmetic", () => {
    const Y = buildPanel();
    const r = syntheticControl({ outcomes: Y, prePeriods: 4, donorNames: ["A", "B"] });
    // Manual: gaps = [0,0,0,0, 2,2,2,2] (weights recover the blend exactly).
    expect(
      r.gaps
        .map((g) => g.gap)
        .slice(0, 4)
        .every((g) => Math.abs(g) < 1e-6),
    ).toBe(true);
    expect(
      r.gaps
        .map((g) => g.gap)
        .slice(4)
        .every((g) => Math.abs(g - 2) < 1e-6),
    ).toBe(true);
    expect(r.gaps.every((g) => g.isPost === g.t >= 4)).toBe(true);
    // relativeAtt = |2| / mean(pre treated) = 2 / mean([11.6,12.35,13.1,13.85]).
    const preTreated = Y.slice(0, 4).map((row) => row[0] as number);
    const preMean = preTreated.reduce((a, v) => a + v, 0) / 4;
    expect(r.relativeAtt).toBeCloseTo(2 / preMean, 6);
    // Weights frozen at T₀: contributions carry the donor names.
    expect(r.contributions.map((c) => c.name).sort()).toEqual(["A", "B"]);
    expect(r.identifyingAssumption.toLowerCase()).toContain("no unobserved simultaneous shock");
  });

  it("flags a poor pre-fit instead of hiding it", () => {
    // Treated follows a completely different path than any convex donor blend.
    const Y = [
      [100, 1, 1.2],
      [80, 2, 2.1],
      [120, 3, 2.9],
      [60, 4, 4.2],
      [200, 5, 5.1],
      [50, 6, 5.9],
    ];
    const r = syntheticControl({ outcomes: Y, prePeriods: 4 });
    expect(r.warnings.some((w) => w.includes("Poor pre-fit"))).toBe(true);
  });

  it("rejects invalid panels loudly", () => {
    expect(() => syntheticControl({ outcomes: [[1, 2]], prePeriods: 2 })).toThrow(SyntheticControlError);
    expect(() =>
      syntheticControl({
        outcomes: [
          [1, 2],
          [3, 4],
        ],
        prePeriods: 2,
      }),
    ).toThrow(SyntheticControlError);
    expect(() =>
      syntheticControl({
        outcomes: [
          [1, 2],
          [3, 4],
          [5, 6],
          [7, 8],
        ],
        prePeriods: 3,
      }),
    ).toThrow(SyntheticControlError);
    expect(() =>
      syntheticControl({
        outcomes: [
          [1, 2],
          [3, 4],
          [5, 6],
          [7, 8],
        ],
        prePeriods: 1.5,
      }),
    ).toThrow(SyntheticControlError);
    expect(() =>
      syntheticControl({
        outcomes: [
          [1, 2],
          [3, Number.NaN],
          [5, 6],
          [7, 8],
        ],
        prePeriods: 2,
      }),
    ).toThrow(SyntheticControlError);
    expect(() =>
      syntheticControl({
        outcomes: [
          [1, 2, 3],
          [4, 5, 6],
          [7, 8],
          [9, 10, 11],
        ],
        prePeriods: 2,
      }),
    ).toThrow(/rectangular/);
  });
});
