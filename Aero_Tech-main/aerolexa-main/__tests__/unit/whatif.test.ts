/**
 * Unit tests for the what-if engine (lib/engine/whatif.ts).
 */
import { runWhatIf, WhatIfError, type WhatIfSource } from "@/lib/engine/whatif";

function linearSource(): WhatIfSource {
  // y ≈ 2x + 100 with a little noise — strong linear signal.
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 1; i <= 40; i++) {
    const x = 10 + i;
    rows.push([`row${i}`, x, 100 + 2 * x + (i % 3) - 1]);
  }
  return {
    columns: [
      { name: "id", type: "string" },
      { name: "price", type: "number" },
      { name: "margin", type: "number" },
    ],
    rows,
  };
}

describe("runWhatIf", () => {
  it("computes a before/after projection from a strong linear relationship", () => {
    const res = runWhatIf(linearSource(), { driverColumn: "price", outcomeColumn: "margin", pctChange: 5 });
    expect(res.fallback).toBe(false);
    expect(res.direction).toBe("increase");
    // Mean price is 30.5; +5% → 32.025; slope ≈ 2.
    expect(res.afterValue).toBeGreaterThan(res.beforeValue);
    const impliedDelta = res.afterValue - res.beforeValue;
    expect(impliedDelta).toBeGreaterThan(0);
    expect(res.model.points).toBe(40);
    // The strong-signal path must say it computed real OLS — no prototype hedging.
    expect(res.confidenceNote).toMatch(/ordinary least squares/i);
    expect(res.confidenceNote).not.toMatch(/prototype/i);
  });

  it("reports a negative change as a decrease", () => {
    const res = runWhatIf(linearSource(), { driverColumn: "price", outcomeColumn: "margin", pctChange: -10 });
    expect(res.direction).toBe("decrease");
    expect(res.afterValue).toBeLessThan(res.beforeValue);
  });

  it("falls back to a hypothetical projection on weak/no signal", () => {
    const weak: WhatIfSource = {
      columns: [
        { name: "price", type: "number" },
        { name: "margin", type: "number" },
      ],
      rows: Array.from({ length: 20 }, (_, i) => [i, 50 + (i % 5)]), // margin independent of price
    };
    const res = runWhatIf(weak, { driverColumn: "price", outcomeColumn: "margin", pctChange: 10 });
    expect(res.fallback).toBe(true);
    expect(res.narrative).toMatch(/hypothetical/i);
  });

  it("uses the proportional projection when there are very few pairs", () => {
    const tiny: WhatIfSource = {
      columns: [
        { name: "price", type: "number" },
        { name: "margin", type: "number" },
      ],
      rows: [
        [10, 100],
        [12, 120],
      ],
    };
    const res = runWhatIf(tiny, { driverColumn: "price", outcomeColumn: "margin", pctChange: 5 });
    expect(res.fallback).toBe(true);
    // Proportional projection on the mean outcome: mean(100,120) × 1.05 = 115.5.
    expect(res.afterValue).toBeCloseTo(115.5, 6);
  });

  it("reports an exact Student-t p-value for the slope (matches linregress)", () => {
    const res = runWhatIf(linearSource(), { driverColumn: "price", outcomeColumn: "margin", pctChange: 5 });
    // The relationship is nearly perfect (y ≈ 2x + noise of amplitude 1), so
    // the slope's significance must be far below 0.05 — and must not be the
    // crude 2·e^−t approximation that older builds used.
    expect(res.model.pValue).toBeLessThan(0.001);
    expect(res.model.pValue).toBeGreaterThanOrEqual(0);
    // Confidence interval must bracket the slope and contain the point estimate.
    const [lo, hi] = res.model.confidenceInterval;
    expect(hi).toBeGreaterThan(lo);
  });

  it("validates inputs", () => {
    expect(() => runWhatIf(linearSource(), { driverColumn: "", outcomeColumn: "margin", pctChange: 5 })).toThrow(
      WhatIfError,
    );
    expect(() =>
      runWhatIf(linearSource(), { driverColumn: "price", outcomeColumn: "margin", pctChange: 5000 }),
    ).toThrow(/percentage/i);
    expect(() => runWhatIf(linearSource(), { driverColumn: "missing", outcomeColumn: "margin", pctChange: 5 })).toThrow(
      /not found/i,
    );
    expect(() => runWhatIf(linearSource(), { driverColumn: "price", outcomeColumn: "price", pctChange: 5 })).toThrow(
      /different/i,
    );
  });
});
