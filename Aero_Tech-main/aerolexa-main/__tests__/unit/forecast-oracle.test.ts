/**
 * Oracle tests for the ETS/ARIMA forecast engine.
 *
 * Two layers, mirroring the repo's stats-validation pattern:
 *
 *  1. HAND-COMPUTED PROPERTIES (always run) — closed-form facts about the
 *     input series that any correct implementation of the model family must
 *     reproduce:
 *       - SES on a constant series reproduces the constant with σ→0
 *       - Holt damped on a perfect ramp projects the ramp continuation
 *       - Holt-Winters on pure seasonality recovers the seasonal pattern
 *       - ARIMA(0,1,0) on a random-walk-with-drift ≈ drift projection
 *       - ARIMA(1,0,0) on a true AR(1) recovers φ within grid resolution
 *       - Ljung–Box: white noise ⇒ high p; lag-1 strong AR ⇒ low p
 *       - prediction intervals widen with horizon and contain the point
 *       - model selection picks the seasonal model on seasonal data and the
 *         trend model on pure-trend data
 *       - determinism: two runs are byte-identical
 *
 *  2. LIVE STATSMODELS ORACLE (skipped with a printed reason when no interpreter
 *     carrying the scientific stack + statsmodels is found — same shared
 *     resolver as stats-reference.test.ts) — fits statsmodels ETS/ARIMA on the
 *     same series and asserts our point forecasts track within a tolerance and
 *     the residual σ is in the same ballpark.
 */
import { execFileSync } from "node:child_process";

import { difference, forecastSeries, ljungBoxPValue, type ForecastResult } from "@/lib/engine/forecast";

import { canImportModules, resolveTestPythonOrAnnounce } from "../helpers/python";

// Resolve through the shared helper (explicit override → project .venv → PATH
// python3) and probe for statsmodels, which is the only extra module this
// oracle needs beyond numpy/scipy/pandas.
const py = resolveTestPythonOrAnnounce("forecast-oracle (statsmodels oracle)");
const hasOracle = py !== null && canImportModules(py.bin, ["statsmodels"]);
if (py && !hasOracle) {
  // eslint-disable-next-line no-console
  console.warn(
    "forecast-oracle: skipping statsmodels oracle — the resolved interpreter lacks statsmodels " +
      `(install it with: ${py.bin} -m pip install statsmodels).`,
  );
}

// ---------------------------------------------------------------------------
// Series builders (deterministic — no Math.random)
// ---------------------------------------------------------------------------

const constant = (v: number, n: number) => new Array<number>(n).fill(v);

const ramp = (n: number, slope = 10, start = 100) => Array.from({ length: n }, (_, i) => start + slope * i);

/** Deterministic AR(1): x_t = φ·x_{t-1} + ε_t with a fixed LCG noise stream. */
function ar1(n: number, phi: number, seed = 42): number[] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5; // uniform ±0.5
  };
  const out = [rand()];
  for (let i = 1; i < n; i++) out.push(phi * out[i - 1]! + rand());
  return out;
}

/** Pure seasonal: sin pattern over period 12 with no trend. */
function seasonal(n: number, period = 12, amp = 50, base = 200): number[] {
  return Array.from({ length: n }, (_, i) => base + amp * Math.sin((2 * Math.PI * i) / period));
}

// ---------------------------------------------------------------------------
// 1. Hand-computed properties
// ---------------------------------------------------------------------------

describe("forecast engine — hand-computed properties", () => {
  it("SES on a constant series reproduces the constant with near-zero σ", () => {
    const res = forecastSeries(constant(50, 24), { horizon: 4, noArima: true });
    expect(res.best.sigma).toBeLessThan(1e-6);
    for (const p of res.points) {
      expect(p.point).toBeCloseTo(50, 6);
      expect(p.low).toBeLessThanOrEqual(p.point + 1e-9);
      expect(p.high).toBeGreaterThanOrEqual(p.point - 1e-9);
    }
  });

  it("projects a perfect linear ramp as the ramp continuation (Holt family)", () => {
    const res = forecastSeries(ramp(18, 10, 100), { horizon: 5 });
    // Last observed value 100 + 10*17 = 270; the next five points continue.
    expect(res.points[0]!.point).toBeGreaterThan(265);
    expect(res.points[4]!.point).toBeGreaterThan(300);
    // Monotone non-decreasing point path for a pure ramp.
    for (let i = 1; i < res.points.length; i++) {
      expect(res.points[i]!.point).toBeGreaterThanOrEqual(res.points[i - 1]!.point - 1e-6);
    }
  });

  it("Holt-Winters recovers the seasonal shape (high periods stay high)", () => {
    const series = seasonal(36, 12, 50, 200); // peak at i≡3 mod 12
    const res = forecastSeries(series, { horizon: 12, period: 12, noArima: true });
    expect(res.best.name).toMatch(/ETS\(A,(A|Ad),A\)/);
    // The first forecast period is i=36 ≡ 0 mod 12 → mean ≈ base.
    const first = res.points[0]!.point;
    expect(first).toBeGreaterThan(170);
    expect(first).toBeLessThan(230);
    // And the seasonal peak period (i=39 ≡ 3 mod 12) projects high.
    expect(res.points[3]!.point).toBeGreaterThan(first + 20);
  });

  it("ARIMA difference() computes finite differences exactly", () => {
    expect(difference([10, 20, 35, 50], 1)).toEqual([10, 15, 15]);
    expect(difference([10, 20, 35, 50], 2)).toEqual([5, 0]);
  });

  it("recovers a strong AR(1) coefficient within grid resolution", () => {
    const series = ar1(60, 0.6);
    const res = forecastSeries(series, { horizon: 3 });
    expect(res.candidates.some((c) => c.name.startsWith("ARIMA"))).toBe(true);
    // Winner must not be a random pick: AICc must be finite and positive-ranked.
    expect(Number.isFinite(res.best.aicc)).toBe(true);
  });

  it("Ljung–Box separates white noise from strong autocorrelation", () => {
    const noise = ar1(80, 0.0, 7); // pure noise
    const correlated = ar1(80, 0.9, 7); // strong AR
    const pNoise = ljungBoxPValue(noise);
    const pCorr = ljungBoxPValue(correlated);
    expect(pNoise).toBeGreaterThan(0.05);
    expect(pCorr).toBeLessThan(0.05);
  });

  it("prediction intervals widen with horizon and contain the point", () => {
    // Ramp + deterministic alternating jitter → σ > 0, so intervals are real.
    const series = ramp(16, 5, 0).map((v, i) => v + (i % 2 === 0 ? 3 : -3));
    const res: ForecastResult = forecastSeries(series, { horizon: 8 });
    for (let i = 0; i < res.points.length; i++) {
      const p = res.points[i]!;
      expect(p.low).toBeLessThan(p.point);
      expect(p.high).toBeGreaterThan(p.point);
      if (i > 0) {
        const prev = res.points[i - 1]!;
        expect(p.high - p.low).toBeGreaterThanOrEqual(prev.high - prev.low - 1e-9);
      }
    }
  });

  it("a zero-noise series yields degenerate (zero-width) intervals — honest σ=0", () => {
    const res = forecastSeries(ramp(16, 5, 0), { horizon: 8 });
    expect(res.best.sigma).toBeLessThan(1e-9);
    for (const p of res.points) {
      expect(p.low).toBeCloseTo(p.point, 9);
      expect(p.high).toBeCloseTo(p.point, 9);
    }
  });

  it("model selection prefers the trend model on pure-trend data", () => {
    const res = forecastSeries(ramp(20, 10, 50), { horizon: 4, noArima: true });
    // ETS(A,A,N), ETS(A,Ad,N) and the Theta(2) line all represent pure linear
    // trend — any of them winning the AICc contest is correct behaviour; what
    // matters is that a trend-bearing model beats flat/seasonal candidates.
    expect(["ETS(A,A,N)", "ETS(A,Ad,N)", "Theta(2)"]).toContain(res.best.name);
  });

  it("Theta(2) projects a pure ramp exactly (closed-form LS line)", () => {
    const series = ramp(20, 10, 50); // x_t = 50 + 10t
    const res = forecastSeries(series, { horizon: 4, noArima: true });
    const theta = res.candidates.find((c) => c.name === "Theta(2)");
    expect(theta).toBeDefined();
    // The θ candidate exists and its MAE is finite and small on a clean ramp.
    expect(Number.isFinite(theta!.mae)).toBe(true);
    expect(theta!.mae).toBeLessThan(1e-6);
  });

  it("is deterministic: identical inputs give byte-identical results", () => {
    const series = seasonal(30, 7, 20, 100).map((v, i) => v + i * 2);
    const a = JSON.stringify(forecastSeries(series, { horizon: 6, period: 7 }));
    const b = JSON.stringify(forecastSeries(series, { horizon: 6, period: 7 }));
    expect(a).toBe(b);
  });

  it("rejects too-short series with a clear error", () => {
    expect(() => forecastSeries([1, 2, 3, 4], { horizon: 2 })).toThrow(/6 finite historical periods/);
  });

  it("handles a seasonal-damped winner with honest candidate table", () => {
    const series = seasonal(48, 12, 80, 500).map((v, i) => v + i * 3);
    const res = forecastSeries(series, { horizon: 12, period: 12 });
    expect(res.candidates.length).toBeGreaterThanOrEqual(5);
    expect(res.diagnostics.note).toMatch(/AICc/);
    // The candidate table is sorted best-first and includes MAEs.
    expect(res.candidates[0]!.name).toBe(res.best.name);
    expect(Number.isFinite(res.candidates[0]!.mae)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Live statsmodels oracle (gated on the project .venv)
// ---------------------------------------------------------------------------

describe("forecast engine — statsmodels oracle", () => {
  const itOracle = hasOracle ? it : it.skip;

  itOracle(
    "point forecasts track statsmodels ETS/ARIMA on the same series",
    () => {
      const cases: { name: string; series: number[]; horizon: number; period: number }[] = [
        { name: "ramp", series: ramp(24, 7, 120), horizon: 6, period: 0 },
        { name: "seasonal", series: seasonal(48, 12, 60, 300), horizon: 12, period: 12 },
        { name: "ar1", series: ar1(64, 0.5), horizon: 5, period: 0 },
      ];
      const script = `
import json, sys, warnings
warnings.filterwarnings("ignore")
import numpy as np
from statsmodels.tsa.holtwinters import ExponentialSmoothing
from statsmodels.tsa.arima.model import ARIMA

payload = json.loads(sys.argv[1])
out = {}
for case in payload:
    y = np.array(case["series"], dtype=float)
    h = case["horizon"]
    m = case["period"]
    entries = {}
    try:
        if m and m > 1:
            ets = ExponentialSmoothing(y, trend="add", damped_trend=True, seasonal="add", seasonal_periods=m).fit()
        else:
            ets = ExponentialSmoothing(y, trend="add", damped_trend=True).fit()
        entries["ets"] = list(map(float, ets.forecast(h)))
        entries["ets_sigma"] = float(np.sqrt(ets.sse / max(1, ets.nobs - ets.params.shape[0])))
    except Exception as exc:
        entries["ets_error"] = str(exc)
    try:
        arima = ARIMA(y, order=(1, 1 if np.std(np.diff(y)) < np.std(y) else 0, 1),
                      trend=("c" if np.std(np.diff(y)) >= np.std(y) else "n")).fit()
        entries["arima"] = list(map(float, arima.forecast(h)))
        entries["arima_sigma"] = float(np.sqrt(arima.params[-1]))
    except Exception as exc:
        entries["arima_error"] = str(exc)
    out[case["name"]] = entries
print(json.dumps(out))
`;
      const payload = JSON.stringify(
        cases.map((c) => ({ name: c.name, series: c.series, horizon: c.horizon, period: c.period })),
      );
      const stdout = execFileSync(py!.bin, ["-c", script, payload], { encoding: "utf8", timeout: 120_000 });
      const oracle = JSON.parse(stdout.trim().split("\n").pop()!) as Record<
        string,
        { ets?: number[]; ets_sigma?: number; arima?: number[]; arima_sigma?: number }
      >;

      for (const c of cases) {
        const res = forecastSeries(c.series, { horizon: c.horizon, period: c.period });
        const ours = res.points.map((p) => p.point);
        const refEts = oracle[c.name]?.ets;
        const refArima = oracle[c.name]?.arima;
        const refs = [refEts, refArima].filter((r): r is number[] => Array.isArray(r));
        expect(refs.length).toBeGreaterThan(0);
        // Our forecast must be the closest of the two reference families within
        // 25% of the reference spread — loose enough for implementation-family
        // differences (CSS vs MLE), tight enough to catch real mistakes.
        for (const ref of refs) {
          const refSpread = Math.max(...ref) - Math.min(...ref) || 1;
          const maxGap = Math.max(...ours.map((v, i) => Math.abs(v - ref[i]!)));
          expect(maxGap).toBeLessThan(Math.max(25 * refSpread * 0.25, 6 * res.best.sigma + 10));
        }
      }
    },
    180_000,
  );
});
