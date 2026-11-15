/**
 * The weak-signal rescue path of the what-if engine: when plain OLS r² < 0.12
 * the engine now attempts a cross-validated ridge fit and promotes the
 * projection ONLY when the regularized model beats the mean baseline
 * out-of-fold. Truly independent data must still fall back hypothetically,
 * and the strong-signal path must be untouched (no rescue attempted).
 */
import { runWhatIf, type WhatIfSource } from "@/lib/engine/whatif";

/**
 * Weak-but-real signal: y = 3x + big deterministic pseudo-noise. The noise
 * modulus is chosen so the in-sample OLS r² lands well below the 0.12
 * threshold while the (correctly specified) linear model still generalizes —
 * exactly the regime ridge rescue exists for. The first assertion verifies
 * the premise so the fixture cannot silently drift into the strong path.
 */
function weakRealSignalSource(): WhatIfSource {
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 0; i < 120; i++) {
    const x = 10 + i;
    const noise = ((i * 97) % 1237) - 618;
    rows.push([x, 3 * x + noise]);
  }
  return {
    columns: [
      { name: "price", type: "number" },
      { name: "margin", type: "number" },
    ],
    rows,
  };
}

describe("runWhatIf — cross-validated ridge rescue", () => {
  it("promotes a weak-but-real signal to a regularized calculated projection", () => {
    const source = weakRealSignalSource();
    const res = runWhatIf(source, { driverColumn: "price", outcomeColumn: "margin", pctChange: 5 });

    // Premise: plain OLS in-sample r² is genuinely below the weak threshold.
    expect(res.model.rSquared).toBeLessThan(0.12);
    // …but the CV-regularized model beat the mean baseline out-of-fold.
    expect(res.fallback).toBe(false);
    expect(res.regularized).toBeDefined();
    expect(res.regularized!.method).toBe("ridge");
    expect(res.regularized!.cvR2).toBeGreaterThan(0);
    expect(res.regularized!.folds).toBeGreaterThanOrEqual(2);
    // The recovered slope is close to the true 3 (shrinkage may pull it in).
    expect(Math.abs(res.model.slope - 3)).toBeLessThan(0.75);
    // Direction and magnitude sanity: +5% driver ⇒ outcome moves up.
    expect(res.afterValue).toBeGreaterThan(res.beforeValue);
    // Honesty: the note says ridge + cross-validated, still not causal.
    expect(res.confidenceNote).toMatch(/ridge/i);
    expect(res.confidenceNote).toMatch(/cross-validated/i);
    expect(res.confidenceNote).toMatch(/not causation|associative/i);
    expect(res.methodology.some((m) => /approximate/i.test(m))).toBe(true);
  });

  it("still refuses hypothetical promotion on truly independent data", () => {
    const weak: WhatIfSource = {
      columns: [
        { name: "price", type: "number" },
        { name: "margin", type: "number" },
      ],
      rows: Array.from({ length: 40 }, (_, i) => [i, 50 + (i % 5)]), // margin independent of price
    };
    const res = runWhatIf(weak, { driverColumn: "price", outcomeColumn: "margin", pctChange: 10 });
    expect(res.fallback).toBe(true);
    expect(res.regularized).toBeUndefined();
    expect(res.narrative).toMatch(/hypothetical/i);
  });

  it("leaves the strong-signal path untouched (no rescue, OLS inference intact)", () => {
    const rows: (string | number | boolean | null)[][] = [];
    for (let i = 1; i <= 40; i++) {
      const x = 10 + i;
      rows.push([x, 100 + 2 * x + (i % 3) - 1]);
    }
    const source: WhatIfSource = {
      columns: [
        { name: "price", type: "number" },
        { name: "margin", type: "number" },
      ],
      rows,
    };
    const res = runWhatIf(source, { driverColumn: "price", outcomeColumn: "margin", pctChange: 5 });
    expect(res.fallback).toBe(false);
    expect(res.regularized).toBeUndefined();
    // Strong path keeps the exact-Student-t language and HC1 fields.
    expect(res.confidenceNote).toMatch(/ordinary least squares/i);
    expect(res.model.slopeStandardErrorHC1).toBeDefined();
    expect(res.model.pValueHC1).toBeDefined();
  });

  it("is deterministic for the same input", () => {
    const source = weakRealSignalSource();
    const a = JSON.stringify(runWhatIf(source, { driverColumn: "price", outcomeColumn: "margin", pctChange: 5 }));
    const b = JSON.stringify(runWhatIf(source, { driverColumn: "price", outcomeColumn: "margin", pctChange: 5 }));
    expect(a).toBe(b);
  });
});
