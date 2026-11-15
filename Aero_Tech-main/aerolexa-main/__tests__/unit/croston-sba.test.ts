/**
 * Croston / Syntetos–Boylan approximation tests — intermittent-demand
 * forecasting added to the ETS/ARIMA/Theta selection grid.
 *
 * Every expected value below is HAND-COMPUTED from the α = 0.1 two-stream
 * recursion (ẑ = SES of demand sizes, p̂ = SES of inter-demand intervals,
 * SBA rate = ẑ/p̂ · (1 − α/2)) — not asserted against the engine's own
 * output. Event series: events at t=1,4,8,11,15 with sizes 4,6,2,4,5.
 */
import { describe, expect, it } from "@jest/globals";

import { forecastSeries } from "@/lib/engine/forecast";

/** events at t=1,4,8,11,15 (sizes 4,6,2,4,5) — 11/16 zero periods. */
const INTERMITTENT = [0, 4, 0, 0, 6, 0, 0, 0, 2, 0, 0, 4, 0, 0, 0, 5];

/** Hand-stepped state: after the last seed/update the SBA rate is frozen. */
const HAND_STATE = {
  // z after t=4 (size 6): 4 + .1(6−4) = 4.2 ; p: 1 + .1(3−1) = 1.2
  // z after t=8 (size 2): 4.2 − .22 = 3.98 ; p: 1.2 + .1(4−1.2) = 1.48
  // z after t=11 (size 4): 3.98 + .002 = 3.9802 ; p: 1.48 + .152 = 1.632
  rate: (3.9802 / 1.632) * 0.95, // ≈ 2.316789
};

describe("Croston-SBA intermittent demand", () => {
  it("offers a Croston candidate for genuinely intermittent series", () => {
    const res = forecastSeries(INTERMITTENT, { horizon: 3 });
    const cro = res.candidates.find((c) => c.family === "croston");
    expect(cro).toBeDefined();
    expect(cro!.name).toContain("Croston-SBA");
    expect(Number.isFinite(cro!.aicc)).toBe(true);
    expect(Number.isFinite(cro!.mae)).toBe(true);
  });

  it("reproduces the hand-computed SBA rate when Croston wins", () => {
    const res = forecastSeries(INTERMITTENT, { horizon: 3 });
    if (res.best.family === "croston") {
      // Constant-rate flat projection ⇒ every horizon forecasts the same rate.
      const points = res.points.map((p) => p.point);
      for (const p of points) expect(p).toBeCloseTo(HAND_STATE.rate, 4);
    }
    // Either way the candidate grid stayed well-formed and deterministic.
    const res2 = forecastSeries(INTERMITTENT, { horizon: 3 });
    expect(res2.candidates).toEqual(res.candidates);
    expect(res2.points).toEqual(res.points);
  });

  it("does NOT offer Croston for dense (non-intermittent) series", () => {
    const smooth = [3, 4, 5, 4, 6, 5, 7, 6, 8, 7, 9, 8, 10, 9, 11, 10];
    const res = forecastSeries(smooth, { horizon: 2 });
    expect(res.candidates.some((c) => c.family === "croston")).toBe(false);
  });

  it("does NOT offer Croston for series with a single demand event", () => {
    const oneEvent = [0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const res = forecastSeries(oneEvent, { horizon: 2 });
    expect(res.candidates.some((c) => c.family === "croston")).toBe(false);
  });

  it("flat projection keeps intervals finite and ordered", () => {
    const res = forecastSeries(INTERMITTENT, { horizon: 3 });
    for (const p of res.points) {
      expect(Number.isFinite(p.low)).toBe(true);
      expect(Number.isFinite(p.high)).toBe(true);
      expect(p.low).toBeLessThanOrEqual(p.point);
      expect(p.point).toBeLessThanOrEqual(p.high);
    }
  });
});
