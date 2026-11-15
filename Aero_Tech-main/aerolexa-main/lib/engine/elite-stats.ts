/**
 * Elite statistics engine — the layer above `stats.ts`/`hypothesis.ts`.
 *
 * Every function here is a real estimator computed from the caller's data with
 * hand-verifiable closed forms or numerically exact special functions already
 * oracle-tested in this repo (normalCdf / studentTPValue / variance in
 * stats.ts; logGamma / regularizedGammaQ in hypothesis.ts). No sampling, no
 * fake RNG: where a classical test needs a distribution tail we evaluate the
 * tail exactly.
 *
 * Contents
 * --------
 *  Effect sizes   cohensD (+ Hedges' g), cliffsDelta, cramersV, cohensKappa
 *  Nonparametric  mannWhitneyU, wilcoxonSignedRank, kruskalWallis
 *  Multiplicity   bonferroni, holm, benjaminiHochberg
 *  GLM            fitLogistic, fitPoisson (IRLS + Wald inference)
 *  Survival       kaplanMeier (Greenwood SE), logRankTest
 *
 * Conventions: non-finite inputs are dropped pairwise/groupwise (the repo's
 * `cleanFinite` policy). Caller mistakes throw StatsError; degenerate data
 * yields NaN fields — never a silent 0.
 */

import { logGamma, regularizedGammaQ } from "@/lib/engine/hypothesis";
import { cleanFinite, isFiniteNumber, mean, normalCdf, variance } from "@/lib/engine/stats";

export class StatsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatsError";
  }
}

function round(v: number): number {
  if (!Number.isFinite(v)) return v;
  return Math.round(v * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Effect sizes
// ---------------------------------------------------------------------------

export type EffectKind = "cohens-d" | "cliffs-delta" | "cramers-v" | "cohens-kappa";

export interface EffectSizeResult {
  value: number;
  kind: EffectKind;
  magnitude: "negligible" | "small" | "medium" | "large";
  n: number;
}

export interface StandardizedEffect extends EffectSizeResult {
  /** Hedges' g — d with the small-sample bias correction J = 1 − 3/(4·df−1). */
  g: number;
}

function magnitudeBand(kind: EffectKind, abs: number): EffectSizeResult["magnitude"] {
  if (kind === "cliffs-delta") {
    // Romano et al. (2006) thresholds for δ.
    if (abs < 0.147) return "negligible";
    if (abs < 0.33) return "small";
    if (abs < 0.474) return "medium";
    return "large";
  }
  // Cohen's bands for d; 0.1/0.3/0.5 for V and κ.
  if (abs < 0.1) return "negligible";
  if (abs < 0.3) return "small";
  if (abs < 0.5) return "medium";
  return "large";
}

/**
 * Cohen's d with Hedges' g correction for two independent samples. d uses the
 * pooled SD (n−1 weighting); g multiplies by J = 1 − 3/(4·df − 1) so g < d,
 * converging as n grows. Equal SDs ⇒ g is unbiased for the standardized mean
 * difference.
 */
export function cohensD(a: number[], b: number[]): StandardizedEffect {
  const x = cleanFinite(a);
  const y = cleanFinite(b);
  if (x.length < 2 || y.length < 2) throw new StatsError("Effect size needs at least two finite values per group.");
  const df = x.length + y.length - 2;
  const sPooled = Math.sqrt(((x.length - 1) * variance(x) + (y.length - 1) * variance(y)) / df);
  const d = sPooled === 0 ? Number.NaN : (mean(x) - mean(y)) / sPooled;
  const g = d * (1 - 3 / (4 * df - 1));
  return {
    value: round(d),
    g: round(g),
    kind: "cohens-d",
    magnitude: Number.isFinite(d) ? magnitudeBand("cohens-d", Math.abs(d)) : "negligible",
    n: x.length + y.length,
  };
}

/**
 * Cliff's δ — nonparametric dominance: (#{x>y} − #{x<y}) / (m·n).
 * δ = +1 every x exceeds every y; 0 stochastic equality; −1 the reverse.
 */
export function cliffsDelta(a: number[], b: number[]): EffectSizeResult {
  const x = cleanFinite(a);
  const y = cleanFinite(b);
  if (x.length === 0 || y.length === 0)
    throw new StatsError("Cliff's delta needs at least one finite value per group.");
  let greater = 0;
  let less = 0;
  for (const xv of x) {
    for (const yv of y) {
      if (xv > yv) greater++;
      else if (xv < yv) less++;
    }
  }
  const delta = (greater - less) / (x.length * y.length);
  return {
    value: round(delta),
    kind: "cliffs-delta",
    magnitude: magnitudeBand("cliffs-delta", Math.abs(delta)),
    n: x.length + y.length,
  };
}

/**
 * Cramér's V — χ²-normalized association for an r×c table, in [0, 1].
 * `corrected` applies the Bergsma (2013) bias correction for small samples.
 */
export function cramersV(table: number[][], corrected = false): EffectSizeResult {
  const rows = table.length;
  const cols = table[0]?.length ?? 0;
  if (rows < 2 || cols < 2 || table.some((r) => r.length !== cols)) {
    throw new StatsError("Cramér's V needs a rectangular table with at least 2 rows and 2 columns.");
  }
  const rowTotals = table.map((r) => r.reduce((s, v) => s + v, 0));
  const colTotals = Array.from({ length: cols }, (_, c) => table.reduce((s, r) => s + (r[c] ?? 0), 0));
  const total = rowTotals.reduce((s, v) => s + v, 0);
  if (total <= 0) throw new StatsError("Cramér's V table must contain at least one count.");
  let chi2 = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const expected = (rowTotals[r]! * colTotals[c]!) / total;
      if (expected > 0) chi2 += ((table[r]![c] ?? 0) - expected) ** 2 / expected;
    }
  }
  if (!corrected) {
    const v = Math.sqrt(chi2 / (total * (Math.min(rows, cols) - 1)));
    return { value: round(v), kind: "cramers-v", magnitude: magnitudeBand("cramers-v", v), n: total };
  }
  // Bergsma bias correction: φ²̂_corrected and corrected dimensions.
  const phi2 = Math.max(0, chi2 / total - ((rows - 1) * (cols - 1)) / (total - 1));
  const rC = rows - (rows - 1) ** 2 / (total - 1);
  const cC = cols - (cols - 1) ** 2 / (total - 1);
  const kC = Math.max(2, Math.min(rC, cC));
  const denom = (kC - 1) * (total - 1);
  const v = denom > 0 ? Math.sqrt(phi2 / denom) : Number.NaN;
  return {
    value: round(v),
    kind: "cramers-v",
    magnitude: Number.isFinite(v) ? magnitudeBand("cramers-v", v) : "negligible",
    n: total,
  };
}

/**
 * Cohen's κ — chance-corrected agreement between two raters over the same
 * label set. κ = 1 perfect, 0 chance-level, negative worse than chance.
 */
export function cohensKappa(table: number[][]): EffectSizeResult {
  const rows = table.length;
  const cols = table[0]?.length ?? 0;
  if (rows < 2 || cols < 2) throw new StatsError("Cohen's kappa needs a 2-dimensional agreement table.");
  const rowTotals = table.map((r) => r.reduce((s, v) => s + v, 0));
  const colTotals = Array.from({ length: cols }, (_, c) => table.reduce((s, r) => s + (r[c] ?? 0), 0));
  const total = rowTotals.reduce((s, v) => s + v, 0);
  if (total <= 0) throw new StatsError("Kappa table must contain at least one count.");
  let observed = 0;
  for (let i = 0; i < Math.min(rows, cols); i++) observed += table[i]?.[i] ?? 0;
  const po = observed / total;
  let pe = 0;
  for (let i = 0; i < Math.min(rows, cols); i++) pe += (rowTotals[i]! / total) * (colTotals[i]! / total);
  const kappa = pe >= 1 ? Number.NaN : (po - pe) / (1 - pe);
  return {
    value: round(kappa),
    kind: "cohens-kappa",
    magnitude: Number.isFinite(kappa) ? magnitudeBand("cohens-kappa", Math.abs(kappa)) : "negligible",
    n: total,
  };
}

// ---------------------------------------------------------------------------
// Nonparametric tests
// ---------------------------------------------------------------------------

export interface NonparametricResult {
  statistic: number;
  pValue: number;
  method: "mann-whitney-u" | "wilcoxon-signed-rank" | "kruskal-wallis";
  n: number;
  interpretation: string;
}

/** Average ranks over a sorted tagged sample; returns Σt³−t tie correction. */
function averageRanks<T>(tagged: { v: number; tag: T }[]): { ranks: number[]; tieSum: number } {
  const sorted = tagged.map((t, i) => ({ ...t, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(tagged.length).fill(0);
  let tieSum = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.v === sorted[i]!.v) j++;
    const t = j - i + 1;
    const avg = (i + j + 2) / 2; // 1-based average rank
    if (t > 1) tieSum += t ** 3 - t;
    for (let k = i; k <= j; k++) ranks[sorted[k]!.i] = avg;
    i = j + 1;
  }
  return { ranks, tieSum };
}

/**
 * Mann–Whitney U (Wilcoxon rank-sum) with the tie-corrected, continuity-
 * corrected normal approximation — the scipy.stats.mannwhitneyu asymptotic
 * default. `statistic` is U for the FIRST sample.
 */
export function mannWhitneyU(a: number[], b: number[]): NonparametricResult {
  const x = cleanFinite(a);
  const y = cleanFinite(b);
  if (x.length === 0 || y.length === 0) throw new StatsError("Mann–Whitney needs at least one finite value per group.");
  const n1 = x.length;
  const n2 = y.length;
  const tagged = [...x.map((v) => ({ v, tag: 0 as const })), ...y.map((v) => ({ v, tag: 1 as const }))];
  const { ranks, tieSum } = averageRanks(tagged);
  const r1 = ranks.reduce((s, r, i) => (tagged[i]!.tag === 0 ? s + r : s), 0);
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const muU = (n1 * n2) / 2;
  const sigmaU = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieSum / (n * (n - 1))));
  // Continuity-corrected two-sided z (scipy convention: |U − μ| − 0.5),
  // clamped at 0: when |U − μ| ≤ 0.5 the correction must not INVERT the
  // statistic (identical samples would otherwise get p < 1).
  const rawZ = sigmaU === 0 ? 0 : (Math.abs(u1 - muU) - 0.5) / sigmaU;
  const z = Math.max(0, rawZ);
  const p = Math.min(1, Math.max(0, 2 * (1 - normalCdf(z))));
  return {
    statistic: round(u1),
    pValue: p,
    method: "mann-whitney-u",
    n,
    interpretation:
      p < 0.05
        ? `The two samples' distributions differ (U = ${round(u1)}, p = ${round(p)}) — compare medians, not means.`
        : `No evidence the two samples' distributions differ (U = ${round(u1)}, p = ${round(p)}).`,
  };
}

/**
 * Wilcoxon signed-rank test on PAIRED samples (normal approximation with tie
 * + continuity corrections — scipy's `wilcoxon` default). Zero differences
 * are dropped; needs ≥ 6 surviving pairs for the approximation.
 */
export function wilcoxonSignedRank(before: number[], after: number[]): NonparametricResult {
  const diffs: number[] = [];
  const len = Math.min(before.length, after.length);
  for (let i = 0; i < len; i++) {
    const b = before[i];
    const a = after[i];
    if (isFiniteNumber(b) && isFiniteNumber(a) && a !== b) diffs.push(a - b);
  }
  const n = diffs.length;
  if (n < 6) throw new StatsError("Wilcoxon signed-rank needs at least 6 non-zero paired differences.");
  const { ranks, tieSum } = averageRanks(diffs.map((d, i) => ({ v: Math.abs(d), tag: i })));
  let wPlus = 0;
  let wMinus = 0;
  for (let k = 0; k < n; k++) {
    if (diffs[k]! > 0) wPlus += ranks[k]!;
    else wMinus += ranks[k]!;
  }
  const w = Math.min(wPlus, wMinus);
  const muW = (n * (n + 1)) / 4;
  // σ² can go negative when a single tie group dominates (near-degenerate
  // data); floor at 0 — zero rank variance carries no normal-approx evidence.
  const sigmaW = Math.sqrt(Math.max(0, (n * (n + 1) * (2 * n + 1)) / 24 - tieSum / 2));
  // Small n: exact two-sided p by full enumeration of the 2^n sign patterns
  // (the classical Wilcoxon exact test). The normal approximation collapses
  // exactly in the degenerate cases users actually hit (all differences one
  // sign, one dominant tie group), so exact beats approximate whenever it is
  // cheap. n ≤ 17 → ≤ 131,072 patterns.
  if (n <= 17) {
    const ranksAbs = ranks;
    let countLE = 0;
    const total = 2 ** n;
    for (let pattern = 0; pattern < total; pattern++) {
      let wPlusP = 0;
      for (let k = 0; k < n; k++) if ((pattern >> k) & 1) wPlusP += ranksAbs[k]!;
      if (wPlusP <= w) countLE++;
    }
    const pExact = Math.min(1, (2 * countLE) / total);
    return {
      statistic: round(w),
      pValue: pExact,
      method: "wilcoxon-signed-rank",
      n,
      interpretation:
        pExact < 0.05
          ? `The paired shift is statistically significant (W = ${round(w)}, exact p = ${round(pExact)}); median difference ${round(mean(diffs))}.`
          : `No significant paired shift (W = ${round(w)}, exact p = ${round(pExact)}).`,
    };
  }
  const rawZ = sigmaW === 0 ? 0 : (Math.abs(w - muW) - 0.5) / sigmaW;
  const z = Math.max(0, rawZ);
  const p = Math.min(1, Math.max(0, 2 * (1 - normalCdf(z))));
  return {
    statistic: round(w),
    pValue: p,
    method: "wilcoxon-signed-rank",
    n,
    interpretation:
      p < 0.05
        ? `The paired shift is statistically significant (W = ${round(w)}, p = ${round(p)}); median difference ${round(mean(diffs))}.`
        : `No significant paired shift (W = ${round(w)}, p = ${round(p)}).`,
  };
}

/**
 * Kruskal–Wallis H across ≥ 2 groups — rank-based ANOVA. Tie-corrected H with
 * the exact χ²(k−1) tail via the repo's regularizedGammaQ.
 */
export function kruskalWallis(groups: number[][]): NonparametricResult & { df: number } {
  const clean = groups.map((g) => cleanFinite(g));
  if (clean.length < 2) throw new StatsError("Kruskal–Wallis needs at least two groups.");
  if (clean.some((g) => g.length === 0)) throw new StatsError("Every group needs at least one finite value.");
  const tagged = clean.flatMap((g, gi) => g.map((v) => ({ v, tag: gi })));
  const { ranks, tieSum } = averageRanks(tagged);
  const n = tagged.length;
  const rankSums = clean.map(() => 0);
  tagged.forEach((p, idx) => (rankSums[p.tag] = (rankSums[p.tag] ?? 0) + ranks[idx]!));
  let h = 0;
  for (let gi = 0; gi < clean.length; gi++) h += (rankSums[gi]! * rankSums[gi]!) / clean[gi]!.length;
  h = (12 / (n * (n + 1))) * h - 3 * (n + 1);
  const tieCorrection = 1 - tieSum / (n ** 3 - n);
  if (tieCorrection > 0) h /= tieCorrection;
  const df = clean.length - 1;
  const p = regularizedGammaQ(df / 2, h / 2);
  return {
    statistic: round(h),
    pValue: p,
    df,
    method: "kruskal-wallis",
    n,
    interpretation:
      p < 0.05
        ? "At least one group's distribution differs — follow up with pairwise Mann–Whitney plus a Holm correction."
        : "No evidence the group distributions differ.",
  };
}

// ---------------------------------------------------------------------------
// Multiple-testing corrections
// ---------------------------------------------------------------------------

export interface AdjustedP {
  label: string;
  pValue: number;
  adjusted: number;
  significant: boolean;
}

function finish(ps: Omit<AdjustedP, "significant">[], alpha: number): AdjustedP[] {
  return ps.map((r) => ({ ...r, significant: r.adjusted < alpha }));
}

/** Bonferroni: p·m capped at 1 — the most conservative FWER control. */
export function bonferroni(ps: { label: string; pValue: number }[], alpha = 0.05): AdjustedP[] {
  if (ps.some((r) => !Number.isFinite(r.pValue) || r.pValue < 0 || r.pValue > 1)) {
    throw new StatsError("p-values must be finite and within [0, 1].");
  }
  const m = ps.length;
  if (m === 0) return [];
  return finish(
    ps.map((r) => ({ label: r.label, pValue: r.pValue, adjusted: Math.min(1, r.pValue * m) })),
    alpha,
  );
}

/** Holm–Bonferroni step-down: FWER control, uniformly more power than Bonferroni. */
export function holm(ps: { label: string; pValue: number }[], alpha = 0.05): AdjustedP[] {
  if (ps.some((r) => !Number.isFinite(r.pValue) || r.pValue < 0 || r.pValue > 1)) {
    throw new StatsError("p-values must be finite and within [0, 1].");
  }
  const m = ps.length;
  if (m === 0) return [];
  const order = ps.map((r, i) => ({ ...r, i })).sort((a, b) => a.pValue - b.pValue);
  let runningMax = 0;
  const out = new Array<AdjustedP>(m);
  for (let j = 0; j < m; j++) {
    const row = order[j]!;
    runningMax = Math.max(runningMax, (m - j) * row.pValue);
    out[row.i] = { label: row.label, pValue: row.pValue, adjusted: Math.min(1, runningMax), significant: false };
  }
  return finish(out, alpha);
}

/** Benjamini–Hochberg step-up: controls the false discovery rate (FDR). */
export function benjaminiHochberg(ps: { label: string; pValue: number }[], alpha = 0.05): AdjustedP[] {
  if (ps.some((r) => !Number.isFinite(r.pValue) || r.pValue < 0 || r.pValue > 1)) {
    throw new StatsError("p-values must be finite and within [0, 1].");
  }
  const m = ps.length;
  if (m === 0) return [];
  const order = ps.map((r, i) => ({ ...r, i })).sort((a, b) => a.pValue - b.pValue);
  let runningMin = 1;
  const out = new Array<AdjustedP>(m);
  for (let j = m - 1; j >= 0; j--) {
    const row = order[j]!;
    runningMin = Math.min(runningMin, (m / (j + 1)) * row.pValue);
    out[row.i] = { label: row.label, pValue: row.pValue, adjusted: Math.min(1, runningMin), significant: false };
  }
  return finish(out, alpha);
}

// ---------------------------------------------------------------------------
// GLM: logistic & Poisson regression via IRLS with Wald inference
// ---------------------------------------------------------------------------

export interface GlmDesign {
  /** Feature matrix WITHOUT intercept (n × p), fully finite. */
  X: number[][];
  /** Response: 0/1 for binomial; non-negative integers for Poisson. */
  y: number[];
  featureNames?: string[];
}

export interface GlmCoefficient {
  name: string;
  coefficient: number;
  standardError: number;
  z: number;
  pValue: number;
  /** exp(β) — a odds ratio (binomial) or rate ratio (Poisson). */
  expBeta: number;
}

export interface GlmFit {
  family: "binomial" | "poisson";
  coefficients: GlmCoefficient[];
  logLik: number;
  aic: number;
  nullDeviance: number;
  residualDeviance: number;
  n: number;
  converged: boolean;
  iterations: number;
  interpretation: string;
}

function withIntercept(X: number[][]): number[][] {
  return X.map((row) => [1, ...row]);
}

function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const d = M[col]![col]!;
    for (let c = col; c <= n; c++) M[col]![c] = (M[col]![c] as number) / d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c] = (M[r]![c] as number) - f * (M[col]![c] as number);
    }
  }
  return M.map((row) => row[n] as number);
}

/** Matrix inverse via Gauss–Jordan; null when singular. */
function invert(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const d = M[col]![col]!;
    for (let c = 0; c < 2 * n; c++) M[col]![c] = (M[col]![c] as number) / d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c++) M[r]![c] = (M[r]![c] as number) - f * (M[col]![c] as number);
    }
  }
  return M.map((row) => row.slice(n));
}

/**
 * Logistic regression (binomial GLM, logit link) via IRLS. Ridge `l2`
 * (default 1e-8) stabilizes perfectly-separated data; inference uses the
 * UNpenalized observed information Xᵀ diag(μ(1−μ)) X. Wald z with exact
 * normal p-values. Honest labelling: association, not causation.
 */
export function fitLogistic(design: GlmDesign, opts: { maxIter?: number; tol?: number; l2?: number } = {}): GlmFit {
  const { X: X0, y } = design;
  const n = y.length;
  const p = X0[0]?.length ?? 0;
  if (n === 0 || p === 0) throw new StatsError("Logistic regression needs rows with features and a 0/1 response.");
  if (!X0.every((row) => row.length === p && row.every(isFiniteNumber)))
    throw new StatsError("The feature matrix must be fully finite.");
  if (!y.every((v) => v === 0 || v === 1)) throw new StatsError("Logistic regression needs a 0/1 response.");
  if (new Set(y).size < 2) throw new StatsError("The response is constant — the model is unidentified.");
  const X = withIntercept(X0);
  const m = p + 1;
  const maxIter = opts.maxIter ?? 100;
  const tol = opts.tol ?? 1e-10;
  const l2 = opts.l2 ?? 1e-8;

  let beta = new Array<number>(m).fill(0);
  let converged = false;
  let iter = 0;
  for (; iter < maxIter; iter++) {
    const eta = X.map((row) => row.reduce((s, x, j) => s + x * (beta[j] as number), 0));
    const mu = eta.map(sigmoid);
    const w = mu.map((v) => Math.max(1e-10, v * (1 - v)));
    const zResp = eta.map((e, i) => e + ((y[i] as number) - (mu[i] as number)) / (w[i] as number));
    const XtWX: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
    const XtWz: number[] = new Array<number>(m).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i] as number[];
      for (let a = 0; a < m; a++) {
        if (xi[a] === 0) continue;
        XtWz[a]! += xi[a]! * (w[i] as number) * (zResp[i] as number);
        for (let b = a; b < m; b++) XtWX[a]![b] = (XtWX[a]![b] ?? 0) + xi[a]! * (w[i] as number) * (xi[b] as number);
      }
    }
    for (let a = 0; a < m; a++) {
      XtWX[a]![a] = (XtWX[a]![a] ?? 0) + l2;
      for (let b = 0; b < a; b++) XtWX[a]![b] = XtWX[b]![a]!;
    }
    const next = solveLinear(XtWX, XtWz);
    if (!next) break;
    const delta = Math.max(...next.map((v, j) => Math.abs(v - (beta[j] as number))));
    beta = next;
    if (delta < tol) {
      converged = true;
      iter++;
      break;
    }
  }

  const eta = X.map((row) => row.reduce((s, x, j) => s + x * (beta[j] as number), 0));
  const mu = eta.map(sigmoid);
  const info: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < n; i++) {
    const w = Math.max(1e-10, (mu[i] as number) * (1 - (mu[i] as number)));
    const xi = X[i] as number[];
    for (let a = 0; a < m; a++)
      for (let b = a; b < m; b++) info[a]![b] = (info[a]![b] ?? 0) + xi[a]! * w * (xi[b] as number);
  }
  for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) info[a]![b] = info[b]![a]!;
  const cov = invert(info);
  const names = ["(intercept)", ...(design.featureNames ?? Array.from({ length: p }, (_, j) => `x${j + 1}`))];
  const coefficients: GlmCoefficient[] = beta.map((b, j) => {
    const se = cov ? Math.sqrt(Math.max(0, cov[j]![j]!)) : Number.NaN;
    const z = Number.isFinite(se) && se > 0 ? b / se : Number.NaN;
    const pVal = Number.isFinite(z) ? 2 * (1 - normalCdf(Math.abs(z))) : Number.NaN;
    return {
      name: names[j] as string,
      coefficient: round(b),
      standardError: round(se),
      z: round(z),
      pValue: round(pVal),
      expBeta: round(Math.exp(b)),
    };
  });

  let logLik = 0;
  for (let i = 0; i < n; i++) {
    const pi = Math.min(1 - 1e-12, Math.max(1e-12, mu[i] as number));
    logLik += (y[i] as number) * Math.log(pi) + (1 - (y[i] as number)) * Math.log(1 - pi);
  }
  const p0 = Math.min(1 - 1e-12, Math.max(1e-12, mean(y)));
  const nullLogLik = y.reduce<number>((s, v) => s + v * Math.log(p0) + (1 - v) * Math.log(1 - p0), 0);
  const nullDeviance = -2 * nullLogLik;
  const residualDeviance = -2 * logLik;
  const pseudoR2 = nullDeviance > 0 ? 1 - residualDeviance / nullDeviance : 0;
  return {
    family: "binomial",
    coefficients,
    logLik: round(logLik),
    aic: round(-2 * logLik + 2 * m),
    nullDeviance: round(nullDeviance),
    residualDeviance: round(residualDeviance),
    n,
    converged,
    iterations: iter,
    interpretation:
      `Logistic regression (IRLS, ${iter} iterations${converged ? "" : ", DID NOT CONVERGE — treat SEs with care"}). ` +
      `McFadden pseudo-R² = ${round(pseudoR2)}. exp(β) is an odds ratio per unit of each feature; p-values are Wald. ` +
      `This model estimates ASSOCIATION — it is not causal evidence.`,
  };
}

/**
 * Poisson regression (log link) via IRLS for count responses. Intercept-only
 * start at log(ȳ); Wald SEs from Xᵀ diag(μ) X; exact normal p-values.
 */
export function fitPoisson(design: GlmDesign, opts: { maxIter?: number; tol?: number } = {}): GlmFit {
  const { X: X0, y } = design;
  const n = y.length;
  const p = X0[0]?.length ?? 0;
  if (n === 0 || p === 0) throw new StatsError("Poisson regression needs rows with features and a count response.");
  if (!X0.every((row) => row.length === p && row.every(isFiniteNumber)))
    throw new StatsError("The feature matrix must be fully finite.");
  if (!y.every((v) => Number.isInteger(v) && v >= 0))
    throw new StatsError("Poisson regression needs non-negative integer counts.");
  if (y.every((v) => v === 0)) throw new StatsError("All counts are zero — the model is unidentified.");
  const X = withIntercept(X0);
  const m = p + 1;
  const maxIter = opts.maxIter ?? 100;
  const tol = opts.tol ?? 1e-10;

  const beta = new Array<number>(m).fill(0);
  beta[0] = Math.log(Math.max(1e-10, mean(y)));
  let converged = false;
  let iter = 0;
  let current = [...beta];
  for (; iter < maxIter; iter++) {
    const eta = X.map((row) => row.reduce((s, x, j) => s + x * (current[j] as number), 0));
    const mu = eta.map((e) => Math.max(1e-10, Math.exp(e)));
    const zResp = eta.map((e, i) => e + ((y[i] as number) - (mu[i] as number)) / (mu[i] as number));
    const XtWX: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
    const XtWz: number[] = new Array<number>(m).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i] as number[];
      const w = mu[i] as number;
      for (let a = 0; a < m; a++) {
        if (xi[a] === 0) continue;
        XtWz[a]! += xi[a]! * w * (zResp[i] as number);
        for (let b = a; b < m; b++) XtWX[a]![b] = (XtWX[a]![b] ?? 0) + xi[a]! * w * (xi[b] as number);
      }
    }
    for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) XtWX[a]![b] = XtWX[b]![a]!;
    const next = solveLinear(XtWX, XtWz);
    if (!next) break;
    const delta = Math.max(...next.map((v, j) => Math.abs(v - (current[j] as number))));
    current = next;
    if (delta < tol) {
      converged = true;
      iter++;
      break;
    }
  }

  const eta = X.map((row) => row.reduce((s, x, j) => s + x * (current[j] as number), 0));
  const mu = eta.map((e) => Math.max(1e-10, Math.exp(e)));
  const info: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < n; i++) {
    const w = mu[i] as number;
    const xi = X[i] as number[];
    for (let a = 0; a < m; a++)
      for (let b = a; b < m; b++) info[a]![b] = (info[a]![b] ?? 0) + xi[a]! * w * (xi[b] as number);
  }
  for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) info[a]![b] = info[b]![a]!;
  const cov = invert(info);
  const names = ["(intercept)", ...(design.featureNames ?? Array.from({ length: p }, (_, j) => `x${j + 1}`))];
  const coefficients: GlmCoefficient[] = current.map((b, j) => {
    const se = cov ? Math.sqrt(Math.max(0, cov[j]![j]!)) : Number.NaN;
    const z = Number.isFinite(se) && se > 0 ? b / se : Number.NaN;
    const pVal = Number.isFinite(z) ? 2 * (1 - normalCdf(Math.abs(z))) : Number.NaN;
    return {
      name: names[j] as string,
      coefficient: round(b),
      standardError: round(se),
      z: round(z),
      pValue: round(pVal),
      expBeta: round(Math.exp(b)),
    };
  });

  // log L = Σ y·log μ − μ − log(y!)  (Stirling-free via logGamma).
  let logLik = 0;
  for (let i = 0; i < n; i++) {
    logLik += (y[i] as number) * Math.log(mu[i] as number) - (mu[i] as number) - logGamma((y[i] as number) + 1);
  }
  const mu0 = Math.max(1e-10, mean(y));
  // Deviances (the classical residuals form; y·log(y/μ) term is 0 when y = 0).
  const residualDeviance =
    2 *
    y.reduce((s, v, i) => {
      const yi = v;
      const mi = mu[i] as number;
      return s + (yi > 0 ? yi * Math.log(yi / mi) : 0) - (yi - mi);
    }, 0);
  const nullDeviance =
    2 *
    y.reduce((s, v) => {
      const yi = v;
      return s + (yi > 0 ? yi * Math.log(yi / mu0) : 0) - (yi - mu0);
    }, 0);
  return {
    family: "poisson",
    coefficients,
    logLik: round(logLik),
    aic: round(-2 * logLik + 2 * m),
    nullDeviance: round(nullDeviance),
    residualDeviance: round(residualDeviance),
    n,
    converged,
    iterations: iter,
    interpretation:
      `Poisson regression (log link, IRLS, ${iter} iterations${converged ? "" : ", DID NOT CONVERGE"}). ` +
      `exp(β) is a RATE RATIO per unit of each feature. Residual deviance ${round(residualDeviance)} on ` +
      `${Math.max(0, n - m)} df — substantially larger suggests overdispersion (use a negative-binomial model).`,
  };
}

// ---------------------------------------------------------------------------
// Survival analysis: Kaplan–Meier + log-rank
// ---------------------------------------------------------------------------

export interface SurvivalObservation {
  /** Time to the event or to censoring — finite and > 0. */
  time: number;
  /** true = event of interest observed; false = censored. */
  event: boolean;
}

export interface KaplanMeierCurve {
  /** Distinct event times, ascending. */
  times: number[];
  /** S(t) just after each event time. */
  survival: number[];
  /** Subjects at risk just before each event time. */
  atRisk: number[];
  /** Events at each time. */
  events: number[];
  /** Greenwood standard error of S(t). */
  standardError: number[];
  /** Smallest t with S(t) ≤ 0.5; null when never reached. */
  median: number | null;
  n: number;
  totalEvents: number;
}

/**
 * Kaplan–Meier product-limit estimator with Greenwood variance. At a time
 * where events AND censorings coincide, censorings happen AFTER the events
 * (the standard convention — censored subjects are still at risk for the
 * events at their own time).
 */
export function kaplanMeier(obs: SurvivalObservation[]): KaplanMeierCurve {
  const clean = obs.filter((o) => isFiniteNumber(o.time) && o.time > 0);
  if (clean.length === 0) throw new StatsError("Kaplan–Meier needs at least one observation with a positive time.");
  const byTime = new Map<number, { events: number; censored: number }>();
  for (const o of clean) {
    const b = byTime.get(o.time) ?? { events: 0, censored: 0 };
    if (o.event) b.events++;
    else b.censored++;
    byTime.set(o.time, b);
  }
  const n = clean.length;
  let atRisk = n;
  let s = 1;
  let greenwood = 0;
  let median: number | null = null;
  let totalEvents = 0;
  const times: number[] = [];
  const survival: number[] = [];
  const atRiskArr: number[] = [];
  const eventsArr: number[] = [];
  const seArr: number[] = [];
  for (const t of [...byTime.keys()].sort((a, b) => a - b)) {
    const b = byTime.get(t)!;
    if (b.events > 0) {
      s *= 1 - b.events / atRisk;
      if (atRisk > b.events) greenwood += b.events / (atRisk * (atRisk - b.events));
      else greenwood += 1 / atRisk; // all remaining subjects failed at t
      times.push(t);
      survival.push(s);
      atRiskArr.push(atRisk);
      eventsArr.push(b.events);
      seArr.push(s * Math.sqrt(greenwood));
      totalEvents += b.events;
      if (median === null && s <= 0.5) median = t;
    }
    atRisk -= b.events + b.censored;
    if (atRisk <= 0) break;
  }
  return {
    times,
    survival: survival.map(round),
    atRisk: atRiskArr,
    events: eventsArr,
    standardError: seArr.map(round),
    median,
    n,
    totalEvents,
  };
}

export interface LogRankResult {
  statistic: number;
  df: 1;
  pValue: number;
  medians: { label: string; median: number | null }[];
  interpretation: string;
}

/**
 * Log-rank test comparing exactly two survival curves. At each distinct event
 * time t: O₁ = events in group 1, E₁ = d·(r₁/r), hypergeometric variance
 * V = d·(r₁/r)·(1 − r₁/r)·(r − d)/(r − 1); χ² = (Σ(O−E))²/ΣV with the exact
 * χ²₁ tail. Subjects censored at t stay at risk AT t (they can fail there).
 */
export function logRankTest(groups: { label: string; obs: SurvivalObservation[] }[]): LogRankResult {
  if (groups.length !== 2) throw new StatsError("The log-rank test compares exactly two groups.");
  for (const g of groups) {
    if (g.obs.length === 0) throw new StatsError(`Group “${g.label}” has no observations.`);
    if (g.obs.some((o) => !isFiniteNumber(o.time) || o.time <= 0)) {
      throw new StatsError(`Group “${g.label}” has a non-positive or non-finite time.`);
    }
  }
  const [g1, g2] = groups as [
    { label: string; obs: SurvivalObservation[] },
    { label: string; obs: SurvivalObservation[] },
  ];
  const medians = groups.map((g) => ({ label: g.label, median: kaplanMeier(g.obs).median }));
  const allTimes = [...new Set([...g1.obs, ...g2.obs].filter((o) => o.event).map((o) => o.time))].sort((a, b) => a - b);
  let oMinusE = 0;
  let varianceSum = 0;
  for (const t of allTimes) {
    const r1 = g1.obs.filter((o) => o.time >= t).length;
    const r2 = g2.obs.filter((o) => o.time >= t).length;
    const r = r1 + r2;
    if (r === 0) continue;
    const d1 = g1.obs.filter((o) => o.event && o.time === t).length;
    const d2 = g2.obs.filter((o) => o.event && o.time === t).length;
    const d = d1 + d2;
    if (d === 0) continue;
    oMinusE += d1 - (d * r1) / r;
    if (r > 1) varianceSum += (d * (r1 / r) * (1 - r1 / r) * (r - d)) / (r - 1);
  }
  if (varianceSum <= 0) throw new StatsError("Log-rank variance is zero — the groups share no comparable event times.");
  const chi2 = (oMinusE * oMinusE) / varianceSum;
  const p = regularizedGammaQ(0.5, chi2 / 2);
  return {
    statistic: round(chi2),
    df: 1,
    pValue: p,
    medians,
    interpretation:
      p < 0.05
        ? `The survival curves differ (χ² = ${round(chi2)}, p = ${round(p)}). Medians: ${medians
            .map((m) => `${m.label} ${m.median === null ? "(not reached)" : m.median}`)
            .join(" vs ")}.`
        : `No evidence the survival curves differ (χ² = ${round(chi2)}, p = ${round(p)}).`,
  };
}
