import {
  mean,
  median,
  variance,
  stddev,
  min,
  max,
  quantile,
  fiveNumberSummary,
  outlierCount,
  histogram,
  pearson,
  linearRegression,
  kmeans,
  standardize,
  trendDirection,
  sum,
} from "@/lib/engine/stats";

describe("statistics primitives", () => {
  it("computes mean, variance and standard deviation", () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(values)).toBeCloseTo(5, 10);
    expect(sum(values)).toBe(40);
    // Population variance of [2..9-ish set]: check against a fixed expectation.
    expect(variance(values, false)).toBeCloseTo(4, 6);
    expect(stddev(values, false)).toBeCloseTo(2, 6);
  });

  it("returns NaN-safe defaults for empty input", () => {
    expect(mean([])).toBeNaN();
    expect(median([])).toBeNaN();
    expect(min([])).toBeNaN();
    expect(max([])).toBeNaN();
    expect(fiveNumberSummary([])).toEqual([0, 0, 0, 0, 0]);
  });

  it("computes median for odd and even lengths", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("computes quantiles consistently", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(values, 0)).toBe(1);
    expect(quantile(values, 1)).toBe(10);
    expect(quantile(values, 0.5)).toBe(median(values));
  });

  it("detects outliers with the 1.5×IQR rule", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100];
    expect(outlierCount(values)).toBe(1);
    expect(outlierCount([1, 2, 3])).toBe(0);
  });

  it("histogram preserves counts and produces bins", () => {
    const values = [1, 1, 2, 2, 3, 3, 4, 4];
    const { counts, binLabels, edges } = histogram(values, 4);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(values.length);
    expect(binLabels.length).toBe(4);
    expect(edges.length).toBe(5);
  });

  it("returns an empty histogram for empty input", () => {
    expect(histogram([])).toEqual({ edges: [], counts: [], binLabels: [] });
  });

  it("measures perfect positive and negative correlation", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    const { r } = pearson(x, y);
    expect(r).toBeCloseTo(1, 6);
    const neg = pearson(
      x,
      y.map((v) => -v),
    );
    expect(neg.r).toBeCloseTo(-1, 6);
  });

  it("fits a linear trend on index values", () => {
    const y = [10, 12, 14, 16, 18];
    const fit = linearRegression(y);
    expect(fit.slope).toBeCloseTo(2, 6);
    expect(fit.r2).toBeCloseTo(1, 6);
    expect(fit.n).toBe(5);
  });

  it("separates two distinct clusters deterministically", () => {
    const data: number[][] = [];
    for (let i = 0; i < 30; i++) data.push([0 + i * 0.01, 0 + i * 0.01]);
    for (let i = 0; i < 30; i++) data.push([10 + i * 0.01, 10 + i * 0.01]);
    const labels = kmeans(data, 2);
    const firstHalf = labels.slice(0, 30);
    const secondHalf = labels.slice(30);
    const setA = new Set(firstHalf);
    const setB = new Set(secondHalf);
    // each half should be internally consistent
    expect(setA.size).toBe(1);
    expect(setB.size).toBe(1);
    expect(setA.values().next().value).not.toBe(setB.values().next().value);
  });

  it("standardizes columns to near-zero mean", () => {
    const z = standardize([
      [1, 100],
      [2, 200],
      [3, 300],
    ]);
    const colMean = mean(z.map((r) => r[0] ?? 0));
    expect(Math.abs(colMean)).toBeLessThan(1e-9);
  });

  it("classifies trend direction", () => {
    expect(trendDirection(12.4)).toBe("up");
    expect(trendDirection(-3)).toBe("down");
    expect(trendDirection(0.2)).toBe("flat");
    expect(trendDirection(null)).toBe("flat");
  });
});
