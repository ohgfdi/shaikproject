/**
 * Unit tests for the advanced forecasting engine (lib/engine/forecast-advanced.ts).
 *
 * Oracles: hand-solved OLS on error-free data (β must come back EXACTLY),
 * the AR(1) variance-accumulation formula verified against the closed form,
 * interval symmetry, Yule–Walker φ on a hand-generated AR(1) series (plus the
 * exact γ₁ = γ₀ linear-trend case that pins the clamp at 0.999), and
 * hand-computed top-down reconciliation shares (including the equal-split
 * fallback and a three-level tree whose every level must sum exactly).
 */
import {
  arimaxForecast,
  estimateAr1,
  ForecastAdvancedError,
  reconcileHierarchy,
  type HierarchyNode,
} from "@/lib/engine/forecast-advanced";

/** Deterministic hash noise ∈ (−1, 1) — aperiodic, essentially uncorrelated. */
function hash(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

// ---------------------------------------------------------------------------
// estimateAr1 — Yule–Walker φ = γ₁/γ₀
// ---------------------------------------------------------------------------

describe("estimateAr1", () => {
  it("recovers φ of a hand-generated AR(1) series", () => {
    // η_t = 0.7·η_{t−1} + ε_t with deterministic hash noise; the Yule–Walker
    // estimate on 400 points must land near 0.7 (sd ≈ 1/√n ≈ 0.05).
    const eps = Array.from({ length: 400 }, (_, i) => hash(i));
    const eta: number[] = [eps[0] as number];
    for (let t = 1; t < eps.length; t++) eta.push(0.7 * (eta[t - 1] as number) + (eps[t] as number));
    const phi = estimateAr1(eta);
    expect(phi).toBeGreaterThan(0.6);
    expect(phi).toBeLessThan(0.8);
  });

  it("returns −0.9 EXACTLY on an alternating series (γ₁ = −9, γ₀ = 10)", () => {
    const white = [1, -1, 1, -1, 1, -1, 1, -1, 1, -1]; // m = 0, γ₀ = 10, γ₁ = −9
    expect(estimateAr1(white)).toBeCloseTo(-0.9, 12);
    expect(estimateAr1([1, 2])).toBe(0); // n < 3
    expect(estimateAr1([5, 5, 5, 5])).toBe(0); // c0 = 0 → guard
  });

  it("pins the exact trend closed form and clamps past the boundary", () => {
    // For v_t = t with the engine's convention (γ₁ over the n−1 lagged pairs,
    // γ₀ over all n terms) the ratio is EXACTLY (n−3)/n — at n = 100 that is
    // 0.97, NOT 1: the mean m enters both sums and the lagged sum has one
    // fewer term. The closed form is pinned here so the convention cannot
    // silently drift.
    const trend100 = Array.from({ length: 100 }, (_, t) => t);
    expect(estimateAr1(trend100)).toBeCloseTo(97 / 100, 12);
    // A long-enough trend exceeds the 0.999 clamp and is pinned there.
    const trendLong = Array.from({ length: 30000 }, (_, t) => t); // (n−3)/n = 0.9999
    expect(estimateAr1(trendLong)).toBe(0.999);
  });
});

// ---------------------------------------------------------------------------
// arimaxForecast — dynamic regression with AR(1) errors
// ---------------------------------------------------------------------------

describe("arimaxForecast", () => {
  it("recovers the exact β/intercept oracle on error-free data", () => {
    // y = 2 + 3x exactly (binary-exact values) → residuals ~1e-13, R² ≈ 1.
    const n = 24;
    const x = Array.from({ length: n }, (_, t) => 1 + 0.25 * t);
    const y = x.map((v) => 2 + 3 * v);
    const r = arimaxForecast(
      y,
      x.map((v) => [v]),
      { horizon: 3, futureX: [[2.5], [2.75], [3.0]] },
      ["price"],
    );
    expect(r.coefficients[0]).toBeCloseTo(3, 4);
    expect(r.intercept).toBeCloseTo(2, 4);
    expect(r.sigma).toBeLessThan(1e-6);
    expect(r.rSquared).toBeGreaterThan(0.999999);
    // Scenario propagation: point(h) ≈ 2 + 3·x_future(h), intervals bracket it.
    expect(r.points.map((p) => p.point)).toEqual([
      expect.closeTo(9.5, 3),
      expect.closeTo(10.25, 3),
      expect.closeTo(11, 3),
    ]);
    for (const p of r.points) {
      expect(p.low).toBeLessThanOrEqual(p.point);
      expect(p.point).toBeLessThanOrEqual(p.high);
    }
  });

  it("matches the closed-form AR(1) interval width and the φ^h residual propagation", () => {
    // DGP: y = 2 + 3x + η, η AR(1) with true φ = 0.6, hash noise.
    const n = 60;
    const eps = Array.from({ length: n }, (_, i) => hash(i) * 0.5);
    const eta: number[] = [eps[0] as number];
    for (let t = 1; t < n; t++) eta.push(0.6 * (eta[t - 1] as number) + (eps[t] as number));
    const x = Array.from({ length: n }, (_, t) => 1 + 0.1 * t + 0.05 * (t % 5));
    const y = x.map((v, t) => 2 + 3 * v + (eta[t] as number));

    const H = 3;
    const r = arimaxForecast(
      y,
      x.map((v) => [v]),
      { horizon: H, futureX: Array.from({ length: H }, () => [x[x.length - 1] as number]) },
    );
    expect(r.phi).toBeGreaterThan(0.45); // the AR structure is recovered
    expect(r.phi).toBeLessThan(0.75);
    expect(r.coefficients[0]).toBeGreaterThan(2.7); // β ≈ 3 with sampling noise
    expect(r.coefficients[0]).toBeLessThan(3.3);

    const lastEta = r.residuals[r.residuals.length - 1] as number;
    const z95 = 1.959963984540054;
    let prevWidth = -1;
    for (let h = 1; h <= H; h++) {
      const p = r.points[h - 1] as { point: number; low: number; high: number };
      // Decomposition identity: point = (intercept + β̂·x) + φ̂^h·η_T.
      const regPart = p.point - Math.pow(r.phi, h) * lastEta;
      const xRow = x[x.length - 1] as number;
      expect(regPart).toBeCloseTo(r.intercept + (r.coefficients[0] as number) * xRow, 9);
      // Interval half-width oracle: z·σ·sqrt((1 − φ^{2h})/(1 − φ²)). Tolerance
      // is 7 decimals — the engine computes sqrt(var)·z in a different float
      // ordering than this recomputation, so exact 9-decimal agreement is
      // float noise, not math.
      const half = z95 * r.sigma * Math.sqrt((1 - Math.pow(r.phi, 2 * h)) / (1 - r.phi * r.phi));
      expect(p.high - p.point).toBeCloseTo(half, 7);
      expect(p.point - p.low).toBeCloseTo(half, 7);
      expect(p.high - p.low).toBeGreaterThan(prevWidth);
      prevWidth = p.high - p.low;
    }
  });

  it("fits in-sample one-step values with the AR(1) state: fitted_t = β·x_t + φ·raw_{t−1}", () => {
    // Exact line plus one shock at t = 7 — the AR state must carry it to t = 8.
    const n = 18;
    const x = Array.from({ length: n }, (_, t) => 1 + t);
    const y = x.map((v, t) => 2 + 3 * v + (t === 7 ? 4 : 0));
    const r = arimaxForecast(
      y,
      x.map((v) => [v]),
      { horizon: 2, futureX: [[20], [20]] },
    );
    const xPart = (t: number) => r.intercept + (r.coefficients[0] as number) * (x[t] as number);
    for (let t = 1; t < n; t++) {
      expect(r.fitted[t]).toBeCloseTo(xPart(t) + r.phi * (y[t - 1]! - xPart(t - 1)), 9);
    }
    // residuals = y − fitted, by definition, everywhere.
    r.residuals.forEach((res, t) => expect(res).toBeCloseTo(y[t]! - (r.fitted[t] as number), 9));
    // The shock stays bounded in the fitted path (AR correction is local).
    expect(Math.abs((r.fitted[8] as number) - xPart(8))).toBeLessThan(1.5);
  });

  it("handles white-noise errors (φ ≈ 0) with monotone, near-flat interval widths", () => {
    const n = 60;
    const eps = Array.from({ length: n }, (_, i) => hash(i) * 0.5);
    const x = Array.from({ length: n }, (_, t) => 1 + 0.1 * t + 0.05 * (t % 5));
    const y = x.map((v, t) => 2 + 3 * v + (eps[t] as number));
    const r = arimaxForecast(
      y,
      x.map((v) => [v]),
      { horizon: 2, futureX: [[5], [5]] },
    );
    expect(Math.abs(r.phi)).toBeLessThan(0.3);
    const p1 = r.points[0]!;
    const p2 = r.points[1]!;
    // Var(h) = σ²(1+φ²+…) is non-decreasing in h for any φ ∈ (−1, 1).
    expect(p2.high - p2.low).toBeGreaterThanOrEqual(p1.high - p1.low - 1e-9);
    expect(p2.high - p2.low).toBeLessThan((p1.high - p1.low) * 1.2);
  });

  it("warns near the non-stationary boundary on a near-unit-root residual", () => {
    // Residual = deterministic random walk (φ = 1 process). The Yule–Walker
    // estimate on a walk is biased below 1 by O(1/n), so n = 200 lands φ̂ ≈
    // 0.98 — inside the > 0.95 warning band. (A LINEAR-trend residual does
    // NOT do this: with x also trending, OLS absorbs the shared trend into
    // the slope and the leftover oscillation scores φ̂ ≈ 0.)
    const n = 200;
    const x = Array.from({ length: n }, (_, t) => 1 + 0.1 * t + 0.05 * (t % 5));
    const walk: number[] = [hash(0) * 0.5];
    for (let t = 1; t < n; t++) walk.push((walk[t - 1] as number) + hash(t) * 0.5);
    const y = x.map((v, t) => 2 + 3 * v + (walk[t] as number));
    const r = arimaxForecast(
      y,
      x.map((v) => [v]),
      { horizon: 2, futureX: [[5], [5]] },
    );
    expect(r.phi).toBeGreaterThan(0.95);
    expect(r.warnings.some((w) => w.includes("non-stationary"))).toBe(true);
    expect(r.methodology.join(" ")).toContain("Cochrane–Orcutt");
  });

  it("rejects invalid inputs loudly", () => {
    const x = Array.from({ length: 12 }, (_, t) => [t]);
    const y = x.map((row) => row[0] as number);
    expect(() => arimaxForecast(y.slice(0, 8), x.slice(0, 8), { horizon: 1, futureX: [[1]] })).toThrow(
      ForecastAdvancedError,
    );
    expect(() => arimaxForecast(y, [], { horizon: 1, futureX: [[1]] })).toThrow(/at least one exogenous/);
    expect(() => arimaxForecast([...y, 5], x, { horizon: 1, futureX: [[1]] })).toThrow(/same number of rows/);
    expect(() =>
      arimaxForecast(
        y,
        x.map((row, i) => (i === 0 ? [1, 2] : row)),
        { horizon: 1, futureX: [[1]] },
      ),
    ).toThrow(/rectangular/);
    expect(() => arimaxForecast(y, x, { horizon: 2, futureX: [[1]] })).toThrow(/full horizon/);
    expect(() =>
      arimaxForecast(y, x, {
        horizon: 2,
        futureX: [
          [1, 2],
          [1, 2],
        ],
      }),
    ).toThrow(/columns/);
    expect(() => arimaxForecast(y, x, { horizon: 1, futureX: [[Number.NaN]] })).toThrow(/not finite/);
    expect(() =>
      arimaxForecast(
        y.map((v, i) => (i === 3 ? Number.NaN : v)),
        x,
        { horizon: 1, futureX: [[1]] },
      ),
    ).toThrow(/not finite/);
  });
});

// ---------------------------------------------------------------------------
// reconcileHierarchy — top-down forecast proportions
// ---------------------------------------------------------------------------

describe("reconcileHierarchy", () => {
  const H = 4;
  const leafA: HierarchyNode = { name: "A", baseForecast: [10, 12, 14, 16], children: [] };
  const leafB: HierarchyNode = { name: "B", baseForecast: [30, 30, 32, 34], children: [] };
  const root: HierarchyNode = {
    name: "company",
    baseForecast: [36, 38, 42, 46], // deliberately ≠ A + B = [40,42,46,50]
    children: [leafA, leafB],
  };

  it("distributes the root forecast by base-forecast shares (hand-computed oracle)", () => {
    const r = reconcileHierarchy(root, H);
    // h=0: shares 10/40 = 0.25, 30/40 = 0.75 → A = 0.25·36 = 9, B = 27.
    expect(r.root.children[0]!.forecast[0]).toBeCloseTo(9, 9);
    expect(r.root.children[1]!.forecast[0]).toBeCloseTo(27, 9);
    // h=1: 12/42, 30/42 of 38.
    expect(r.root.children[0]!.forecast[1]).toBeCloseTo((38 * 12) / 42, 9);
    expect(r.root.children[1]!.forecast[1]).toBeCloseTo((38 * 30) / 42, 9);
    // Root keeps its own base forecast untouched.
    expect(r.root.forecast).toEqual([36, 38, 42, 46]);
  });

  it("is coherent at EVERY level of a three-level tree", () => {
    const a1: HierarchyNode = { name: "a1", baseForecast: [4, 4, 4, 4], children: [] };
    const a2: HierarchyNode = { name: "a2", baseForecast: [6, 6, 6, 6], children: [] };
    const b1: HierarchyNode = { name: "b1", baseForecast: [1, 2, 3, 4], children: [] };
    const b2: HierarchyNode = { name: "b2", baseForecast: [9, 8, 7, 6], children: [] };
    const regionA: HierarchyNode = { name: "regionA", baseForecast: [10, 10, 10, 10], children: [a1, a2] };
    const regionB: HierarchyNode = { name: "regionB", baseForecast: [10, 10, 10, 10], children: [b1, b2] };
    const tree: HierarchyNode = { name: "root", baseForecast: [30, 24, 30, 36], children: [regionA, regionB] };
    const r = reconcileHierarchy(tree, H);

    for (let h = 0; h < H; h++) {
      // Regions sum EXACTLY to the root at every h.
      const total = r.root.children.reduce((a, c) => a + c.forecast[h]!, 0);
      expect(total).toBeCloseTo(tree.baseForecast[h]!, 9);
      // Within each region, leaves sum to the region at every h.
      for (const region of r.root.children) {
        const leafSum = region.children.reduce((a, c) => a + c.forecast[h]!, 0);
        expect(leafSum).toBeCloseTo(region.forecast[h]!, 9);
      }
    }
    // a1 keeps its 4/10 share of regionA at every h (flat leaf bases ⇒ flat shares).
    for (let h = 0; h < H; h++) {
      const regionA = r.root.children[0]!;
      expect(regionA.children[0]!.forecast[h]).toBeCloseTo(regionA.forecast[h]! * 0.4, 9);
      expect(regionA.children[1]!.forecast[h]).toBeCloseTo(regionA.forecast[h]! * 0.6, 9);
    }
  });

  it("splits the parent EQUALLY when all child bases are zero at some h", () => {
    const zero: HierarchyNode = { name: "z", baseForecast: [0, 0, 5, 5], children: [] };
    const alsoZero: HierarchyNode = { name: "y", baseForecast: [0, 0, 5, 5], children: [] };
    const node: HierarchyNode = { name: "p", baseForecast: [8, 8, 8, 8], children: [zero, alsoZero] };
    const r = reconcileHierarchy(node, H);
    expect(r.root.children[0]!.forecast[0]).toBeCloseTo(4, 9); // equal split
    expect(r.root.children[1]!.forecast[1]).toBeCloseTo(4, 9);
    expect(r.root.children[0]!.forecast[2]).toBeCloseTo(4, 9); // 5/10 share
    // Coherence holds after the fallback too.
    for (let h = 0; h < H; h++) {
      expect(r.root.children.reduce((a, c) => a + c.forecast[h]!, 0)).toBeCloseTo(8, 9);
    }
  });

  it("reports revisions (before vs after) against manual arithmetic", () => {
    const r = reconcileHierarchy(root, H);
    const a = r.revisions.find((x) => x.name === "A")!;
    expect(a.beforeMean).toBeCloseTo(13, 9); // mean([10,12,14,16])
    const afterMean = [(36 * 10) / 40, (38 * 12) / 42, (42 * 14) / 46, (46 * 16) / 50].reduce((s, v) => s + v, 0) / 4;
    expect(a.afterMean).toBeCloseTo(afterMean, 9);
    expect(a.revisionPct).toBeCloseTo(((afterMean - 13) / 13) * 100, 9);
    expect(r.methodology.join(" ")).toContain("TDFP");
  });

  it("flags large revisions", () => {
    const big: HierarchyNode = { name: "big", baseForecast: [100, 100, 100, 100], children: [] };
    const small: HierarchyNode = { name: "small", baseForecast: [1, 1, 1, 1], children: [] };
    const r = reconcileHierarchy({ name: "r", baseForecast: [50, 50, 50, 50], children: [big, small] }, H);
    expect(r.warnings.some((w) => w.includes("revision"))).toBe(true);
    // big collapses to 100/101 of 50 — a −50.5% revision.
    expect(r.root.children[0]!.forecast[0]).toBeCloseTo((50 * 100) / 101, 9);
  });

  it("rejects invalid hierarchies loudly", () => {
    expect(() => reconcileHierarchy({ name: "x", baseForecast: [1, 2], children: [] }, 2)).toThrow(
      /at least one child/,
    );
    // floor(1.5) = 1 passes the integer gate, then the length check fires.
    expect(() => reconcileHierarchy(root, 1.5)).toThrow(/≠ horizon/);
    expect(() => reconcileHierarchy(root, 0)).toThrow(/positive integer/);
    expect(() =>
      reconcileHierarchy(
        { name: "c", baseForecast: [1, 2, 3, 4], children: [{ name: "k", baseForecast: [1, 2], children: [] }] },
        4,
      ),
    ).toThrow(/≠ horizon/);
    expect(() =>
      reconcileHierarchy(
        {
          name: "c",
          baseForecast: [1, 2, 3, 4],
          children: [{ name: "k", baseForecast: [1, Number.NaN, 3, 4], children: [] }],
        },
        4,
      ),
    ).toThrow(/not finite/);
  });
});
