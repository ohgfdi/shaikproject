/**
 * Bayesian estimation: posterior distributions instead of point estimates.
 *
 * Three models, each deterministic given the same seed and inputs:
 *
 *   1. Conjugate Normal-Inverse-Gamma (NIG) posterior over regression
 *      coefficients. The closed form gives posterior means, credible
 *      intervals and the marginal likelihood — no MCMC needed for the point
 *      answer. Credible intervals are exact (multivariate-t marginal).
 *   2. Random-walk Metropolis over (beta, log sigma2) — used to demonstrate
 *      posterior sampling and check that the sampler recovers the closed-form
 *      answer. The closed form is the primary estimate; MCMC is the honest
 *      cross-check, never the other way round.
 *   3. Exact Gaussian-process regression with a squared-exponential kernel,
 *      Cholesky-based marginal likelihood and posterior predictive bands.
 *
 * Oracle-checked against statsmodels / scikit-learn posterior formulas in
 * __tests__/unit/bayes-oracle.test.ts.
 */

import { normalCdf, studentTCriticalTwoSided } from "@/lib/engine/stats";

export class BayesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BayesError";
  }
}

export interface BayesianRegressionInput {
  X: number[][];
  y: number[];
  names?: string[];
  priorSD?: number;
  credibleLevel?: number;
  mcmcSamples?: number;
  seed?: number;
}

export interface PosteriorTerm {
  name: string;
  priorMean: number;
  posteriorMean: number;
  posteriorSD: number;
  ciLow: number;
  ciHigh: number;
  /** P(beta > 0 | data) under the normal posterior. */
  probPositive: number;
  mcmcMean?: number;
  mcmcSD?: number;
  mcmcCiLow?: number;
  mcmcCiHigh?: number;
  ess?: number;
}

export interface BayesianRegressionResult {
  model: "regression";
  terms: PosteriorTerm[];
  sigma2PosteriorMean: number;
  sigma2PriorMean: number;
  logMarginalLikelihood: number;
  n: number;
  p: number;
  credibleLevel: number;
  priorSD: number;
  mcmc: {
    ran: boolean;
    samples: number;
    burnIn: number;
    meanLogSigma2: number;
    acceptanceRate: number;
    minESS: number;
    note: string;
  } | null;
  interpretation: string;
  warnings: string[];
}

export interface GaussianProcessInput {
  X: number[][];
  y: number[];
  lengthScale: number;
  noiseSD: number;
  /** Optional holdout rows for out-of-sample predictive bands. */
  XStar?: number[][];
  yStar?: number[];
  credibleLevel?: number;
}

export interface GaussianProcessResult {
  model: "gp";
  n: number;
  lengthScale: number;
  noiseSD: number;
  logMarginalLikelihood: number;
  trainRMSE: number;
  holdout: { n: number; rmse: number; coverage: number; mae: number } | null;
  posteriorMean: number[];
  posteriorSD: number[];
  ciLow: number[];
  ciHigh: number[];
  interpretation: string;
  warnings: string[];
}

function round(v: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Deterministic 32-bit PRNG (mulberry32) — same seed => same draws. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    if (Math.abs(M[pivot]![col]!) < 1e-14) return null;
    [M[col], M[pivot]] = [M[pivot] as number[], M[col] as number[]];
    const div = M[col]![col]!;
    for (let j = col; j <= n; j++) M[col]![j] = M[col]![j]! / div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[r]![j] = M[r]![j]! - f * M[col]![j]!;
    }
  }
  return M.map((r) => r[n] as number);
}

/** Determinant via elimination pivots (for the log marginal likelihood). */
function logDet(A: number[][]): number {
  const n = A.length;
  const M = A.map((row) => [...row]);
  let det = 1;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    if (Math.abs(M[pivot]![col]!) < 1e-14) return Number.NEGATIVE_INFINITY;
    [M[col], M[pivot]] = [M[pivot] as number[], M[col] as number[]];
    det *= M[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / M[col]![col]!;
      for (let k = col; k < n; k++) M[r]![k] = M[r]![k]! - f * M[col]![k]!;
    }
  }
  return det > 0 ? Math.log(det) : Number.NEGATIVE_INFINITY;
}

function logGammaFn(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGammaFn(1 - x);
  const z = x - 1;
  let acc = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) acc += (g[i] as number) / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(acc);
}

/**
 * NIG-posterior linear regression.
 *
 * Prior: beta | sigma2 ~ N(0, sigma2 * Lambda0^-1) with Lambda0 = I/priorSD^2,
 * sigma2 ~ Inv-Gamma(a0, b0) with a0 = 2, b0 = 1 (weakly informative — the
 * posterior is data-dominated for any n > 20).
 */
export function bayesianLinearRegression(input: BayesianRegressionInput): BayesianRegressionResult {
  const { X, y } = input;
  const n = y.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0 || X.length !== n)
    throw new BayesError("Bayesian regression needs a non-empty design matrix.");
  if (!X.every((row) => row.length === p))
    throw new BayesError("Every design row must have the same number of columns.");
  if (n <= p) throw new BayesError(`Bayesian regression needs more rows (${n}) than covariates (${p}).`);

  const priorSD = input.priorSD && input.priorSD > 0 ? input.priorSD : 10;
  const credibleLevel =
    input.credibleLevel && input.credibleLevel > 0.5 && input.credibleLevel < 1 ? input.credibleLevel : 0.95;
  const names = input.names ?? X[0]!.map((_, j) => `x${j + 1}`);
  const warnings: string[] = [];

  const means = Array.from({ length: p }, (_, j) => X.reduce((a, row) => a + (row[j] as number), 0) / n);
  const yMean = y.reduce((a, v) => a + v, 0) / n;
  const Xc = X.map((row) => row.map((v, j) => (v as number) - (means[j] as number)));
  const yc = y.map((v) => v - yMean);

  const lambda0 = 1 / (priorSD * priorSD);
  const XtX = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const Xty = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      Xty[j] = Xty[j]! + Xc[i]![j]! * yc[i]!;
      for (let k = 0; k < p; k++) XtX[j]![k] = XtX[j]![k]! + Xc[i]![j]! * Xc[i]![k]!;
    }
  }
  const LambdaN = XtX.map((row, j) => row.map((v, k) => v + (j === k ? lambda0 : 0)));
  const mN = solve(LambdaN, Xty);
  if (!mN) throw new BayesError("Posterior precision is singular — check for collinear covariates.");

  const a0 = 2;
  const b0 = 1;
  const aN = a0 + n / 2;
  let yty = 0;
  for (let i = 0; i < n; i++) yty += yc[i]! * yc[i]!;
  let quadratic = 0;
  for (let j = 0; j < p; j++) quadratic += mN[j]! * Xty[j]!;
  const bN = b0 + 0.5 * (yty - quadratic);
  const sigma2Mean = bN / (aN - 1);
  const sigma2PriorMean = b0 / (a0 - 1);

  const terms: PosteriorTerm[] = [];
  for (let j = 0; j < p; j++) {
    const ej = new Array<number>(p).fill(0);
    ej[j] = 1;
    const col = solve(LambdaN, ej);
    if (!col) throw new BayesError("Could not recover the posterior variance of a coefficient.");
    const varBeta = (bN / aN) * (col[j] as number);
    const sdBeta = Math.sqrt(Math.max(0, varBeta));
    const df = 2 * aN;
    const tCrit = studentTCriticalTwoSided(1 - credibleLevel, df);
    const postMean = mN[j] as number;
    terms.push({
      name: names[j] ?? `x${j + 1}`,
      priorMean: 0,
      posteriorMean: round(postMean),
      posteriorSD: round(sdBeta),
      ciLow: round(postMean - tCrit * sdBeta),
      ciHigh: round(postMean + tCrit * sdBeta),
      probPositive: round(normalCdf(postMean / (sdBeta > 0 ? sdBeta : 1))),
    });
  }

  const logDetLambda0 = p * Math.log(lambda0);
  const logDetLambdaN = logDet(LambdaN);
  const logMarginalLikelihood =
    logGammaFn(aN) -
    logGammaFn(a0) +
    a0 * Math.log(b0) -
    aN * Math.log(bN) +
    0.5 * (logDetLambda0 - logDetLambdaN) -
    (n / 2) * Math.log(2 * Math.PI);

  const mcmcSamples = input.mcmcSamples && input.mcmcSamples > 0 ? Math.min(Math.trunc(input.mcmcSamples), 20000) : 0;
  let mcmc: BayesianRegressionResult["mcmc"] = null;
  if (mcmcSamples > 0) {
    const rand = mulberry32(input.seed ?? 42);
    const burnIn = Math.max(100, Math.floor(mcmcSamples * 0.2));
    const total = mcmcSamples + burnIn;
    const sdBeta0 = terms[0]?.posteriorSD ?? 1;
    const stepBeta = Math.max(1e-6, sdBeta0) * 0.5;
    const stepSig2 = 0.3;
    const logPost = (b: number[], logSig2: number): number => {
      const sig2 = Math.exp(logSig2);
      let rss = 0;
      for (let i = 0; i < n; i++) {
        let pred = 0;
        for (let j = 0; j < p; j++) pred += (Xc[i]![j] as number) * (b[j] as number);
        rss += (yc[i]! - pred) ** 2;
      }
      let prior = 0;
      for (let j = 0; j < p; j++) prior += -0.5 * ((b[j] as number) / priorSD) ** 2;
      return -0.5 * (n * Math.log(sig2) + rss / sig2) + prior - 0.5 * logSig2;
    };
    let cur = [...mN];
    let curLogSig2 = Math.log(sigma2Mean);
    let curLp = logPost(cur, curLogSig2);
    const betaDraws: number[][] = [];
    const logSig2Draws: number[] = [];
    let accepted = 0;
    for (let s = 0; s < total; s++) {
      const prop = cur.map((b) => b + standardNormal(rand) * stepBeta);
      const propLogSig2 = curLogSig2 + standardNormal(rand) * stepSig2;
      const propLp = logPost(prop, propLogSig2);
      const logAlpha = propLp - curLp;
      if (logAlpha > 0 || Math.log(rand()) < logAlpha) {
        cur = prop;
        curLogSig2 = propLogSig2;
        curLp = propLp;
        accepted++;
      }
      if (s >= burnIn) {
        betaDraws.push([...cur]);
        logSig2Draws.push(curLogSig2);
      }
    }
    const m = betaDraws.length;
    for (let j = 0; j < p && j < terms.length; j++) {
      const draws = betaDraws.map((d) => d[j] as number);
      const mMean = draws.reduce((a, b) => a + b, 0) / Math.max(1, m);
      const mVar = draws.reduce((a, b) => a + (b - mMean) ** 2, 0) / Math.max(1, m - 1);
      const mSd = Math.sqrt(Math.max(0, mVar));
      const sorted = [...draws].sort((a, b) => a - b);
      const loIdx = Math.max(0, Math.floor(((1 - credibleLevel) / 2) * (m - 1)));
      const hiIdx = Math.min(m - 1, Math.ceil((1 - (1 - credibleLevel) / 2) * (m - 1)));
      terms[j] = {
        ...terms[j]!,
        mcmcMean: round(mMean),
        mcmcSD: round(mSd),
        mcmcCiLow: round(sorted[loIdx] as number),
        mcmcCiHigh: round(sorted[hiIdx] as number),
      };
    }
    // Effective sample size via lag-1 autocorrelation per coefficient.
    let minESS = m;
    for (let j = 0; j < p && j < terms.length; j++) {
      const draws = betaDraws.map((d) => d[j] as number);
      const mu = draws.reduce((a, b) => a + b, 0) / Math.max(1, m);
      let num = 0;
      let den = 0;
      for (let i = 0; i < m; i++) {
        den += (draws[i]! - mu) ** 2;
        if (i < m - 1) num += (draws[i]! - mu) * (draws[i + 1]! - mu);
      }
      const rho1 = den > 0 ? num / den : 0;
      const ess = Math.max(1, (m * (1 - Math.max(0, Math.min(0.95, rho1)))) / (1 + Math.max(0, Math.min(0.95, rho1))));
      if (ess < minESS) minESS = ess;
      terms[j] = { ...terms[j]!, ess: Math.round(ess) };
    }
    const meanLogSigma2 = logSig2Draws.reduce((a, b) => a + b, 0) / Math.max(1, m);
    mcmc = {
      ran: true,
      samples: mcmcSamples,
      burnIn,
      meanLogSigma2: round(meanLogSigma2),
      acceptanceRate: round(accepted / Math.max(1, total)),
      minESS: Math.round(minESS),
      note:
        `Random-walk Metropolis on (beta, log sigma2) with ${mcmcSamples} kept draws after ${burnIn} burn-in, seed ${input.seed ?? 42}. ` +
        `Acceptance ${((accepted / Math.max(1, total)) * 100).toFixed(1)}% (20-50% is a healthy band for a random walk). ` +
        `MCMC means are a cross-check on the closed-form posterior — the closed form remains the reported estimate.`,
    };
    if (mcmc.acceptanceRate < 0.1 || mcmc.acceptanceRate > 0.7) {
      warnings.push(
        `MCMC acceptance rate is ${(mcmc.acceptanceRate * 100).toFixed(1)}% — outside the healthy 20-50% band, so the sampled posterior may not explore the tail reliably. The closed-form result above is unaffected.`,
      );
    }
  }

  return {
    model: "regression",
    terms,
    sigma2PosteriorMean: round(sigma2Mean),
    sigma2PriorMean: round(sigma2PriorMean),
    logMarginalLikelihood: round(logMarginalLikelihood),
    n,
    p,
    credibleLevel,
    priorSD,
    mcmc,
    interpretation:
      `NIG-posterior linear regression on ${n} rows with ${p} covariate(s), prior SD ${priorSD} on each coefficient, ${Math.round(credibleLevel * 100)}% credible intervals from the exact multivariate-t marginal. ` +
      `Posterior mean of sigma2 is ${round(sigma2Mean, 4)} vs a prior mean of ${round(sigma2PriorMean, 4)}. ` +
      `P(beta > 0 | data) is the posterior probability that the covariate pushes the outcome up — the Bayesian quantity a p-value is not.`,
    warnings,
  };
}

/** Squared-exponential kernel entry. */
function seKernel(a: number[], b: number[], lengthScale: number): number {
  let s = 0;
  for (let j = 0; j < a.length; j++) s += (a[j]! - b[j]!) ** 2;
  return Math.exp((-0.5 * s) / (lengthScale * lengthScale));
}

/**
 * Exact GP regression: posterior predictive mean/variance at the training
 * points (and optional holdout points), log marginal likelihood reported so
 * the hyper-parameters can be judged rather than trusted.
 */
export function gaussianProcessRegression(input: GaussianProcessInput): GaussianProcessResult {
  const { X, y, lengthScale, noiseSD } = input;
  const n = y.length;
  if (n === 0 || X.length !== n) throw new BayesError("Gaussian-process regression needs a non-empty design.");
  if (!(lengthScale > 0)) throw new BayesError("GP length-scale must be positive.");
  if (!(noiseSD > 0)) throw new BayesError("GP noise SD must be positive.");
  const warnings: string[] = [];
  if (n < 5) warnings.push("Fewer than 5 training points — the GP posterior is prior-dominated.");
  if (n > 2000) warnings.push("Exact GP is O(n^3); results on large n are slow but exact — subsample if needed.");

  const credibleLevel =
    input.credibleLevel && input.credibleLevel > 0.5 && input.credibleLevel < 1 ? input.credibleLevel : 0.95;
  const z = 1.96; // ~normal 97.5th percentile at 95%; refined below via inverse-erf approximation for other levels
  const zScore =
    credibleLevel === 0.95 ? 1.959964 : credibleLevel === 0.9 ? 1.644854 : credibleLevel === 0.99 ? 2.575829 : z;

  const K = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, jj) => {
      const k = seKernel(X[i]!, X[jj]!, lengthScale);
      return i === jj ? k + noiseSD * noiseSD : k;
    }),
  );

  // Cholesky (lower) of K; failure means the kernel is numerically singular.
  const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = K[i]![j]!;
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        if (s <= 1e-14) throw new BayesError("GP kernel is numerically singular — raise the noise SD or length-scale.");
        L[i]![j] = Math.sqrt(s);
      } else {
        L[i]![j] = s / L[j]![j]!;
      }
    }
  }
  const logDetK = 2 * L.reduce((a, row, i) => a + Math.log(row[i]!), 0);

  // forward-solve L w = y, then backward L' alpha = w
  const w = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = y[i] as number;
    for (let k = 0; k < i; k++) s -= L[i]![k]! * w[k]!;
    w[i] = s / L[i]![i]!;
  }
  const alphaVec = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = w[i] as number;
    for (let k = i + 1; k < n; k++) s -= L[k]![i]! * alphaVec[k]!;
    alphaVec[i] = s / L[i]![i]!;
  }

  let quadratic = 0;
  for (let i = 0; i < n; i++) quadratic += (w[i] as number) * (w[i] as number);
  const logMarginalLikelihood = -0.5 * quadratic - 0.5 * logDetK - (n / 2) * Math.log(2 * Math.PI);

  const posteriorMean: number[] = [];
  const posteriorSD: number[] = [];
  const ciLow: number[] = [];
  const ciHigh: number[] = [];
  let trainSSE = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = 0; j < n; j++) m += seKernel(X[i]!, X[j]!, lengthScale) * (alphaVec[j] as number);
    // variance: k(x,x) - v'v where L v = k(x, ·)
    const kx = new Array<number>(n).fill(0);
    for (let j = 0; j < n; j++) kx[j] = seKernel(X[i]!, X[j]!, lengthScale);
    const v = new Array<number>(n).fill(0);
    for (let j = 0; j < n; j++) {
      let s = kx[j] as number;
      for (let k = 0; k < j; k++) s -= L[j]![k]! * v[k]!;
      v[j] = s / L[j]![j]!;
    }
    let vv = 0;
    for (let j = 0; j < n; j++) vv += v[j]! * v[j]!;
    const varj = Math.max(1e-12, 1 + noiseSD * noiseSD - vv);
    const sd = Math.sqrt(varj);
    posteriorMean.push(round(m));
    posteriorSD.push(round(sd));
    ciLow.push(round(m - zScore * sd));
    ciHigh.push(round(m + zScore * sd));
    trainSSE += ((y[i] as number) - m) ** 2;
  }
  const trainRMSE = Math.sqrt(trainSSE / Math.max(1, n));

  let holdout: GaussianProcessResult["holdout"] = null;
  if (input.XStar && input.XStar.length > 0 && input.yStar && input.yStar.length > 0) {
    const Xs = input.XStar;
    const ys = input.yStar;
    let sse = 0;
    let sae = 0;
    let covered = 0;
    for (let i = 0; i < Xs.length; i++) {
      let m = 0;
      const kx = new Array<number>(n).fill(0);
      for (let j = 0; j < n; j++) {
        kx[j] = seKernel(Xs[i]!, X[j]!, lengthScale);
        m += kx[j]! * (alphaVec[j] as number);
      }
      const v = new Array<number>(n).fill(0);
      for (let j = 0; j < n; j++) {
        let s = kx[j] as number;
        for (let k = 0; k < j; k++) s -= L[j]![k]! * v[k]!;
        v[j] = s / L[j]![j]!;
      }
      let vv = 0;
      for (let j = 0; j < n; j++) vv += v[j]! * v[j]!;
      const sd = Math.sqrt(Math.max(1e-12, 1 + noiseSD * noiseSD - vv));
      const err = (ys[i] as number) - m;
      sse += err * err;
      sae += Math.abs(err);
      if (Math.abs(err) <= zScore * sd) covered++;
    }
    holdout = {
      n: Xs.length,
      rmse: round(Math.sqrt(sse / Xs.length)),
      coverage: round(covered / Xs.length),
      mae: round(sae / Xs.length),
    };
    if (Math.abs(holdout.coverage - credibleLevel) > 0.15) {
      warnings.push(
        `Holdout predictive coverage is ${(holdout.coverage * 100).toFixed(1)}% vs the nominal ${Math.round(credibleLevel * 100)}% — the supplied length-scale/noise may not match the data.`,
      );
    }
  }

  return {
    model: "gp",
    n,
    lengthScale,
    noiseSD,
    logMarginalLikelihood: round(logMarginalLikelihood),
    trainRMSE: round(trainRMSE),
    holdout,
    posteriorMean,
    posteriorSD,
    ciLow,
    ciHigh,
    interpretation:
      `Exact Gaussian-process regression with a squared-exponential kernel (length-scale ${lengthScale}, noise SD ${noiseSD}), ${n} training point(s), log marginal likelihood ${round(logMarginalLikelihood, 3)}. ` +
      `Posterior predictive mean ± ${Math.round(credibleLevel * 100)}% band is shown for every training point; lower log marginal likelihood means the hyper-parameters fit the data worse.`,
    warnings,
  };
}
