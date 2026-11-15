/**
 * What-if 3D layout (S5c) — oracle tests.
 *
 * Hand-computed expectations pin the physicalization contract: slab heights
 * encode the engine's beforeValue/afterValue against a shared max, the delta
 * arrow span is the computed delta, and the fallback result is honestly
 * flagged so the scene can demote itself.
 */
import { buildWhatIfLayout, deltaColor, RESULT_SLAB_MAX, RESULT_SLAB_MIN, SLAB_GAP } from "@/lib/scene/whatif-scene";
import type { WhatIfResult } from "@/lib/types";

function resultFixture(overrides: Partial<WhatIfResult> = {}): WhatIfResult {
  return {
    driverColumn: "Price",
    outcomeColumn: "Margin",
    pctChange: 10,
    beforeValue: 100,
    afterValue: 120,
    delta: 20,
    deltaPct: 20,
    direction: "increase",
    driverMean: 50,
    model: {
      slope: 2,
      intercept: 0,
      rSquared: 0.8,
      points: 50,
      pValue: 0.001,
      confidenceInterval: [1.5, 2.5],
    },
    fallback: false,
    narrative: "n",
    confidenceNote: "c",
    methodology: [],
    ...overrides,
  };
}

describe("buildWhatIfLayout — what-if physicalization", () => {
  it("before/after slabs sit symmetrically around the origin at SLAB_GAP", () => {
    const layout = buildWhatIfLayout(resultFixture());
    expect(layout.before.x).toBeCloseTo(-SLAB_GAP / 2);
    expect(layout.after.x).toBeCloseTo(SLAB_GAP / 2);
  });

  it("heights scale against the shared max — the taller value hits RESULT_SLAB_MAX", () => {
    const layout = buildWhatIfLayout(resultFixture());
    expect(layout.after.height).toBeCloseTo(RESULT_SLAB_MAX); // 120 is the max
    // before: 0.3 + (100/120) * (3 − 0.3) = 0.3 + 2.25 = 2.55
    expect(layout.before.height).toBeCloseTo(0.3 + (100 / 120) * (RESULT_SLAB_MAX - RESULT_SLAB_MIN));
  });

  it("carries the engine's computed delta, direction and fallback flag verbatim", () => {
    const layout = buildWhatIfLayout(resultFixture({ delta: -5, direction: "decrease", fallback: true }));
    expect(layout.delta).toBe(-5);
    expect(layout.direction).toBe("decrease");
    expect(layout.fallback).toBe(true);
  });

  it("a zero baseline still renders a visible slab (min-height honesty)", () => {
    const layout = buildWhatIfLayout(resultFixture({ beforeValue: 0, afterValue: 80, delta: 80 }));
    expect(layout.before.height).toBeCloseTo(RESULT_SLAB_MIN);
  });

  it("is deterministic — the same result lays out identically twice", () => {
    const r = resultFixture();
    expect(buildWhatIfLayout(r)).toEqual(buildWhatIfLayout(r));
  });
});

describe("deltaColor", () => {
  it("green for a gain, rose for a drop, green at zero", () => {
    expect(deltaColor(20)).toBe("#58B368");
    expect(deltaColor(-5)).toBe("#E8637A");
    expect(deltaColor(0)).toBe("#58B368");
  });
});
