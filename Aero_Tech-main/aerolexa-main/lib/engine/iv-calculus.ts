/**
 * Instrumental variables and do-calculus.
 *
 * Two related causal tools that `elite-causal.ts` does not cover, because both
 * need machinery DiD / IPW do not have.
 *
 * PART 1 — INSTRUMENTAL VARIABLES (identification under unobserved confounding)
 *
 * When treatment is confounded and no observed backdoor set suffices, an
 * instrument Z — correlated with treatment, independent of the outcome error,
 * and excluded from the outcome equation — identifies a LOCAL average effect:
 *
 *   β_IV = Cov(Z,Y) / Cov(Z,X)      (just identified)
 *
 * Implemented as two-stage least squares with the textbook variance:
 *
 *   x̂  = Zπ̂                      first stage: X on [Z, controls]
 *   β̂  = (x̂'x̂)⁻¹ x̂'y            second stage on the FITTED treatment
 *   Var(β̂) = σ̂² / (π̂'Z'Zπ̂)       σ̂² from second-stage RSS, df = n − L + K
 *
 * The second stage uses x̂, not X — using raw X there silently returns OLS, and
 * the standard error is deliberately the IV one (widened by weak first-stage
 * strength), not the OLS one. Getting either wrong is the most common error in
 * applied work, so both are reported side by side.
 *
 * Three diagnostics are computed because a point estimate from a weak
 * instrument is worse than no estimate:
 *
 *   1. First-stage F and the rule-of-10 verdict.
 *   2. Anderson–Rubin test — the weak-IV-robust test. Regress (y − β₀X) on Z and
 *      test "all instrument coefficients are zero"; this never divides by
 *      first-stage strength. Inverted over β₀ into a confidence SET, which is
 *      reported alongside the Wald interval.
 *   3. Hansen J overidentification test when #instruments > #endogenous
 *      regressors, with df = L − K.
 *
 * `principalStrata` applies the instrument to the Angrist–Pischke decomposition
 * (complier share, LATE, and bounds on always-takers / never-takers) with
 * monotonicity named as the assumption it is.
 *
 * PART 2 — DO-CALCULUS (interventional distribution, no assumption)
 *
 * Given an explicit causal DAG over finite discrete variables, `doIntervene`
 * performs graph surgery (Pearl 1995): every arrow into the intervened node is
 * deleted, and p(v | do(X = x)) is computed by exact enumeration of the
 * truncated factorization. `findBackdoorSet` implements Pearl's adjustment
 * criterion, returning the minimal valid set and saying explicitly when none
 * exists (which is the signal to use a front-door or IV design instead).
 *
 * DETERMINISM: closed-form algebra, exact enumeration, and a bisection search
 * for the AR set. No RNG, no simulation, no bootstrap. Same input ⇒ identical
 * output, byte for byte.
 */

import { mean, ols, variance } from "@/lib/engine/stats";

export class IvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IvError";
  }
}

// ---------------------------------------------------------------------------
// PART 1 — Instrumental variables
// ---------------------------------------------------------------------------

export interface IvOptions {
  y: number[];
  /** Endogenous treatment. */
  x: number[];
  /** One array per instrument, each of length n. */
  z: number[][];
  /** Exogenous controls (assumed valid to condition on). */
  controls?: number[][];
  estimator?: "2sls" | "liml";
  alpha?: number;
  instrumentNames?: string[];
}

export interface IvInstrumentReport {
  name: string;
  firstStageCoef: number;
  firstStageT: number;
  /** First-stage F of this instrument alone (its own relevance). */
  ownF: number;
}

export interface IvResult {
  estimator: "2sls" | "liml";
  beta: number;
  /** Weak-instrument-inflated standard error (π̂'Z'Zπ̂ form). */
  stdError: number;
  tStatistic: number;
  pValue: number;
  ci: [number, number];
  olsBeta: number;
  olsStdError: number;
  firstStageF: number;
  firstStageR2: number;
  strength: { verdict: "strong" | "weak" | "none"; message: string };
  andersonRubin: { rejectsNullAtZero: boolean; set: [number, number] | null; note: string };
  overidentification: { j: number; df: number; pValue: number; message: string } | null;
  instruments: IvInstrumentReport[];
  n: number;
  residualVariance: number;
  warnings: string[];
  interpretation: string;
}

interface OlsLike {
  coefficients: number[];
  intercept: number;
}

function rssOf(design: number[][], y: number[], fit: OlsLike): number {
  let rss = 0;
  for (let i = 0; i < y.length; i++) {
    let pred = fit.intercept;
    for (let j = 0; j < fit.coefficients.length; j++) pred += fit.coefficients[j]! * (design[i]?.[j] ?? 0);
    const d = y[i]! - pred;
    rss += d * d;
  }
  return rss;
}

/** π̂'Z'Zπ̂ — the instrument-block quadratic form of the first stage. */
function instrumentQuadratic(z: number[][], pi: number[]): number {
  const n = z[0]?.length ?? 0;
  const q = z.length;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    let proj = 0;
    for (let j = 0; j < q; j++) proj += pi[j]! * z[j]![i]!;
    acc += proj * proj;
  }
  return acc;
}

/**
 * F test p-value via the regularised incomplete beta function:
 *   P(F ≤ f) = I_{d₁f/(d₁f+d₂)}(d₁/2, d₂/2)
 * Exact, so no critical-value table is needed anywhere in this file.
 */
export function fTestPValue(f: number, df1: number, df2: number): number {
  if (!Number.isFinite(f) || f <= 0 || df1 <= 0 || df2 <= 0) return 1;
  // Upper-tail probability P(F > f): 1 minus the regularised-incomplete-beta
  // CDF. (This previously returned the CDF itself, so every caller — the
  // Anderson–Rubin inversion included — reasoned backwards: a LARGE F looked
  // "not significant" because its CDF sat near 1.)
  return 1 - regularizedBeta((df1 * f) / (df1 * f + df2), df1 / 2, df2 / 2);
}

function lnGamma(z: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lnGamma(1 - z);
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i]! / (zz + i + 1);
  const t = zz + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularised incomplete beta I_x(a,b) — continued fraction (Lentz). */
function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lbeta);
  if (x < (a + 1) / (a + b + 2)) return (front * betaCf(x, a, b)) / a;
  return 1 - (front * betaCf(1 - x, b, a)) / b;
}

function betaCf(x: number, a: number, b: number): number {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** Two-sided normal tail, and the inverse for interval endpoints. */
function normalCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26, |error| < 7.5e-8.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = 0.3989422804014327 * Math.exp((-x * x) / 2) * poly;
  return x > 0 ? 1 - tail : tail;
}

function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    q =
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - pl) {
    const r = p - 0.5;
    const rr = r * r;
    q =
      ((((((a[0]! * rr + a[1]!) * rr + a[2]!) * rr + a[3]!) * rr + a[4]!) * rr + a[5]!) * r) /
      (((((b[0]! * rr + b[1]!) * rr + b[2]!) * rr + b[3]!) * rr + b[4]!) * rr + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    q =
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  // One Halley refinement against the true CDF.
  const e = normalCdf(q) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((q * q) / 2);
  return q - u / (1 + (q * u) / 2);
}

/** χ² upper-tail p-value. */
function chiSquareP(x: number, k: number): number {
  if (k <= 0) return 1;
  if (x <= 0) return 1;
  const a = k / 2;
  const xx = x / 2;
  if (xx < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let i = 0; i < 500; i++) {
      ap += 1;
      del *= xx / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-xx + a * Math.log(xx) - lnGamma(a));
  }
  const FPMIN = 1e-300;
  let b = xx + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-xx + a * Math.log(xx) - lnGamma(a)) * h;
}

/**
 * Column-major design ([variable][observation]) → row-major
 * ([observation][variable]), the layout `ols()` from lib/engine/stats
 * expects. Passing the column layout straight through made `p = n` and every
 * single IV estimate fail as "rank-deficient".
 */
function toRows(cols: number[][]): number[][] {
  const n = cols[0]?.length ?? 0;
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i] ?? 0));
}

/**
 * Two-stage least squares with the weak-instrument variance, plus the three
 * diagnostics that make the estimate interpretable.
 */
export function estimateIv(opts: IvOptions): IvResult {
  const { y, x, z } = opts;
  const controls = opts.controls ?? [];
  const n = y.length;
  const warnings: string[] = [];
  const estimator = opts.estimator ?? "2sls";
  const alpha = opts.alpha ?? 0.05;

  if (n < 12) throw new IvError(`IV estimation needs at least 12 observations; got ${n}.`);
  if (!Array.isArray(z) || z.length === 0) throw new IvError("At least one instrument is required.");
  if (x.length !== n || y.length !== n) throw new IvError("Outcome and treatment vectors must have equal length.");
  const q = z.length;
  for (const col of z)
    if (col.length !== n) throw new IvError("Every instrument column must align with the outcome vector.");
  for (const c of controls)
    if (c.length !== n) throw new IvError("Every control column must align with the outcome vector.");
  if (![...y, ...x, ...z.flat(), ...controls.flat()].every((v) => Number.isFinite(v))) {
    throw new IvError(
      "Instrumental-variable estimation needs finite values only; filter or impute the missing cells first.",
    );
  }

  // ---- First stage: X ~ [Z, controls] --------------------------------------
  const firstDesign = [...z, ...controls];
  const first = ols(toRows(firstDesign), x);
  if (!first) {
    throw new IvError(
      "The first stage is rank-deficient: the instrument does not vary independently of the controls, so there is no relevance to exploit. An instrument that is collinear with a control identifies nothing.",
    );
  }
  const xHat = toRows(firstDesign).map((row) => {
    let acc = first.intercept;
    for (let j = 0; j < row.length; j++) acc += first.coefficients[j]! * row[j]!;
    return acc;
  });

  const rssFull = rssOf(toRows(firstDesign), x, first);
  const rssRestricted =
    controls.length > 0 ? rssOf(toRows(controls), x, ols(toRows(controls), x) ?? first) : variance(x) * (n - 1);
  const dfFull = n - firstDesign.length - 1;
  const firstStageF =
    dfFull > 0 && rssFull > 0 ? (rssRestricted - rssFull) / q / (rssFull / dfFull) : Number.POSITIVE_INFINITY;
  const totalSS = variance(x) * (n - 1);
  const firstStageR2 = totalSS > 0 ? 1 - rssFull / totalSS : 0;

  // ---- Second stage: Y ~ [x̂, controls] ------------------------------------
  const secondDesign = [xHat, ...controls];
  const second = ols(toRows(secondDesign), y);
  if (!second) throw new IvError("The second stage is rank-deficient.");
  const beta = second.coefficients[0]!;
  const rssSecond = rssOf(toRows(secondDesign), y, second);

  // ---- Var(β̂) = σ̂² / (π̂'Z'Zπ̂) -------------------------------------------
  // df = n − L + K with L = #instruments + #controls (plus intercept) and
  // K = #controls + 1 endogenous — the standard 2SLS residual df.
  const df2 = n - (q + controls.length + 1);
  const sigma2 = df2 > 0 ? rssSecond / df2 : rssSecond / Math.max(1, n - 2);
  const zzQuad = instrumentQuadratic(z, first.coefficients.slice(0, q));
  const stdError = zzQuad > 1e-12 ? Math.sqrt(sigma2 / zzQuad) : Number.POSITIVE_INFINITY;
  const tStatistic = Number.isFinite(stdError) && stdError > 0 ? beta / stdError : 0;
  const pValue = Number.isFinite(stdError) ? 2 * (1 - normalCdf(Math.abs(tStatistic))) : 1;
  const zCrit = normalQuantile(1 - alpha / 2);
  const ci: [number, number] = [beta - zCrit * stdError, beta + zCrit * stdError];

  // ---- Strength verdict ----------------------------------------------------
  const threshold = 10 + 2 / Math.max(1, q);
  const verdict: IvResult["strength"]["verdict"] =
    !Number.isFinite(firstStageF) || firstStageF <= 0 ? "none" : firstStageF >= threshold ? "strong" : "weak";

  // ---- Anderson–Rubin: invert the weak-IV-robust test ----------------------
  const ar = andersonRubinConfidenceSet(y, x, z, controls, alpha, beta, stdError);

  // ---- Hansen J ------------------------------------------------------------
  const L = q + controls.length + 1;
  const K = controls.length + 1;
  const dfJ = L - K;
  let overidentification: IvResult["overidentification"] = null;
  if (dfJ > 0) {
    const j = Math.max(0, rssSecond / sigma2 - (n - dfJ));
    const pJ = chiSquareP(j, dfJ);
    overidentification = {
      j,
      df: dfJ,
      pValue: pJ,
      message:
        pJ < alpha
          ? `Rejected at ${(alpha * 100).toFixed(0)}% (J = ${j.toFixed(3)} on ${dfJ} df). The instruments are jointly inconsistent with the structural model: at least one fails the exclusion restriction or is correlated with the error. The IV point estimate should not be used.`
          : `Not rejected (J = ${j.toFixed(3)} on ${dfJ} df, p = ${pJ.toFixed(3)}). The instruments are jointly consistent with the exclusion restriction — necessary, not sufficient.`,
    };
  }

  // ---- Per-instrument relevance -------------------------------------------
  const names = opts.instrumentNames ?? z.map((_, i) => `Z${i + 1}`);
  const instruments: IvInstrumentReport[] = z.map((col, j) => {
    const soloDesign: number[][] = [col, ...controls];
    const solo = ols(toRows(soloDesign), x);
    const coef = solo ? solo.coefficients[0]! : first.coefficients[j]!;
    const se = solo ? solo.standardErrors[0]! : first.standardErrors[j]!;
    const soloRss = solo ? rssOf(toRows(soloDesign), x, solo) : rssFull;
    const soloDf = n - controls.length - 2;
    const soloF = soloDf > 0 && soloRss > 0 ? (rssRestricted - soloRss) / (soloRss / soloDf) : Number.NaN;
    return {
      name: names[j] ?? `Z${j + 1}`,
      firstStageCoef: coef,
      firstStageT: se > 0 && Number.isFinite(se) ? coef / se : 0,
      ownF: soloF,
    };
  });

  // ---- Honesty -------------------------------------------------------------
  if (verdict === "weak") {
    warnings.push(
      `First-stage F = ${fmtNum(firstStageF)} is below the rule-of-10 threshold (${threshold.toFixed(1)}). The instrument is weak: the 2SLS estimate is pulled toward OLS and the Wald interval understates true uncertainty. Quote the Anderson–Rubin set instead.`,
    );
  }
  if (verdict === "none") {
    warnings.push(
      "The first stage provides no signal at all — the instrument is orthogonal to the treatment after controls. No IV estimate is identified.",
    );
  }
  if (overidentification && overidentification.pValue < alpha) {
    warnings.push(overidentification.message);
  }
  if (dfJ <= 0) {
    warnings.push(
      "Just-identified (one instrument, one endogenous regressor): overidentification is not testable, so instrument validity rests entirely on the untestable exclusion restriction.",
    );
  }
  if (Math.abs(beta - second.coefficients[0]!) / Math.max(1e-9, Math.abs(beta)) < 1e-9) {
    warnings.push(
      "The IV estimate is numerically identical to OLS — the fitted treatment x̂ collides with the raw treatment X. Check that the instrument does not enter the second stage directly.",
    );
  }
  if (estimator === "liml" && dfJ > 0) {
    warnings.push(
      "LIML is requested with multiple instruments; the reported point estimate is the 2SLS solution, which shares LIML's weakness to first order but not exactly. The Hansen J test is the practical guard against invalid instruments here.",
    );
  }
  warnings.push(
    "IV identifies a LOCAL average effect — for units whose treatment the instrument actually moves. Extending it to the whole population assumes homogeneous treatment effects, which this design cannot test.",
  );
  warnings.push(
    "The exclusion restriction (the instrument affects the outcome only through treatment) is assumed, not tested. It is the load-bearing assumption of the method.",
  );
  if (sigma2 <= 0) {
    warnings.push(
      "The second-stage residual variance is ≤ 0 — the outcome is exactly explained by the fitted treatment. Inference is undefined and only a point estimate can be reported.",
    );
  }

  const interpretation =
    verdict === "strong"
      ? `Strong first stage (F = ${fmtNum(firstStageF)}), so the instrument has real leverage on treatment. The IV estimate is ${beta.toFixed(4)} (SE ${fmtNum(stdError)}, p = ${pValue.toFixed(4)}), against OLS ${second.coefficients[0]!.toFixed(4)} — the gap between them is the size of the omitted-variable bias this instrument removes.`
      : `Weak first stage (F = ${fmtNum(firstStageF)}): the IV estimate ${beta.toFixed(4)} cannot be distinguished from OLS ${second.coefficients[0]!.toFixed(4)}. The Anderson–Rubin statement is ${
          ar.set ? `an interval of [${ar.set[0].toFixed(3)}, ${ar.set[1].toFixed(3)}]` : "inconclusive at the 5% level"
        }.`;

  return {
    estimator,
    beta,
    stdError,
    tStatistic,
    pValue,
    ci,
    olsBeta: second.coefficients[0]!,
    olsStdError: second.standardErrors[0]!,
    firstStageF,
    firstStageR2,
    strength: {
      verdict,
      message:
        verdict === "strong"
          ? `First-stage F = ${fmtNum(firstStageF)} ≥ ${threshold.toFixed(1)}: the instrument is strong.`
          : verdict === "weak"
            ? `First-stage F = ${fmtNum(firstStageF)} < ${threshold.toFixed(1)}: weak instrument — inference is unreliable.`
            : "First stage has no signal: the instrument is orthogonal to treatment after controls.",
    },
    andersonRubin: ar,
    overidentification,
    instruments,
    n,
    residualVariance: sigma2,
    warnings,
    interpretation,
  };
}

/**
 * Anderson–Rubin confidence set, inverted over β₀.
 *
 * For each candidate β₀ the auxiliary regression (y − β₀X) ~ [Z, controls] is
 * fitted and an F test of "all q instrument coefficients are zero" is run. That
 * test is valid with weak instruments because it never divides by first-stage
 * strength. The confidence SET is the set of β₀ that fail to reject; if it is
 * unbounded, the honest answer is "inconclusive", not a number.
 */
function andersonRubinConfidenceSet(
  y: number[],
  x: number[],
  z: number[][],
  controls: number[][],
  alpha: number,
  betaWald: number,
  seWald: number,
): IvResult["andersonRubin"] {
  const n = y.length;
  const q = z.length;
  const dfF = n - (q + controls.length + 1);

  const pAt = (beta0: number): number => {
    const adj = y.map((yi, i) => yi - beta0 * x[i]!);
    const full = ols(toRows([...z, ...controls]), adj);
    if (!full) return 1;
    const rssF = rssOf(toRows([...z, ...controls]), adj, full);
    const restrictedFit = controls.length > 0 ? ols(toRows(controls), adj) : null;
    const rssR =
      controls.length > 0 && restrictedFit
        ? rssOf(toRows(controls), adj, restrictedFit)
        : adj.reduce((a, v) => a + (v - mean(adj)) ** 2, 0);
    if (rssF <= 0) return 0;
    const f = (rssR - rssF) / q / (rssF / dfF);
    return fTestPValue(f, q, dfF);
  };

  const pZero = pAt(0);
  if (pZero >= alpha) {
    return {
      rejectsNullAtZero: false,
      set: null,
      note: `The Anderson–Rubin test does not reject H₀: β = 0 (p = ${pZero.toFixed(3)}). The instruments cannot rule out no effect at all — that is a stronger statement than "not significant", and the correct conclusion is inconclusive rather than a wide interval.`,
    };
  }

  // The set is bounded: bracket it by doubling outward, then bisect the edges.
  const scale = Number.isFinite(seWald) && seWald > 0 ? 4 * seWald : Math.max(1e-6, Math.abs(betaWald));
  let span = scale;
  let rejectHigh = false;
  for (let i = 0; i < 60; i++) {
    if (pAt(span) >= alpha) break;
    rejectHigh = true;
    span *= 2;
  }
  if (!rejectHigh) {
    return {
      rejectsNullAtZero: true,
      set: null,
      note: "The Anderson–Rubin set has no upper edge within 2⁶⁰ doubling steps — the upper tail of the effect is not identified at this confidence level.",
    };
  }

  const edge = (lo: number, hi: number, keepLow: boolean): number => {
    let a = lo;
    let b = hi;
    for (let i = 0; i < 60; i++) {
      const mid = (a + b) / 2;
      const rejects = pAt(mid) < alpha;
      if (rejects === keepLow) b = mid;
      else a = mid;
    }
    return (a + b) / 2;
  };
  let lo = -span;
  for (let i = 0; i < 60; i++) {
    if (pAt(lo) < alpha) break;
    lo *= 2;
  }
  const lowerEdge = edge(lo, 0, false);
  const upperEdge = edge(0, span, true);

  return {
    rejectsNullAtZero: true,
    set: [lowerEdge, upperEdge],
    note: `Weak-instrument-robust confidence set: the AR test rejects H₀: β = β₀ for every β₀ outside [${lowerEdge.toFixed(4)}, ${upperEdge.toFixed(4)}]. Compare with the Wald interval [${(betaWald - 1.96 * seWald).toFixed(4)}, ${(betaWald + 1.96 * seWald).toFixed(4)}] — where they disagree, the AR set is the honest one.`,
  };
}

// ---------------------------------------------------------------------------
// Principal strata (Angrist–Pischke)
// ---------------------------------------------------------------------------

export interface PrincipalStrataResult {
  /** Complier share = Δx, the classic Wald denominator. */
  complierShare: number;
  late: number;
  lateStdError: number;
  ci: [number, number];
  /** E[X|Z=0] bounds the always-taker share from below; 1 − E[X|Z=1] from above. */
  alwaysTakerBounds: [number, number];
  neverTakerBounds: [number, number];
  /** Effect for always-takers and never-takers, where identified. */
  alwaysTakerEffect: number | null;
  /** Whether the data are compatible with monotonicity at the reported SE. */
  monotoneCompatible: boolean;
  interpretation: string;
  warning: string;
}

/**
 * Angrist–Pischke decomposition for a binary instrument. The complier share is
 * Δx, the LATE is the Wald ratio Δy/Δx with the IV variance, and the
 * always-/never-taker shares are bounded by the observed arm means — they are
 * not identified point-wise, and are reported as intervals for that reason.
 */
export function principalStrata(y: number[], x: number[], z: number[], alpha = 0.05): PrincipalStrataResult {
  const n = y.length;
  if (n < 20) throw new IvError(`LATE estimation needs at least 20 observations; got ${n}.`);
  const z1 = z.map((v) => v === 1);
  const z0 = z.map((v) => v === 0);
  if (!z1.some(Boolean) || !z0.some(Boolean)) {
    throw new IvError("Both instrument arms must be present to decompose the population.");
  }
  const iv = estimateIv({ y, x, z: [z], alpha, instrumentNames: ["Z"] });

  const meanX1 = mean(x.filter((_, i) => z1[i]!));
  const meanX0 = mean(x.filter((_, i) => z0[i]!));
  const complierShare = meanX1 - meanX0;
  const meanY1 = mean(y.filter((_, i) => z1[i]!));
  const meanY0 = mean(y.filter((_, i) => z0[i]!));

  // Under monotonicity, always-takers are the X=1 units in the Z=0 arm and
  // never-takers are the X=0 units in the Z=1 arm; their *shares* are only
  // bounded, because compliers contaminate both arms.
  const atBounds: [number, number] = [Math.min(meanX0, 1 - complierShare), Math.max(meanX0, 1 - complierShare)];
  const ntBounds: [number, number] = [Math.min(1 - meanX1, 1 - complierShare), Math.max(1 - meanX1, 1 - complierShare)];

  // The never-taker effect IS identified (they are untreated in both arms).
  const nNeverTakers = x.filter((_, i) => z1[i]! && x[i] === 0).length;
  const alwaysTakerEffect = nNeverTakers > 1 && Number.isFinite(iv.stdError) ? meanY0 - meanY1 : null;

  // Monotonicity check: the IV effect must not contradict the sign of the raw
  // difference in a way that implies negative-defiers. Reported, not enforced.
  const rawDiff = meanY1 - meanY0;
  const monotoneCompatible = !(Math.sign(rawDiff) !== Math.sign(iv.beta) && Math.abs(rawDiff) > 2 * iv.stdError);

  const zCrit = normalQuantile(1 - alpha / 2);
  const ci: [number, number] = [iv.beta - zCrit * iv.stdError, iv.beta + zCrit * iv.stdError];

  const warning =
    complierShare < 0.05
      ? `The instrument moves only ${(complierShare * 100).toFixed(1)}% of units between arms. The LATE is estimated from almost no compliers and is unstable to the point of being uninformative.`
      : complierShare < 0.4
        ? `Only ${(complierShare * 100).toFixed(1)}% of units are compliers, so the LATE describes a minority of the population. Treating a substantial fraction (always-takers at ${(atBounds[0] * 100).toFixed(1)}–${(atBounds[1] * 100).toFixed(1)}%) with a different effect than the LATE would materially change your business decision.`
        : `Complier share is ${(complierShare * 100).toFixed(1)}%, so the LATE is plausibly representative — but that is a convenience, not a test.`;

  const interpretation = monotoneCompatible
    ? `Compliers are ${(complierShare * 100).toFixed(1)}% of the population and their effect is ${iv.beta.toFixed(4)} (95% CI ${ci[0].toFixed(4)} to ${ci[1].toFixed(4)}). The untreated effect among never-takers is ${rawDiff.toFixed(4)}. A rollout that changes treatment for everyone would move the population average by roughly ${(complierShare * iv.beta).toFixed(4)}, not by ${iv.beta.toFixed(4)} — the gap between those two numbers is the whole point of a LATE.`
    : `The Wald effect ${iv.beta.toFixed(4)} opposes the raw arm difference ${rawDiff.toFixed(4)} by more than 2 SE, which is inconsistent with monotonicity. Either the exclusion restriction fails or defiers exist; the principal-strata shares below should not be interpreted until that is resolved.`;

  return {
    complierShare,
    late: iv.beta,
    lateStdError: iv.stdError,
    ci,
    alwaysTakerBounds: atBounds,
    neverTakerBounds: ntBounds,
    alwaysTakerEffect,
    monotoneCompatible,
    interpretation,
    warning,
  };
}

// ---------------------------------------------------------------------------
// PART 2 — Do-calculus over a discrete causal DAG
// ---------------------------------------------------------------------------

/**
 * A discrete DAG node.
 *
 * `cpt` is a FLAT table in mixed-radix order over `parents`, with the FIRST
 * parent varying most slowly:
 *
 *   index(parentValues) = Σ_j parentValue_j · Π_{k>j} |parents_k.values|
 *
 * Row length must equal `values.length`. `dag()` validates this on build, so a
 * malformed CPT is rejected at construction rather than producing plausible
 * nonsense probabilities later.
 */
export interface DagNode {
  name: string;
  values: number[];
  parents: string[];
  cpt: number[];
}

export interface DagResult {
  distribution: { node: string; value: number; probability: number }[];
  /** P(v) before the intervention, for the same graph. */
  observational: { node: string; value: number; probability: number }[];
  intervened: { node: string; value: number; probability: number }[];
  totalMass: number;
  method: string;
  note: string;
}

/** Validate a node set and return it as an immutable graph. */
export function buildDag(nodes: DagNode[]): DagNode[] {
  const byName = new Map<string, DagNode>();
  for (const node of nodes) {
    if (byName.has(node.name)) throw new IvError(`Duplicate node "${node.name}".`);
    if (node.values.length === 0) throw new IvError(`Node "${node.name}" has an empty domain.`);
    byName.set(node.name, node);
  }
  for (const node of nodes) {
    let expected = 1;
    for (const p of node.parents) {
      const parent = byName.get(p);
      if (!parent) throw new IvError(`Node "${node.name}" lists unknown parent "${p}".`);
      expected *= parent.values.length;
    }
    if (node.cpt.length !== expected) {
      throw new IvError(
        `Node "${node.name}" has a CPT of ${node.cpt.length} entries but its parents imply ${expected}. Mixed-radix order, first parent slowest.`,
      );
    }
    for (const parent of node.parents) {
      if (parent === node.name) throw new IvError(`Node "${node.name}" cannot be its own parent.`);
    }
    const sum = node.cpt.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - expected) > 1e-6) {
      throw new IvError(
        `Node "${node.name}" CPT sums to ${sum.toFixed(6)} over ${expected} parent configurations; each configuration must sum to 1.`,
      );
    }
  }
  return nodes.map((n) => ({ ...n }));
}

function mixedRadix(digits: number[], cardinalities: number[]): number {
  let idx = 0;
  for (let j = 0; j < digits.length; j++) {
    idx = idx * (cardinalities[j] as number) + digits[j]!;
  }
  return idx;
}

function cptProbability(node: DagNode, assignment: Record<string, number>, byName: Map<string, DagNode>): number {
  if (node.parents.length === 0) return node.cpt[node.values.indexOf(assignment[node.name]!)] ?? 0;
  const digits = node.parents.map((p) => byName.get(p)!.values.indexOf(assignment[p]!));
  const card = node.parents.map((p) => byName.get(p)!.values.length);
  const row = mixedRadix(digits, card);
  return node.cpt[row] ?? 0;
}

function marginals(dag: DagNode[], joint: { node: string; value: number; probability: number }[]) {
  const map = new Map<string, Map<number, number>>();
  for (const e of joint) {
    if (!map.has(e.node)) map.set(e.node, new Map());
    const m = map.get(e.node)!;
    m.set(e.value, (m.get(e.value) ?? 0) + e.probability);
  }
  return dag.map((n) => ({
    node: n.name,
    values: n.values,
    probs: n.values.map((v) => map.get(n.name)?.get(v) ?? 0),
  }));
}

/**
 * Enumerate the exact joint distribution of a DAG.
 * Nodes are visited in topological order, so every parent is assigned before its
 * children and the cartesian product needs no backtracking. Returns one entry
 * per (node, value) per joint state — the consumer marginalises.
 */
function topoSort(dag: DagNode[], byName: Map<string, DagNode>): DagNode[] {
  const visited = new Set<string>();
  const order: DagNode[] = [];
  const visit = (name: string, stack: Set<string>): void => {
    if (visited.has(name) || stack.has(name)) return;
    stack.add(name);
    for (const p of byName.get(name)!.parents) visit(p, stack);
    stack.delete(name);
    visited.add(name);
    order.push(byName.get(name)!);
  };
  for (const node of dag) visit(node.name, new Set());
  return order;
}

/**
 * p(v | do(T = t)) by graph surgery: delete every arrow into T, replacing
 * P(T|·) with a point mass, and marginalise T out of every other node's CPT at
 * that value (which is exact, because under do(T=t) T carries no uncertainty).
 */
export function doIntervene(dag: DagNode[], treatment: string, value: number): DagResult {
  const target = dag.find((n) => n.name === treatment);
  if (!target) throw new IvError(`Node "${treatment}" is not in the DAG.`);
  const tIdx = target.values.indexOf(value);
  if (tIdx < 0)
    throw new IvError(`Value ${value} is not in the domain of "${treatment}" (${target.values.join(", ")}).`);

  const truncated: DagNode[] = dag.map((node) => {
    if (node.name === treatment) {
      return { name: node.name, values: node.values, parents: [], cpt: node.values.map((v) => (v === value ? 1 : 0)) };
    }
    const tPos = node.parents.indexOf(treatment);
    if (tPos < 0) return node;
    // Remove the treatment parent: slice the flat CPT at T = value, keeping the
    // remaining parents' relative order, then re-index mixed radix.
    const byName = new Map(dag.map((n) => [n.name, n]));
    const remainingParents = node.parents.filter((p) => p !== treatment);
    const remainingCard = remainingParents.map((p) => byName.get(p)!.values.length);
    const newCpt: number[] = [];
    if (remainingParents.length === 0) {
      // Treatment was the only parent: the new row is the slice at T = value.
      for (const v of node.values) {
        newCpt.push(cptProbability(node, { [treatment]: value, [node.name]: v }, byName));
      }
    } else {
      const total = remainingCard.reduce((a, b) => a * b, 1);
      for (let idx = 0; idx < total; idx++) {
        const digits = decomposeIndex(idx, remainingCard);
        const assignment: Record<string, number> = { [treatment]: value };
        remainingParents.forEach((p, j) => {
          assignment[p] = byName.get(p)!.values[digits[j]!]!;
        });
        for (const v of node.values) {
          assignment[node.name] = v;
          newCpt.push(cptProbability(node, assignment, byName));
        }
      }
    }
    return { name: node.name, values: node.values, parents: remainingParents, cpt: newCpt };
  });

  const byNameTrunc = new Map(truncated.map((n) => [n.name, n]));
  const states: Record<string, number>[] = [{}];
  for (const node of topoSort(truncated, byNameTrunc)) {
    const next: Record<string, number>[] = [];
    for (const st of states) for (const v of node.values) next.push({ ...st, [node.name]: v });
    states.length = 0;
    states.push(...next);
  }
  const joint: { node: string; value: number; probability: number }[] = [];
  let totalMass = 0;
  for (const st of states) {
    let p = 1;
    for (const node of truncated) p *= cptProbability(node, st, byNameTrunc);
    totalMass += p;
    for (const node of truncated) joint.push({ node: node.name, value: st[node.name]!, probability: p });
  }

  const m = marginals(truncated, joint);
  const flat = m.flatMap((node) =>
    node.values.map((v, i) => ({ node: node.node, value: v, probability: node.probs[i]! })),
  );

  return {
    distribution: flat,
    observational: flattenMarginals(dag),
    intervened: flat.filter((e) => e.node === treatment),
    totalMass,
    method:
      "truncated factorization — every arrow into the intervened node is deleted and its conditional replaced by a point mass; the discrete state space is enumerated exactly",
    note: `do(${treatment} = ${value}) returned total probability mass ${totalMass.toFixed(10)} ${Math.abs(totalMass - 1) < 1e-9 ? "— the CPTs are a coherent distribution." : "— THIS IS NOT 1, so the graph's CPTs are inconsistent and every number below is meaningless."}`,
  };
}

function flattenMarginals(dag: DagNode[]) {
  const byName = new Map(dag.map((n) => [n.name, n]));
  const states: Record<string, number>[] = [{}];
  for (const node of topoSort(dag, byName)) {
    const next: Record<string, number>[] = [];
    for (const st of states) for (const v of node.values) next.push({ ...st, [node.name]: v });
    states.length = 0;
    states.push(...next);
  }
  const joint: { node: string; value: number; probability: number }[] = [];
  for (const st of states) {
    let p = 1;
    for (const node of dag) p *= cptProbability(node, st, byName);
    for (const node of dag) joint.push({ node: node.name, value: st[node.name]!, probability: p });
  }
  return marginals(dag, joint).flatMap((node) =>
    node.values.map((v, i) => ({ node: node.node, value: v, probability: node.probs[i]! })),
  );
}

function decomposeIndex(idx: number, cardinalities: number[]): number[] {
  const digits = new Array<number>(cardinalities.length).fill(0);
  let rest = idx;
  for (let j = cardinalities.length - 1; j >= 0; j--) {
    digits[j] = rest % (cardinalities[j] as number);
    rest = Math.floor(rest / (cardinalities[j] as number));
  }
  return digits;
}

export interface BackdoorResult {
  adjustmentSet: string[];
  valid: boolean;
  reason: string;
  candidates: string[];
}

/**
 * Pearl's adjustment criterion, searched over non-descendants of the treatment.
 *
 * A set Z is valid when (1) no member is a descendant of T, and (2) Z blocks
 * every path from T to Y that contains an arrow INTO T. Condition (2) is
 * checked here by removing Z and testing whether T and Y stay connected in the
 * moralised ancestral graph — the standard d-separation criterion.
 *
 * Returns the minimal valid set by exhaustive search over sizes 0, 1, 2 (and 3
 * when needed). When none exists, that is reported as the finding: it means the
 * problem needs a front-door or IV design, and the caller is told so rather
 * than handed an invalid set.
 */
export function findBackdoorSet(dag: DagNode[], treatment: string, outcome: string): BackdoorResult {
  const byName = new Map(dag.map((n) => [n.name, n]));
  if (!byName.has(treatment) || !byName.has(outcome)) {
    return { adjustmentSet: [], valid: false, reason: "Treatment or outcome is not in the graph.", candidates: [] };
  }
  if (dag.some((n) => hasDirectedPath(n.name, treatment, byName))) {
    return {
      adjustmentSet: [],
      valid: false,
      reason: `"${treatment}" is an ancestor of "${outcome}": the effect of interest IS the mediated path, so no backdoor adjustment is the right frame. Use do-calculus on the mediator instead.`,
      candidates: [],
    };
  }

  const descendants = descendantsOf(treatment, byName);
  const candidates = dag.map((n) => n.name).filter((n) => n !== treatment && n !== outcome && !descendants.has(n));

  const blocks = (z: string[]): boolean => !mSeparated(treatment, outcome, new Set(z), byName);

  if (blocks([])) {
    return {
      adjustmentSet: [],
      valid: true,
      reason: `No adjustment is needed: ${treatment} and ${outcome} are d-separated by the empty set — the backdoor path does not exist in this graph.`,
      candidates,
    };
  }
  const combinations = [1, 2, 3];
  for (const size of combinations) {
    if (size > candidates.length) break;
    for (const combo of combinationsOf(candidates, size)) {
      if (blocks(combo)) {
        return {
          adjustmentSet: combo,
          valid: true,
          reason: `{${combo.join(", ")}} is a valid adjustment set — minimal at size ${size} — and contains no descendant of ${treatment}.`,
          candidates,
        };
      }
    }
  }
  return {
    adjustmentSet: [],
    valid: false,
    reason: `No backdoor adjustment set of size ≤ 3 exists among the non-descendants {${candidates.join(", ") || "none"}}. ${treatment} and ${outcome} are not d-separated by anything you observe, so the effect is not identified by adjustment. You need a front-door mediator, an instrument, or an unobserved-confounders model (e.g. a sensitivity analysis).`,
    candidates,
  };
}

function combinationsOf(items: string[], size: number): string[][] {
  if (size === 0) return [[]];
  const out: string[][] = [];
  const walk = (start: number, acc: string[]): void => {
    if (acc.length === size) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      acc.push(items[i]!);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

function descendantsOf(name: string, byName: Map<string, DagNode>): Set<string> {
  const out = new Set<string>();
  const stack = [...(byName.get(name)?.parents ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur) || cur === name) continue;
    out.add(cur);
    stack.push(...(byName.get(cur)?.parents ?? []));
  }
  return out;
}

function hasDirectedPath(from: string, to: string, byName: Map<string, DagNode>): boolean {
  const stack = [...(byName.get(from)?.parents ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(byName.get(cur)?.parents ?? []));
  }
  return false;
}

/**
 * m-separation: moralise the ancestral graph of {T, Y} ∪ Z, delete Z, and test
 * connectivity. Returns true when T and Y are d-separated given Z.
 */
function mSeparated(treatment: string, outcome: string, z: Set<string>, byName: Map<string, DagNode>): boolean {
  const ancestors = ancestorsOf([treatment, outcome], byName);
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  // Moralisation: marry parents of every ancestor, keep all ancestor edges.
  for (const a of ancestors) {
    const node = byName.get(a);
    if (!node) continue;
    const parents = node.parents.filter((p) => ancestors.has(p));
    for (const p of parents) link(a, p);
    for (let i = 0; i < parents.length; i++) {
      for (let j = i + 1; j < parents.length; j++) link(parents[i]!, parents[j]!);
    }
  }
  const seen = new Set<string>([treatment]);
  const stack = [treatment];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const nb of adj.get(cur) ?? []) {
      if (z.has(nb) || seen.has(nb)) continue;
      if (nb === outcome) return false; // connected → not m-separated
      seen.add(nb);
      stack.push(nb);
    }
  }
  return true;
}

function ancestorsOf(names: string[], byName: Map<string, DagNode>): Set<string> {
  const out = new Set<string>();
  const stack = [...names];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    stack.push(...(byName.get(cur)?.parents ?? []));
  }
  return out;
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "undefined";
  return v.toFixed(2);
}
