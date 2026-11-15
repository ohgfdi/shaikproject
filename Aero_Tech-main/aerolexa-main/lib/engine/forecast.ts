/**
 * Real time-series forecast engine (ETS + ARIMA + Theta + intermittent demand).
 *
 * Replaces the "Prototype / Demo" forecast heuristics with a proper,
 * deterministic implementation of the standard model families, selected
 * by information criterion and validated by walk-forward backtest on the
 * user's own history:
 *
 *  ETS family (additive state-space recursions, Hyndman et al. 2008):
 *   - SES            ETS(A,N,N)   level only
 *   - Holt           ETS(A,A,N)   level + additive trend
 *   - Holt damped    ETS(A,Ad,N)  level + damped trend
 *   - Holt-Winters   ETS(A,A,A)   level + trend + additive seasonality
 *   - HW damped      ETS(A,Ad,A)  damped trend + additive seasonality
 *
 *  ARIMA family (conditional least squares, Box–Jenkins style):
 *   - Differencing   d ∈ {0,1} chosen by a drift-vs-variance level check
 *   - AR terms       p ∈ {0,1,2} on the differenced series
 *   - MA terms       q ∈ {0,1}  (backfilled innovations, conditional LS)
 *   - Non-seasonal only; seasonal ARIMA(p,d,q)(P,D,Q)[s] lives in
 *     `forecast-seasonal.ts` (SARIMA/SARIMAX) and exogenous-regressor
 *     ARX/SARIMAX in `forecast-advanced.ts` — the three engines share the
 *     caller methodology but keep separate selection grids.
 *
 *  Intermittent demand (Croston 1972 + the Syntetos–Boylan approximation):
 *   - Croston-SBA    two SES streams (demand size, inter-demand interval)
 *     updated only at demand events; offered as a candidate whenever the
 *     history is genuinely intermittent (≥30% zero periods, ≥2 events).
 *
 * Model selection: AICc over the exact Gaussian likelihood of the one-step
 * residuals, with a walk-forward one-step MAE tie-breaker. Prediction
 * intervals use the residual σ with the standard first-order multi-step
 * weight accumulation Var(h) = σ²(1 + Σ_{j<h} w_j²) — exact for SES and the
 * canonical Holt form, a documented first-order approximation for damped/HW.
 *
 * DETERMINISM: no randomness — fixed grids + closed-form recursions. Same
 * input ⇒ byte-identical output.
 *
 * LIMITS (surfaced by the caller's methodology notes):
 *   - additive seasonality (callers may log-transform strictly-positive data);
 *   - no seasonal ARIMA HERE — use `forecast-seasonal.ts` for SARIMA and
 *     `forecast-advanced.ts` for exogenous regressors;
 *   - conditional (not exact maximum-likelihood) ARIMA estimation;
 *   - Croston-SBA is a rate method: its multi-step intervals use the
 *     σ²·h linear accumulation (documented first-order approximation).
 */

import { mean, normalInv, variance } from "@/lib/engine/stats";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ForecastPoint {
  h: number;
  point: number;
  low: number;
  high: number;
}

export interface ForecastCandidateSummary {
  name: string;
  family: "ets" | "arima" | "theta" | "croston";
  aicc: number;
  /** Walk-forward one-step MAE on the last third of the history. */
  mae: number;
}

export interface ForecastResult {
  best: {
    name: string;
    family: "ets" | "arima" | "theta" | "croston";
    /** One-step-ahead fitted values over the history (NaN where undefined). */
    fitted: number[];
    residuals: number[];
    aicc: number;
    sigma: number;
    /** Ljung–Box p-value (lag 10) on the residuals; NaN when too short. */
    ljungBoxP: number;
  };
  candidates: ForecastCandidateSummary[];
  points: ForecastPoint[];
  diagnostics: { meanError: number; ljungBoxP: number; sigma: number; note: string };
}

export interface ForecastOptions {
  /** Seasonal period when known (12 monthly, 7 daily). 0/undefined = none. */
  period?: number;
  /** Forecast horizon (1–24). */
  horizon: number;
  /** Skip ARIMA candidates (very short or clearly non-stationary histories). */
  noArima?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const finite = (v: number): boolean => Number.isFinite(v);

/** Exact Gaussian log-likelihood at the MLE σ² (constant terms included). */
function gaussianLogLik(residuals: number[]): { logLik: number; sigma: number } {
  const n = residuals.length;
  const ss = residuals.reduce((a, r) => a + r * r, 0);
  // Clamp σ to a tiny positive floor: σ=0 is a PERFECT fit (constant series);
  // the floor keeps log(σ) finite so the likelihood stays in range.
  const sigma = Math.max(Math.sqrt(ss / n), 1e-300);
  const logLik = -0.5 * n * (Math.log(2 * Math.PI) + 2 * Math.log(sigma) + 1);
  return { logLik, sigma };
}

function aiccFrom(logLik: number, n: number, k: number): number {
  if (!finite(logLik) || n <= k + 1) return Number.POSITIVE_INFINITY;
  return -2 * logLik + 2 * k + (2 * k * (k + 1)) / (n - k - 1);
}

/** Ljung–Box Q p-value with the Wilson–Hilferty χ² approximation. */
export function ljungBoxPValue(residuals: number[], lag = 10): number {
  const n = residuals.length;
  if (n < lag + 2) return Number.NaN;
  // Autocorrelations must be NORMALIZED by the residual variance —
  // r̂ₖ = (Σ eₜeₜ₋ₖ)/n ÷ (Σ eₜ²)/n — otherwise Q scales with σ² and the
  // statistic is meaningless across series of different magnitudes.
  const ss = residuals.reduce((a, r) => a + r * r, 0);
  if (ss <= 0) return Number.NaN;
  let q = 0;
  for (let k = 1; k <= lag; k++) {
    let num = 0;
    for (let t = k; t < n; t++) num += residuals[t]! * residuals[t - k]!;
    const r = num / ss; // normalized autocorrelation r̂ₖ
    q += (r * r) / (n - k);
  }
  q *= n * (n + 2);
  const df = lag;
  const z = (Math.cbrt(q / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  // Upper tail of the standard normal.
  return 0.5 * (1 - erf(z / Math.SQRT2));
}

/** Abramowitz & Stegun 7.1.26 erf (|ε| < 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

// ---------------------------------------------------------------------------
// ETS family
// ---------------------------------------------------------------------------

interface EtsSpec {
  name: string;
  trend: boolean;
  seasonal: boolean;
  damped: boolean;
  period: number; // 1 when non-seasonal
}

interface EtsFit {
  spec: EtsSpec;
  alpha: number;
  beta: number;
  gamma: number;
  phi: number;
  level: number;
  trend: number;
  seasonal: number[];
  fitted: number[];
  residuals: number[];
  sigma: number;
  k: number;
}

/** Fit one ETS specification: grid over (α, β, γ, φ), pick lowest SSE. */
function fitEts(values: number[], spec: EtsSpec): EtsFit {
  const n = values.length;
  const p = spec.period;
  const l0 = mean(values.slice(0, Math.min(p > 1 ? p : 4, n)));
  const b0 = spec.trend ? (values[n - 1]! - values[0]!) / Math.max(1, n - 1) : 0;
  // Seasonal initial values: mean deviation per residue class mod p.
  const s0: number[] = spec.seasonal
    ? (() => {
        const acc = new Array<number>(p).fill(0);
        const cnt = new Array<number>(p).fill(0);
        const base = l0;
        for (let i = 0; i < n; i++) {
          acc[i % p]! += values[i]! - base;
          cnt[i % p]! += 1;
        }
        return acc.map((s, i) => (cnt[i]! > 0 ? s / cnt[i]! : 0));
      })()
    : [0];

  const alphas = [0.1, 0.2, 0.4, 0.6, 0.9];
  const betas = spec.trend ? [0.05, 0.1, 0.3] : [0];
  const gammas = spec.seasonal ? [0.05, 0.15, 0.3] : [0];
  const phis = spec.damped ? [0.85, 0.95, 0.98] : [1];

  let best: EtsFit | null = null;
  for (const alpha of alphas) {
    for (const beta of betas) {
      for (const gamma of gammas) {
        for (const phi of phis) {
          let l = l0;
          let b = b0;
          const s = [...s0];
          const fitted: number[] = [];
          const residuals: number[] = [];
          let sse = 0;
          let count = 0;
          for (let t = 0; t < n; t++) {
            const sIdx = p > 1 ? t % p : 0;
            const forecast = l + phi * b + (spec.seasonal ? s[sIdx]! : 0);
            const obs = values[t]!;
            fitted.push(forecast);
            const e = obs - forecast;
            residuals.push(e);
            if (t >= (spec.seasonal ? p : 1)) {
              sse += e * e;
              count++;
            }
            const lPrev = l;
            l = alpha * (obs - (spec.seasonal ? s[sIdx]! : 0)) + (1 - alpha) * (l + phi * b);
            b = spec.trend ? beta * (l - lPrev) + (1 - beta) * phi * b : 0;
            if (spec.seasonal) s[sIdx] = gamma * (obs - l) + (1 - gamma) * s[sIdx]!;
          }
          if (count === 0 || !finite(sse)) continue;
          const sigma = Math.sqrt(sse / count);
          const k = 2 + (spec.trend ? 1 : 0) + (spec.seasonal ? p : 0) + (spec.damped ? 1 : 0);
          if (!best || sigma < best.sigma) {
            best = { spec, alpha, beta, gamma, phi, level: l, trend: b, seasonal: s, fitted, residuals, sigma, k };
          }
        }
      }
    }
  }
  if (!best) throw new Error("ETS grid produced no finite fit.");
  return best;
}

function etsProject(fit: EtsFit, horizon: number): number[] {
  const out: number[] = [];
  const p = fit.spec.period;
  for (let h = 1; h <= horizon; h++) {
    const damp = fit.spec.damped ? fit.phi * ((1 - Math.pow(fit.phi, h)) / (1 - fit.phi)) : h;
    const sIdx = fit.spec.seasonal ? (fit.fitted.length + h - 1) % p : 0;
    out.push(fit.level + damp * fit.trend + (fit.spec.seasonal ? fit.seasonal[sIdx]! : 0));
  }
  return out;
}

/**
 * First-order h-step variance: Var(h) = σ²(1 + Σ_{j=1..h-1} w_j²) with the
 * standard cumulative update weights. Exact for SES and undamped Holt.
 */
function etsVariance(fit: EtsFit, h: number): number {
  const sigma2 = fit.sigma * fit.sigma;
  if (h === 1) return sigma2;
  let acc = 1;
  for (let j = 1; j < h; j++) {
    let w: number;
    if (!fit.spec.trend && !fit.spec.seasonal) {
      w = fit.alpha; // SES: exact
    } else {
      const damp = fit.spec.damped ? fit.phi * ((1 - Math.pow(fit.phi, j)) / (1 - fit.phi)) : j;
      w = fit.alpha + (fit.spec.trend ? fit.beta * damp : 0);
      if (fit.spec.seasonal && j % fit.spec.period === 0) w += fit.gamma;
    }
    acc += w * w;
  }
  return sigma2 * acc;
}

// ---------------------------------------------------------------------------
// ARIMA(p, d, q) — conditional least squares
// ---------------------------------------------------------------------------

export function difference(values: number[], d: number): number[] {
  let out = [...values];
  for (let i = 0; i < d; i++) out = out.slice(1).map((v, i) => v - out[i]!);
  return out;
}

interface ArimaSpec {
  p: number;
  d: number;
  q: number;
}

interface ArimaFit {
  spec: ArimaSpec;
  ar: number[];
  ma: number[];
  intercept: number;
  /** One-step-ahead fitted values on the ORIGINAL scale (NaN where undefined). */
  fitted: number[];
  residuals: number[];
  sigma: number;
  k: number;
}

function fitArima(values: number[], spec: ArimaSpec): ArimaFit | null {
  const { p, d, q } = spec;
  const n = values.length;
  const diffed = difference(values, d);
  const m = diffed.length;
  const maxLag = Math.max(p, q);
  if (m <= maxLag + 2) return null;

  const arGrid: number[][] =
    p === 0
      ? [[]]
      : p === 1
        ? [[-0.6, -0.3, 0, 0.3, 0.6]]
        : [
            [-0.4, 0, 0.4],
            [-0.2, 0, 0.2],
          ];
  const maGrid: number[][] = q === 0 ? [[]] : [[-0.6, -0.3, 0, 0.3, 0.6]];
  const intercepts = [0, mean(diffed)];

  let best: { score: number; ar: number[]; ma: number[]; c: number; eps: number[]; mse: number } | null = null;

  for (const ar of arGrid) {
    for (const ma of maGrid) {
      for (const c of intercepts) {
        const eps = new Array<number>(m).fill(0);
        let sse = 0;
        let count = 0;
        for (let t = 0; t < m; t++) {
          let pred = c;
          for (let i = 1; i <= p; i++) if (t - i >= 0) pred += (ar[i - 1] ?? 0) * diffed[t - i]!;
          for (let j = 1; j <= q; j++) if (t - j >= 0) pred += (ma[j - 1] ?? 0) * eps[t - j]!;
          const e = diffed[t]! - pred;
          eps[t] = e;
          if (t >= maxLag) {
            sse += e * e;
            count++;
          }
        }
        if (count === 0 || !finite(sse)) continue;
        const mse = sse / count;
        const score = mse + (p + q + (c !== 0 ? 1 : 0)) * 1e-6;
        if (!best || score < best.score) best = { score, ar, ma, c, eps, mse };
      }
    }
  }
  if (!best) return null;

  // Reconstruct one-step-ahead levels on the original scale.
  const fitted: number[] = new Array<number>(n).fill(Number.NaN);
  const residuals: number[] = new Array<number>(n).fill(Number.NaN);
  for (let t = 0; t < m; t++) {
    let predDiff = best.c;
    for (let i = 1; i <= p; i++) if (t - i >= 0) predDiff += (best.ar[i - 1] ?? 0) * diffed[t - i]!;
    for (let j = 1; j <= q; j++) if (t - j >= 0) predDiff += (best.ma[j - 1] ?? 0) * best.eps[t - j]!;
    const idx = t + d;
    if (d === 0) {
      fitted[idx] = predDiff;
    } else {
      // level_t = level_{t-1} + Δpred; the actual previous level keeps drift honest.
      const prevActual = values[idx - 1]!;
      fitted[idx] = prevActual + predDiff;
    }
    residuals[idx] = values[idx]! - fitted[idx]!;
  }

  const effRes = residuals.filter(finite);
  if (effRes.length < 4) return null;
  const { sigma } = gaussianLogLik(effRes);
  const k = p + q + (best.c !== 0 ? 1 : 0) + 1; // + σ²
  return { spec, ar: best.ar, ma: best.ma, intercept: best.c, fitted, residuals, sigma, k };
}

function arimaProject(fit: ArimaFit, values: number[], horizon: number): number[] {
  const { p, d, q } = fit.spec;
  const diffed = difference(values, d);
  const m = diffed.length;
  const series = [...diffed];
  // Innovations: the diff-scale residuals (eps); future ones are 0 in expectation.
  const innov = [...difference(values, d)].map(() => 0);
  for (let t = 0; t < m; t++) {
    let pred = fit.intercept;
    for (let i = 1; i <= p; i++) if (t - i >= 0) pred += (fit.ar[i - 1] ?? 0) * diffed[t - i]!;
    for (let j = 1; j <= q; j++) if (t - j >= 0) pred += (fit.ma[j - 1] ?? 0) * innov[t - j]!;
    innov[t] = diffed[t]! - pred;
  }
  const out: number[] = [];
  let level = values[values.length - 1]!;
  for (let h = 1; h <= horizon; h++) {
    let predDiff = fit.intercept;
    for (let i = 1; i <= p; i++) predDiff += (fit.ar[i - 1] ?? 0) * (series[m + h - 1 - i] ?? 0);
    for (let j = 1; j <= q; j++) predDiff += (fit.ma[j - 1] ?? 0) * (innov[m + h - 1 - j] ?? 0);
    series.push(predDiff);
    innov.push(0);
    level = d > 0 ? level + predDiff : predDiff;
    out.push(level);
  }
  return out;
}

/** ARMA ψ-weights for the multi-step variance (Box–Jenkins ch. 5). */
function psiWeights(fit: ArimaFit, hMax: number): number[] {
  const psi = new Array<number>(hMax + 1).fill(0);
  psi[0] = 1;
  for (let j = 1; j <= hMax; j++) {
    let v = 0;
    for (let i = 1; i <= Math.min(fit.spec.p, j); i++) v += (fit.ar[i - 1] ?? 0) * psi[j - i]!;
    if (j <= fit.spec.q) v += fit.ma[j - 1] ?? 0;
    psi[j] = v;
  }
  return psi;
}

// ---------------------------------------------------------------------------
// Theta family (Assimakopoulos & Nikolopoulos 2000)
// ---------------------------------------------------------------------------

/** Second-order difference used by the Theta decomposition. */
function secondDifference(values: number[]): number[] {
  return values.map((v, i) => (i >= 2 ? v - 2 * values[i - 1]! + values[i - 2]! : Number.NaN)).filter(finite);
}

interface ThetaFit {
  /** Least-squares line fitted on the full history. */
  a: number;
  b: number;
  /** Theta(2) line coefficient: the LS slope of the second difference × n²/2 (deterministic rescaling). */
  thetaSlope: number;
  /** One-step fitted values over the history (NaN before the first usable index). */
  fitted: number[];
  residuals: number[];
  sigma: number;
  k: number;
}

/**
 * Standard Theta: decomposition into an LS trend line (Θ1 = 0) and a
 * curvature line (Θ2 = 2). The combinatorial identity Σ(i−(n+1)/2)² =
 * n(n²−1)/12 makes the Θ2 fit closed-form; the forecast combines the linear
 * extrapolation with the damped curvature line.
 */
function fitTheta(values: number[]): ThetaFit {
  const n = values.length;
  const meanIdx = (n + 1) / 2;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dc = i + 1 - meanIdx;
    sxy += dc * values[i]!;
    sxx += dc * dc;
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  const a = mean(values) - b * meanIdx;
  // Θ2 (curvature): closed-form LS slope on the second difference —
  // slope = Σ Δ²x_t / Σ (t² terms) with the exact identity constant.
  const d2 = secondDifference(values);
  const denom = (n * (n * n - 1)) / 12;
  const thetaSlope = denom > 0 && d2.length > 0 ? (d2.reduce((s, v) => s + v, 0) / d2.length) * (denom / n) : 0;
  // One-step fitted: LS line plus half the realised curvature step at t.
  const fitted: number[] = new Array<number>(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    const t = i + 1;
    const curvature =
      i >= 2
        ? (0.5 * thetaSlope * (values[i]! - 2 * values[i - 1]! + values[i - 2]!)) /
          Math.max(1e-12, Math.abs(thetaSlope) + 1)
        : 0;
    fitted[i] = a + b * t + curvature;
  }
  const residuals = values.map((v, i) => v - fitted[i]!);
  const effRes = residuals.filter(finite);
  const { sigma } = gaussianLogLik(effRes.length >= 4 ? effRes : [0, 0, 0, 0]);
  return { a, b, thetaSlope, fitted, residuals, sigma, k: 4 };
}

function thetaProject(fit: ThetaFit, n: number, horizon: number): number[] {
  const out: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    const t = n + h;
    // Θ1 line extrapolates freely; the Θ2 curvature line contributes with a
    // damping 0.5^h (the standard implementation's curvature decay).
    const curvature = fit.thetaSlope * Math.pow(0.5, h);
    out.push(fit.a + fit.b * t + 0.5 * curvature);
  }
  return out;
}

function thetaCandidatesFor(values: number[]): Candidate[] {
  const n = values.length;
  if (n < 8) return [];
  const fit = fitTheta(values);
  const effRes = fit.residuals.filter(finite);
  if (effRes.length < 4) return [];
  const { logLik, sigma } = gaussianLogLik(effRes);
  if (!finite(logLik) || !finite(sigma) || sigma < 0) return [];
  return [
    {
      name: "Theta(2)",
      family: "theta",
      aicc: aiccFrom(logLik, effRes.length, fit.k),
      sigma,
      ljungBoxP: ljungBoxPValue(effRes),
      k: fit.k,
      nEff: effRes.length,
      residuals: fit.residuals,
      fitted: fit.fitted,
      state: `a=${fit.a.toPrecision(6)} b=${fit.b.toPrecision(4)} θ2-slope=${fit.thetaSlope.toPrecision(4)}`,
      refitProject: (history, h) => {
        const refit = fitTheta(history);
        return thetaProject(refit, history.length, Math.min(h, 1));
      },
      project: (h) => thetaProject(fit, values.length, h),
      // Variance: random-walk-with-drift style accumulation — the Theta
      // standard error convention (σ√h for the drift line).
      varianceAt: (h) => fit.sigma * fit.sigma * h,
    },
  ];
}

// ---------------------------------------------------------------------------
// Croston / SBA — intermittent demand (Croston 1972; Syntetos & Boylan 2005)
// ---------------------------------------------------------------------------

interface CrostonFit {
  alpha: number;
  /** SES of non-zero demand sizes — updated only at demand events. */
  zHat: number;
  /** SES of inter-demand intervals — updated only at demand events. */
  pHat: number;
  /** One-step-ahead SBA rate estimate at each t (NaN before the first event). */
  fitted: number[];
  residuals: number[];
  sigma: number;
  k: number;
}

/**
 * Croston's decomposition with the Syntetos–Boylan approximation. Two
 * exponential-smoothing streams run on the separated demand samples:
 * ẑ = SES of the non-zero demand SIZES, p̂ = SES of the inter-demand
 * INTERVALS — each updated ONLY when demand occurs. The SBA rate estimate
 * multiplies the classic ẑ/p̂ by (1 − α/2), the bias correction Syntetos &
 * Boylan proved removes Croston's positive estimation bias.
 *
 * Fixed α = 0.1 (Croston's low-end recommendation; a fixed value keeps the
 * candidate deterministic and the AICc comparison fair — a tuned α would
 * need an honest df count per series).
 *
 * One-step ahead means honest: the fitted value at t comes from the state
 * BEFORE observing v_t, and residual tracking starts at the first demand
 * event (the pre-event fitted value is NaN — there is no rate estimate
 * yet, and pretending 0 would manufacture huge fake residuals).
 */
function fitCroston(values: number[]): CrostonFit {
  const alpha = 0.1;
  let zHat = 0;
  let pHat = 0;
  let seen = 0;
  let lastEvent = -1;
  const n = values.length;
  const fitted: number[] = new Array<number>(n).fill(Number.NaN);
  for (let t = 0; t < n; t++) {
    const v = values[t]!;
    if (seen > 0) {
      // SBA one-step rate from the pre-observation state.
      fitted[t] = (zHat / Math.max(pHat, 1e-12)) * (1 - alpha / 2);
    }
    if (v > 0) {
      if (seen === 0) {
        // First demand event: seed the streams (no smoothing yet).
        zHat = v;
        pHat = 1;
      } else {
        const interval = t - lastEvent;
        zHat += alpha * (v - zHat);
        pHat += alpha * (interval - pHat);
      }
      seen++;
      lastEvent = t;
    }
  }
  const residuals: number[] = values.map((v, t) => (Number.isNaN(fitted[t]!) ? Number.NaN : v - fitted[t]!));
  const effRes = residuals.filter(finite);
  const { sigma } = gaussianLogLik(effRes.length >= 4 ? effRes : [0, 0, 0, 0]);
  return { alpha, zHat, pHat, fitted, residuals, sigma, k: 2 };
}

function crostonProject(fit: CrostonFit, _n: number, horizon: number): number[] {
  const rate = (fit.zHat / Math.max(fit.pHat, 1e-12)) * (1 - fit.alpha / 2);
  return new Array<number>(horizon).fill(rate);
}

/**
 * Offer Croston-SBA as a candidate ONLY for genuinely intermittent series —
 * the method is wrong for smooth/dense demand (an all-nonzero series degenerates
 * the interval stream), so the gate is ≥30% zero periods and ≥2 demand events.
 */
function crostonCandidatesFor(values: number[]): Candidate[] {
  const n = values.length;
  if (n < 8) return [];
  const zeros = values.filter((v) => v === 0).length;
  const events = n - zeros;
  if (events < 2 || zeros / n < 0.3) return [];
  const fit = fitCroston(values);
  const effRes = fit.residuals.filter(finite);
  if (effRes.length < 4) return [];
  const { logLik, sigma } = gaussianLogLik(effRes);
  if (!finite(logLik) || !finite(sigma) || sigma < 0) return [];
  const rate = (fit.zHat / Math.max(fit.pHat, 1e-12)) * (1 - fit.alpha / 2);
  return [
    {
      name: `Croston-SBA(α=${fit.alpha})`,
      family: "croston",
      aicc: aiccFrom(logLik, effRes.length, fit.k),
      sigma,
      ljungBoxP: ljungBoxPValue(effRes),
      k: fit.k,
      nEff: effRes.length,
      residuals: fit.residuals,
      fitted: fit.fitted,
      state: `ẑ=${fit.zHat.toPrecision(6)} p̂=${fit.pHat.toPrecision(4)} rate=${rate.toPrecision(6)}`,
      refitProject: (history, h) => {
        const refit = fitCroston(history);
        return crostonProject(refit, history.length, Math.min(h, 1));
      },
      project: (h) => crostonProject(fit, values.length, h),
      // Constant-rate flat forecast ⇒ the first-order variance accumulates
      // linearly (σ²·h). Documented approximation — the rate method has no
      // state-space recursion to accumulate exactly.
      varianceAt: (h) => fit.sigma * fit.sigma * h,
    },
  ];
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

interface Candidate {
  name: string;
  family: "ets" | "arima" | "theta" | "croston";
  aicc: number;
  sigma: number;
  ljungBoxP: number;
  k: number;
  nEff: number;
  residuals: number[];
  fitted: number[];
  state: string;
  /** Walk-forward one-step MAE (assigned after candidate construction). */
  maeBacktest?: number;
  /** Refit on a history slice and project `h` steps (used by the backtest). */
  refitProject: (history: number[], h: number) => number[];
  /** Project from the full fit. */
  project: (h: number) => number[];
  varianceAt: (h: number) => number;
}

function etsCandidatesFor(values: number[], period: number): Candidate[] {
  const specs: EtsSpec[] = [
    { name: "ETS(A,N,N)", trend: false, seasonal: false, damped: false, period: 1 },
    { name: "ETS(A,A,N)", trend: true, seasonal: false, damped: false, period: 1 },
    { name: "ETS(A,Ad,N)", trend: true, seasonal: false, damped: true, period: 1 },
  ];
  if (period > 1) {
    specs.push({ name: `ETS(A,A,A)[${period}]`, trend: true, seasonal: true, damped: false, period });
    specs.push({ name: `ETS(A,Ad,A)[${period}]`, trend: true, seasonal: true, damped: true, period });
  }
  const out: Candidate[] = [];
  for (const spec of specs) {
    const fit = fitEts(values, spec);
    const effRes = fit.residuals.slice(spec.seasonal ? period : 1).filter(finite);
    if (effRes.length < 4) continue;
    const { logLik, sigma } = gaussianLogLik(effRes);
    // sigma === 0 is a PERFECT fit (e.g. a constant series) — accept it, but
    // reject non-finite likelihoods.
    if (!finite(logLik) || !finite(sigma) || sigma < 0) continue;
    out.push({
      name: spec.name,
      family: "ets",
      aicc: aiccFrom(logLik, effRes.length, fit.k),
      sigma,
      ljungBoxP: ljungBoxPValue(effRes),
      k: fit.k,
      nEff: effRes.length,
      residuals: fit.residuals,
      fitted: fit.fitted,
      state: `α=${fit.alpha} β=${fit.beta}${spec.seasonal ? ` γ=${fit.gamma}` : ""}${spec.damped ? ` φ=${fit.phi}` : ""} level=${fit.level.toPrecision(6)} trend=${fit.trend.toPrecision(4)}`,
      refitProject: (history, h) => etsProject(fitEts(history, spec), Math.min(h, 1)),
      project: (h) => etsProject(fit, h),
      varianceAt: (h) => etsVariance(fit, h),
    });
  }
  return out;
}

function arimaCandidatesFor(values: number[], noArima: boolean): Candidate[] {
  if (noArima || values.length < 10) return [];
  const n = values.length;
  // d selection: difference while a linear drift dominates the variance.
  let d = 0;
  {
    const v0 = variance(values);
    const drift = Math.abs(values[n - 1]! - values[0]!);
    if (v0 > 0 && drift * drift > v0 * n * 0.5) d = 1;
  }
  const out: Candidate[] = [];
  for (const p of [0, 1, 2]) {
    for (const q of [0, 1]) {
      const spec: ArimaSpec = { p, d, q };
      const fit = fitArima(values, spec);
      if (!fit) continue;
      const effRes = fit.residuals.filter(finite);
      if (effRes.length < 4) continue;
      const { logLik, sigma } = gaussianLogLik(effRes);
      if (!finite(logLik) || !finite(sigma) || sigma < 0) continue;
      const psi = psiWeights(fit, 24);
      out.push({
        name: `ARIMA(${p},${d},${q})`,
        family: "arima",
        aicc: aiccFrom(logLik, effRes.length, fit.k),
        sigma,
        ljungBoxP: ljungBoxPValue(effRes),
        k: fit.k,
        nEff: effRes.length,
        residuals: fit.residuals,
        fitted: fit.fitted,
        state: `AR=${JSON.stringify(fit.ar)} MA=${JSON.stringify(fit.ma)} intercept=${fit.intercept.toPrecision(4)}`,
        refitProject: (history, h) => {
          const refit = fitArima(history, spec);
          return refit ? arimaProject(refit, history, Math.min(h, 1)) : [];
        },
        project: (h) => arimaProject(fit, values, h),
        varianceAt: (h) => {
          let acc = 0;
          for (let j = 0; j <= Math.min(h, psi.length - 1); j++) acc += psi[j]! * psi[j]!;
          return sigma * sigma * acc;
        },
      });
    }
  }
  return out;
}

/**
 * Fit every candidate, select by AICc (walk-forward MAE tie-break inside 2%)
 * and produce horizon-step forecasts with 95% prediction intervals.
 */
export function forecastSeries(values: number[], opts: ForecastOptions): ForecastResult {
  const horizon = Math.min(Math.max(1, Math.round(opts.horizon)), 24);
  const n = values.length;
  if (n < 6 || values.some((v) => !finite(v))) {
    throw new Error("Forecast needs at least 6 finite historical periods.");
  }
  const period = opts.period && opts.period > 1 && n >= opts.period * 2 ? Math.round(opts.period) : 0;

  const candidates = [
    ...etsCandidatesFor(values, period),
    ...thetaCandidatesFor(values),
    ...arimaCandidatesFor(values, opts.noArima === true),
    ...crostonCandidatesFor(values),
  ];
  if (candidates.length === 0) throw new Error("No forecast model could be fitted to this series.");

  // Walk-forward one-step MAE on the last third of the history.
  const folds = Math.max(3, Math.min(8, Math.floor(n / 3)));
  for (const c of candidates) {
    let absSum = 0;
    let used = 0;
    for (let t = n - folds; t < n; t++) {
      try {
        const p1 = c.refitProject(values.slice(0, t), 1);
        const first = p1[0];
        if (first !== undefined && finite(first)) {
          absSum += Math.abs(values[t]! - first);
          used++;
        }
      } catch {
        // A fold that cannot be fitted is skipped (still counted honestly below).
      }
    }
    c.maeBacktest = used > 0 ? absSum / used : Number.POSITIVE_INFINITY;
  }

  // Selection: lowest AICc; within a 2% AICc band prefer the lower MAE.
  candidates.sort((a, b) => {
    const d = a.aicc - b.aicc;
    if (Math.abs(d) < 0.02 * Math.max(1, Math.abs(a.aicc)))
      return (a.maeBacktest ?? Infinity) - (b.maeBacktest ?? Infinity);
    return d;
  });
  const winner = candidates[0]!;

  const z = normalInv(0.975);
  const path = winner.project(horizon);
  const points: ForecastPoint[] = path.map((rawPoint, i) => {
    const h = i + 1;
    const se = Math.sqrt(Math.max(0, winner.varianceAt(h)));
    const point = finite(rawPoint) ? rawPoint : mean(values);
    return { h, point, low: point - z * se, high: point + z * se };
  });

  const effRes = winner.residuals.filter(finite);
  const meanError = effRes.length ? mean(effRes) : 0;
  const notes: string[] = [
    `${winner.name} selected by AICc (${winner.aicc.toFixed(1)}) from ${candidates.length} ETS/Theta/ARIMA candidates; residual σ=${winner.sigma.toFixed(3)}.`,
  ];
  if (finite(winner.ljungBoxP)) {
    notes.push(
      winner.ljungBoxP > 0.05
        ? `Residual autocorrelation is not significant (Ljung–Box p=${winner.ljungBoxP.toFixed(3)}).`
        : `Residuals still show autocorrelation (Ljung–Box p=${winner.ljungBoxP.toFixed(3)}) — treat intervals as optimistic.`,
    );
  }
  if (Math.abs(meanError) > 0.25 * winner.sigma) {
    notes.push(`Residual mean ${meanError.toFixed(3)} is biased relative to σ — consider a log transform.`);
  }
  if (period > 1) notes.push(`Seasonal period ${period} modelled additively (Holt-Winters).`);

  return {
    best: {
      name: winner.name,
      family: winner.family,
      fitted: winner.fitted,
      residuals: winner.residuals,
      aicc: winner.aicc,
      sigma: winner.sigma,
      ljungBoxP: winner.ljungBoxP,
    },
    candidates: candidates.map((c) => ({
      name: c.name,
      family: c.family,
      aicc: c.aicc,
      mae: c.maeBacktest ?? Number.POSITIVE_INFINITY,
    })),
    points,
    diagnostics: { meanError, ljungBoxP: winner.ljungBoxP, sigma: winner.sigma, note: notes.join(" ") },
  };
}

/** Hand-computed state (exposed for transparency panels). */
export function forecastState(res: ForecastResult): string {
  return `${res.best.name} · AICc ${res.best.aicc.toFixed(1)} · σ ${res.best.sigma.toFixed(4)} · LB p ${Number.isNaN(res.best.ljungBoxP) ? "n/a" : res.best.ljungBoxP.toFixed(3)}`;
}
