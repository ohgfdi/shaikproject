/**
 * Unit tests for the ridge engine (lib/engine/ridge.ts).
 *
 * The closed-form oracle for a single standardized feature: with ZᵀZ = G and
 * penalty α, β_z = (ZᵀZ + αI)⁻¹Zᵀyc, mapped back to original units
 * b = β_z/σ. For one feature this reduces to
 *   b = Xcᵀyc / (XcᵀXc + α·σ²)
 * which the tests compute independently (hand arithmetic, not the engine).
 */
import { crossValidatedRidge, fitRidge } from "@/lib/engine/ridge";

describe("fitRidge", () => {
  it("matches the closed-form solution for a single feature", () => {
    // X = 1..4, y = 2x (perfectly linear). XcᵀXc = 5, Xcᵀyc = 10, σ² = 5/3.
    const X = [[1], [2], [3], [4]];
    const y = [2, 4, 6, 8];
    const alpha = 1;
    const fit = fitRidge(X, y, alpha);
    expect(fit).not.toBeNull();
    const sd2 = 5 / 3;
    const expectedSlope = 10 / (5 + alpha * sd2); // = 10/(20/3) = 1.5
    expect(fit!.coefficients[0]).toBeCloseTo(expectedSlope, 10);
    // Intercept keeps the centered prediction exact: ȳ − b·x̄ = 5 − 1.5·2.5.
    expect(fit!.intercept).toBeCloseTo(5 - expectedSlope * 2.5, 10);
  });

  it("shrinks the slope monotonically toward zero as α grows", () => {
    const X = [[1], [2], [3], [4], [5], [6]];
    const y = [3.1, 3.9, 6.2, 7.8, 10.2, 11.9]; // ≈ 2x with noise
    const a0 = fitRidge(X, y, 0)!.coefficients[0]!;
    const a1 = fitRidge(X, y, 1)!.coefficients[0]!;
    const a100 = fitRidge(X, y, 100)!.coefficients[0]!;
    const a1e6 = fitRidge(X, y, 1e6)!.coefficients[0]!;
    expect(a1).toBeLessThan(a0);
    expect(a100).toBeLessThan(a1);
    expect(Math.abs(a1e6)).toBeLessThan(Math.abs(a100)); // near-zero at huge α
    expect(a1e6).toBeGreaterThanOrEqual(0);
  });

  it("prediction at the feature means equals ȳ for any α (centering guarantee)", () => {
    const X = [
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
      [5, 12],
      [6, 22],
    ];
    const y = [3, 6, 8, 11, 5, 9];
    const yMean = y.reduce((a, v) => a + v, 0) / y.length;
    const xMeans = [3.5, 22.333333333333332];
    for (const alpha of [0.5, 3, 50]) {
      const fit = fitRidge(X, y, alpha)!;
      const pred = fit.intercept + fit.coefficients.reduce((acc, b, j) => acc + b * xMeans[j]!, 0);
      expect(pred).toBeCloseTo(yMean, 10);
    }
  });

  it("pins zero-variance columns to coefficient 0 instead of exploding", () => {
    const X = [
      [1, 7],
      [2, 7],
      [3, 7],
      [4, 7],
    ];
    const y = [2, 4, 6, 8];
    const fit = fitRidge(X, y, 1)!;
    expect(fit.coefficients[1]).toBe(0);
    expect(fit.coefficients[0]).toBeCloseTo(10 / (5 + 5 / 3), 10);
  });

  it("returns null for degenerate input", () => {
    expect(fitRidge([], [], 1)).toBeNull();
    expect(fitRidge([[1], [2]], [1], 1)).toBeNull(); // row count mismatch
    expect(fitRidge([[1], [2]], [1, 2], -3)).toBeNull(); // negative α
    expect(fitRidge([[1], [2]], [1, 2], Number.NaN)).toBeNull();
  });
});

describe("crossValidatedRidge", () => {
  it("finds a real linear signal out-of-fold (cvR² near 1) and a slope near the truth", () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 40; i++) {
      const x = 10 + i;
      X.push([x]);
      y.push(2 * x + (i % 3) - 1); // slope 2, tiny deterministic noise
    }
    const cv = crossValidatedRidge(X, y);
    expect(cv).not.toBeNull();
    expect(cv!.cvR2).toBeGreaterThan(0.9);
    expect(Math.abs(cv!.coefficients[0]! - 2)).toBeLessThan(0.1);
    expect([0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100]).toContain(cv!.alpha);
    expect(cv!.folds).toBe(5);
  });

  it("refuses to promote pure noise (cvR² ≤ 0)", () => {
    // y is a deterministic function of the row index that is INDEPENDENT of x.
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 40; i++) {
      X.push([i * 3 + 7]);
      y.push(50 + ((i * 17) % 9)); // periodic in i, unrelated to x's ordering
    }
    const cv = crossValidatedRidge(X, y);
    expect(cv).not.toBeNull();
    expect(cv!.cvR2).toBeLessThanOrEqual(0);
  });

  it("solves a collinear two-feature design where OLS is not estimable", () => {
    // x2 = 2·x1 exactly — OLS on the full design is singular; ridge is not.
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 30; i++) {
      const x = 5 + i;
      X.push([x, 2 * x]);
      y.push(4 * x + 10 + (i % 2)); // y = 4x + 10
    }
    const cv = crossValidatedRidge(X, y);
    expect(cv).not.toBeNull();
    expect(cv!.cvR2).toBeGreaterThan(0.9);
    // Symmetric split of the coefficient across the collinear pair: b1 + 2·b2 ≈ 4.
    const effective = cv!.coefficients[0]! + 2 * cv!.coefficients[1]!;
    expect(Math.abs(effective - 4)).toBeLessThan(0.2);
  });

  it("returns null when there is too little data or a constant outcome", () => {
    const tinyX = [[1], [2], [3]];
    const tinyY = [1, 2, 3];
    expect(crossValidatedRidge(tinyX, tinyY)).toBeNull(); // n < 8
    const constY = Array.from({ length: 20 }, () => 5);
    expect(
      crossValidatedRidge(
        tinyX.map((v, i) => [i]),
        constY,
      ),
    ).toBeNull();
  });

  it("is deterministic across repeated calls", () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 24; i++) {
      X.push([i + 1, 100 - i]);
      y.push(3 * (i + 1) - (100 - i) + ((i * 7) % 5));
    }
    const a = JSON.stringify(crossValidatedRidge(X, y));
    const b = JSON.stringify(crossValidatedRidge(X, y));
    expect(a).toBe(b);
  });
});
