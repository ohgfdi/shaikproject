/**
 * Seasonal time series: SARIMA / SARIMAX by conditional least squares.
 *
 * The existing forecast engine (lib/engine/forecast.ts) covers ETS, Theta and
 * non-seasonal ARIMA. This module fills the seasonal gap the audit called out:
 *
 *   - A grid of (p, d, q) x (P, D, Q) candidates over the differenced series,
 *     fit by conditional least squares (MA terms use residuals initialised at
 *     zero — the standard CLS conditioning), selected by AICc.
 *   - Optional exogenous regressors (SARIMAX) entering the same regression.
 *   - Expanding-window rolling-origin cross-validation: each fold re-fits on
 *     all data strictly before the fold and forecasts ONE step ahead, so the
 *     reported error is genuinely out-of-sample and never leaks.
 *
 * Oracle-checked against statsmodels SARIMAX in
 * __tests__/unit/sarima-oracle.test.ts for the ARMA cases (d=D=0).
 */

import { difference, ljungBoxPValue } from "@/lib/engine/forecast";

export class SarimaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SarimaError";
  }
}

export interface SarimaCandidate {
  name: string;
  p: number;
  d: number;
  q: number;
  P: number;
  D: number;
  Q: number;
  s: number;
  aicc: number;
  sigma: number;
  cvMae: number | null;
  coefficients: number[];
  terms: string[];
}

export interface SarimaPoint {
  h: number;
  point: number;
  low: number;
  high: number;
}

export interface SarimaFit {
  best: SarimaCandidate;
  candidates: SarimaCandidate[];
  fitted: number[];
  residuals: number[];
  points: SarimaPoint[];
  diagnostics: {
    meanError: number;
    sigma: number;
    ljungBoxP: number;
    note: string;
  };
  cv: {
    folds: number;
    mae: number;
    mape: number | null;
    perFold: { fold: number; actual: number; predicted: number; error: number }[];
  } | null;
}

export interface SarimaOptions {
  horizon: number;
  seasonalPeriods: number;
  maxOrder: number;
  maxSeasonalOrder: number;
  /** Exogenous columns aligned 1:1 with the input series (same length). */
  exog?: number[][];
  exogNames?: string[];
  /** Expanding-window folds for out-of-sample error (0 = skip). */
  cvFolds?: number;
}

const finite = (v: number): boolean => Number.isFinite(v);

function round(v: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

interface Orders {
  p: number;
  d: number;
  q: number;
  P: number;
  D: number;
  Q: number;
}

interface CandidateFit {
  candidate: SarimaCandidate;
  fitted: number[];
  residuals: number[];
  points: SarimaPoint[];
}

/** Ordinary least squares via Gaussian elimination on the normal equations. */
function olsFit(X: number[][], y: number[]): { coefficients: number[]; residuals: number[]; sigma: number } | null {
  const n = X.length;
  const k = X[0]?.length ?? 0;
  if (n <= k) return null;
  const XtX = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const Xty = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) {
      Xty[j] = Xty[j]! + X[i]![j]! * y[i]!;
      for (let m = 0; m < k; m++) XtX[j]![m] = XtX[j]![m]! + X[i]![j]! * X[i]![m]!;
    }
  }
  for (let j = 0; j < k; j++) XtX[j]![j] = XtX[j]![j]! + 1e-8;
  const M = XtX.map((row, i) => [...row, Xty[i] as number]);
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    if (Math.abs(M[pivot]![col]!) < 1e-14) return null;
    [M[col], M[pivot]] = [M[pivot] as number[], M[col] as number[]];
    const div = M[col]![col]!;
    for (let j = col; j <= k; j++) M[col]![j] = M[col]![j]! / div;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      if (f === 0) continue;
      for (let j = col; j <= k; j++) M[r]![j] = M[r]![j]! - f * M[col]![j]!;
    }
  }
  const coefficients = M.map((r) => r[k] as number);
  const residuals: number[] = [];
  let ss = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let j = 0; j < k; j++) pred += (X[i]![j] as number) * (coefficients[j] as number);
    const e = (y[i] as number) - pred;
    residuals.push(e);
    ss += e * e;
  }
  const sigma = Math.sqrt(ss / Math.max(1, n - k));
  return { coefficients, residuals, sigma };
}

function aiccOf(n: number, k: number, rss: number): number {
  if (n <= k + 1) return Number.POSITIVE_INFINITY;
  const sigma2 = Math.max(1e-12, rss / n);
  const logLik = -0.5 * n * Math.log(2 * Math.PI * sigma2) - n / 2;
  const aic = -2 * logLik + 2 * k;
  return aic + (2 * k * (k + 1)) / (n - k - 1);
}

function differencedSeries(values: number[], d: number, D: number, s: number): number[] {
  let z = [...values];
  for (let i = 0; i < d; i++) z = difference(z, 1);
  if (s > 0) for (let i = 0; i < D; i++) z = difference(z, s);
  return z;
}

function startOf(orders: Orders, s: number): number {
  return Math.max(orders.p, orders.q, orders.P * s, orders.Q * s);
}

/** One-step prediction on the differenced scale at index t. */
function predictDiff(
  z: number[],
  resid: number[],
  t: number,
  orders: Orders,
  s: number,
  coefficients: number[],
  xreg?: number[],
): number {
  let pred = coefficients[0] as number;
  let idx = 1;
  for (let j = 1; j <= orders.p; j++) pred += (coefficients[idx++] as number) * (z[t - j] as number);
  for (let j = 1; j <= orders.P; j++) pred += (coefficients[idx++] as number) * (z[t - j * s] as number);
  for (let j = 1; j <= orders.q; j++) pred += (coefficients[idx++] as number) * (resid[t - j] as number);
  for (let j = 1; j <= orders.Q; j++) pred += (coefficients[idx++] as number) * (resid[t - j * s] as number);
  if (xreg && xreg.length > 0) {
    for (let j = 0; j < xreg.length; j++)
      pred += (coefficients[coefficients.length - xreg.length + j] as number) * (xreg[j] as number);
  }
  return pred;
}

/**
 * Fit one candidate on a series and produce in-sample fitted values plus a
 * multi-step forecast. Used both for the final fit and for every CV fold.
 */
function fitCandidate(values: number[], cfg: SarimaOptions, orders: Orders): CandidateFit | null {
  const s = cfg.seasonalPeriods > 1 ? Math.round(cfg.seasonalPeriods) : 0;
  const { d, D } = orders;
  const z = differencedSeries(values, d, D, s);
  if (z.length < 8 || !z.every(finite)) return null;
  const nOrig = values.length;
  const zOffset = nOrig - z.length;
  const exog = cfg.exog ? cfg.exog.slice(zOffset) : undefined;
  const start = startOf(orders, s);
  if (z.length - start < 6) return null;

  const terms = ["const"];
  for (let j = 1; j <= orders.p; j++) terms.push(`ar${j}`);
  for (let j = 1; j <= orders.P; j++) terms.push(`sar${j}`);
  for (let j = 1; j <= orders.q; j++) terms.push(`ma${j}`);
  for (let j = 1; j <= orders.Q; j++) terms.push(`sma${j}`);
  const xregWidth = exog?.[0]?.length ?? 0;
  for (let j = 0; j < xregWidth; j++) terms.push(`xreg${j + 1}`);

  let resid = new Array<number>(z.length).fill(0);
  let coefficients: number[] = [];
  let sigma = 0;

  for (let pass = 0; pass < 2; pass++) {
    const X: number[][] = [];
    const y: number[] = [];
    for (let t = start; t < z.length; t++) {
      const row = [1];
      for (let j = 1; j <= orders.p; j++) row.push(z[t - j] as number);
      for (let j = 1; j <= orders.P; j++) row.push(z[t - j * s] as number);
      for (let j = 1; j <= orders.q; j++) row.push(resid[t - j] as number);
      for (let j = 1; j <= orders.Q; j++) row.push(resid[t - j * s] as number);
      if (exog && exog.length > 0) {
        const xr = exog[t];
        if (!xr) return null;
        for (const v of xr) row.push(v as number);
      }
      X.push(row);
      y.push(z[t] as number);
    }
    const fit = olsFit(X, y);
    if (!fit) return null;
    coefficients = fit.coefficients;
    sigma = fit.sigma;
    const next = new Array<number>(z.length).fill(0);
    for (let t = start; t < z.length; t++) {
      next[t] = (z[t] as number) - predictDiff(z, resid, t, orders, s, coefficients, exog?.[t]);
    }
    resid = next;
  }

  let rss = 0;
  const inSample: number[] = [];
  const residualsOut: number[] = [];
  for (let t = 0; t < z.length; t++) {
    if (t < start) {
      inSample.push(Number.NaN);
      residualsOut.push(Number.NaN);
      continue;
    }
    const pred = predictDiff(z, resid, t, orders, s, coefficients, exog?.[t]);
    inSample.push(pred);
    const e = (z[t] as number) - pred;
    residualsOut.push(e);
    rss += e * e;
  }
  const k = coefficients.length;
  const aicc = aiccOf(z.length - start, k, rss);

  // Integrate the fitted path back to the original scale.
  const fittedOriginal = integrateToOriginal(values, z, inSample, orders, s);

  // Multi-step forecast on the differenced scale, then integrate.
  const horizon = Math.min(Math.max(1, cfg.horizon || 1), 24);
  const zHist = padTo(z.slice(-Math.max(start, 1)), Math.max(orders.p, orders.P * s, 1));
  const rHist = padTo(resid.slice(-Math.max(orders.q, orders.Q * s, 1)), Math.max(orders.q, orders.Q * s, 1));
  const zDiffFore: number[] = [];
  const zCopy = [...zHist];
  const rCopy = [...rHist];
  const futureExog: number[][] = [];
  if (cfg.exog && cfg.exog.length > 0 && cfg.exog[0]) {
    // Capture: TS narrowing of cfg.exog does not survive into the closure below.
    const exog = cfg.exog;
    const width = exog[0]!.length;
    const means = Array.from({ length: width }, (_, j) => {
      let acc = 0;
      for (const row of exog) acc += row[j] ?? 0;
      return acc / Math.max(1, exog.length);
    });
    for (let h = 0; h < horizon; h++) futureExog.push([...means]);
  }
  for (let h = 0; h < horizon; h++) {
    const xr = futureExog[h];
    const pred = predictDiff(zCopy, rCopy, zCopy.length, orders, s, coefficients, xr);
    zDiffFore.push(pred);
    zCopy.push(pred);
    if (zCopy.length > Math.max(orders.p, orders.P * s, 1) + horizon + 2) zCopy.shift();
    rCopy.push(0);
    if (rCopy.length > Math.max(orders.q, orders.Q * s, 1) + horizon + 2) rCopy.shift();
  }

  const points = integrateForecast(values, zDiffFore, orders, d, D, s, sigma);
  const name = `SARIMA(${orders.p},${orders.d},${orders.q})${s > 0 ? `(${orders.P},${orders.D},${orders.Q})[${s}]` : ""}${xregWidth > 0 ? "X" : ""}`;
  return {
    candidate: {
      name,
      p: orders.p,
      d: orders.d,
      q: orders.q,
      P: orders.P,
      D: orders.D,
      Q: orders.Q,
      s,
      aicc: round(aicc, 2),
      sigma: round(sigma, 4),
      // Attached by the caller after rolling-origin CV (see buildSarima) —
      // null here means "not yet measured", never zero.
      cvMae: null,
      coefficients: coefficients.map((c) => round(c)),
      terms,
    },
    fitted: fittedOriginal,
    residuals: residualsOut.map((e, i) => (i < start ? Number.NaN : round(e))),
    points,
  };
}

function padTo(arr: number[], need: number): number[] {
  const out = arr.slice(-need);
  while (out.length < need) out.unshift(out[0] ?? 0);
  return out;
}

/** Undo differencing on an in-sample path (non-seasonal then seasonal). */
function integrateToOriginal(values: number[], z: number[], zPath: number[], orders: Orders, s: number): number[] {
  const nOrig = values.length;
  const zOffset = nOrig - z.length;
  const out = new Array<number>(nOrig).fill(Number.NaN);
  // Walk the differenced path and cumulate back.
  const level: number[] = [];
  for (let t = 0; t < z.length; t++) {
    const zt = Number.isFinite(zPath[t] as number) ? (zPath[t] as number) : (z[t] as number);
    if (t === 0) {
      level.push(zOffset > 0 ? (values[zOffset] as number) : zt);
      continue;
    }
    // Reverse non-seasonal differencing: y_t = y_{t-1} + z_t (d=1 case).
    // With d=0 there is no non-seasonal cumulation.
    if (orders.d === 1) {
      level.push((level[t - 1] as number) + zt);
    } else if (orders.d === 0 && orders.D === 1 && s > 0) {
      const ref = t >= s ? (level[t - s] as number) : (values[zOffset + t - s] ?? 0);
      level.push(ref + zt);
    } else {
      level.push(zt);
    }
  }
  for (let t = 0; t < z.length; t++) out[zOffset + t] = level[t] as number;
  // Fill the pre-differencing head with the observed values.
  for (let t = 0; t < zOffset; t++) out[t] = values[t] as number;
  return out;
}

/** Integrate a differenced multi-step forecast back to the original scale. */
function integrateForecast(
  values: number[],
  diffFore: number[],
  orders: Orders,
  d: number,
  D: number,
  s: number,
  sigma: number,
): SarimaPoint[] {
  const nOrig = values.length;
  const out: SarimaPoint[] = [];
  if (d === 1) {
    let running = values[nOrig - 1] as number;
    for (let h = 0; h < diffFore.length; h++) {
      running += diffFore[h] as number;
      out.push({
        h: h + 1,
        point: round(running),
        low: round(running - 1.96 * sigma),
        high: round(running + 1.96 * sigma),
      });
    }
    return out;
  }
  if (d === 0 && D === 1 && s > 0) {
    const seasonHist = values.slice(-s).map((v) => v);
    for (let h = 0; h < diffFore.length; h++) {
      const idx = h % s;
      const ref = (seasonHist[idx] as number) + (h >= s ? 0 : 0);
      const v = ref + (diffFore[h] as number);
      seasonHist[idx] = v;
      out.push({ h: h + 1, point: round(v), low: round(v - 1.96 * sigma), high: round(v + 1.96 * sigma) });
    }
    return out;
  }
  // d = D = 0: forecasts are already on the original scale.
  const level = values[nOrig - 1] as number;
  for (let h = 0; h < diffFore.length; h++) {
    const v = level + (diffFore[h] as number);
    out.push({ h: h + 1, point: round(v), low: round(v - 1.96 * sigma), high: round(v + 1.96 * sigma) });
  }
  return out;
}

/** Expanding-window rolling-origin one-step CV for a fixed candidate. */
function rollingOriginCv(values: number[], cfg: SarimaOptions, orders: Orders): SarimaFit["cv"] {
  const folds = Math.max(0, Math.min(10, Math.round(cfg.cvFolds ?? 0)));
  if (folds <= 0) return null;
  const n = values.length;
  if (n < folds + 8) return null;
  const perFold: NonNullable<SarimaFit["cv"]>["perFold"] = [];
  let absSum = 0;
  let pctSum = 0;
  let pctCount = 0;
  for (let i = 0; i < folds; i++) {
    const cut = n - folds + i;
    const train = values.slice(0, cut);
    const actual = values[cut] as number;
    if (train.length < 8) continue;
    const sub: SarimaOptions = {
      ...cfg,
      horizon: 1,
      cvFolds: 0,
      exog: cfg.exog ? cfg.exog.slice(0, cut) : undefined,
    };
    const fit = fitCandidate(train, sub, orders);
    if (!fit) continue;
    const predicted = fit.points[0]?.point ?? Number.NaN;
    if (!Number.isFinite(predicted)) continue;
    const error = predicted - actual;
    perFold.push({ fold: i + 1, actual, predicted, error: round(error) });
    absSum += Math.abs(error);
    if (actual !== 0) {
      pctSum += (Math.abs(error) / Math.abs(actual)) * 100;
      pctCount++;
    }
  }
  if (perFold.length === 0) return null;
  return {
    folds: perFold.length,
    mae: round(absSum / perFold.length),
    mape: pctCount > 0 ? round(pctSum / pctCount, 2) : null,
    perFold,
  };
}

/**
 * Fit a SARIMA/SARIMAX grid by conditional least squares, select by AICc
 * (CV MAE as tie-breaker), optionally cross-validate, and project.
 */
export function fitSarima(values: number[], opts: SarimaOptions): SarimaFit {
  if (!values || values.length < 8) throw new SarimaError("SARIMA needs at least 8 historical periods.");
  if (!values.every(finite)) throw new SarimaError("SARIMA needs every historical value to be finite.");
  if (!(opts.seasonalPeriods >= 0)) throw new SarimaError("seasonalPeriods must be non-negative.");
  const s = opts.seasonalPeriods > 1 ? Math.round(opts.seasonalPeriods) : 0;
  const maxOrder = Math.max(0, Math.min(3, Math.round(opts.maxOrder || 0)));
  const maxSeasonalOrder = Math.max(0, Math.min(2, Math.round(opts.maxSeasonalOrder || 0)));
  const _horizon = Math.min(Math.max(1, opts.horizon || 1), 24);

  const built: { orders: Orders; fit: CandidateFit; cv: SarimaFit["cv"] }[] = [];
  for (let d = 0; d <= 1; d++) {
    for (let D = 0; D <= (s > 0 ? 1 : 0); D++) {
      const zLen = values.length - d - (s > 0 ? D * s : 0);
      if (zLen < 8) continue;
      for (let p = 0; p <= maxOrder; p++) {
        for (let q = 0; q <= maxOrder; q++) {
          for (let P = 0; P <= maxSeasonalOrder; P++) {
            for (let Q = 0; Q <= maxSeasonalOrder; Q++) {
              if (p + q + P + Q === 0 && d + D === 0) continue;
              const orders: Orders = { p, d, q, P, D, Q };
              const fit = fitCandidate(values, opts, orders);
              if (!fit) continue;
              const cv = rollingOriginCv(values, opts, orders);
              built.push({ orders, fit, cv });
            }
          }
        }
      }
    }
  }
  if (built.length === 0) {
    throw new SarimaError("No SARIMA candidate could be fit — the series is too short for the requested orders.");
  }

  built.sort((a, b) => {
    if (a.fit.candidate.aicc !== b.fit.candidate.aicc) return a.fit.candidate.aicc - b.fit.candidate.aicc;
    return (a.cv?.mae ?? Number.POSITIVE_INFINITY) - (b.cv?.mae ?? Number.POSITIVE_INFINITY);
  });
  const winner = built[0]!;
  const best: SarimaCandidate = { ...winner.fit.candidate, cvMae: winner.cv ? winner.cv.mae : null };
  const candidates: SarimaCandidate[] = built.map((b) => ({ ...b.fit.candidate, cvMae: b.cv ? b.cv.mae : null }));

  const cleanRes = winner.fit.residuals.filter(finite);
  const lb = cleanRes.length >= 12 ? ljungBoxPValue(cleanRes, 10) : Number.NaN;
  const meanError = cleanRes.length > 0 ? cleanRes.reduce((a, b) => a + b, 0) / cleanRes.length : 0;

  return {
    best,
    candidates,
    fitted: winner.fit.fitted,
    residuals: winner.fit.residuals,
    points: winner.fit.points,
    diagnostics: {
      meanError: round(meanError),
      sigma: best.sigma,
      ljungBoxP: Number.isFinite(lb) ? round(lb, 4) : Number.NaN,
      note:
        lb < 0.05
          ? `Winning model residuals still show autocorrelation (Ljung-Box p = ${Number.isFinite(lb) ? lb.toFixed(3) : "n/a"}) — the point path may be biased and the interval optimistic.`
          : `Winning model residuals show no significant autocorrelation at lag 10 (Ljung-Box p = ${Number.isFinite(lb) ? lb.toFixed(3) : "n/a"}).`,
    },
    cv: winner.cv,
  };
}
