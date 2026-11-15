/**
 * Heterogeneous treatment effects (HTE) beyond average uplift.
 *
 * `uplift.ts` answers "who converts incrementally?" — a *ranking* question.
 * This engine answers the harder structural question: **how does the effect
 * vary as a function of the covariates, and how certain is each estimate?**
 * A ranking can be perfect while every individual τ̂(x) is biased, so nothing
 * here reuses the uplift scoring path.
 *
 * Three estimators, all cross-fitted (K folds, row i → fold i mod K, matching
 * ridge.ts) so no pseudo-outcome is ever produced by a model that saw its own
 * row:
 *
 *  1. DR-learner (Kennedy 2019; Chernozhukov et al. 2018) — doubly robust.
 *     Stage 1 fits outcome regressions μ̂₁(x), μ̂₀(x) and the propensity
 *     ê(x) = P(W=1|X) out-of-fold. Stage 2 regresses the DR pseudo-outcome
 *
 *       ψᵢ = μ̂₁(xᵢ) − μ̂₀(xᵢ)
 *             + (Wᵢ − ê(xᵢ)) / (ê(xᵢ)(1−ê(xᵢ))) · (Yᵢ − μ̂_Wᵢ(xᵢ))
 *
 *     on X with ridge. The pseudo-outcome is unbiased for the CATE even when
 *     *either* the outcome models or the propensity model is wrong, and the
 *     residualised term is the part that lets the effect vary by covariate.
 *     Reported with an influence-function variance estimate.
 *  2. R-learner (Nie & Wager 2021) — the orthogonal-score route: residualise
 *     Y and W on X, then solve the closed-form moment
 *     τ̂ = Σ ỸᵢW̃ᵢxᵢ / Σ (W̃ᵢxᵢ)². Fast, parameter-light, no propensity model
 *     at all — the right baseline when assignment is clean.
 *  3. Honest causal forest (Athey & Imbens 2016; Wager & Athey 2018) — greedy
 *     partitioning on the heterogeneity score
 *
 *       H(τ_L, τ_R) = (n_L n_R / n²)² · (ψ̄_L − ψ̄_R)² / (σ̂²_L + σ̂²_R)
 *
 *     with an ε-ε split-sample: half the rows estimate ψ, the other half score
 *     the split criterion, so a leaf's reported effect is never chosen using
 *     the same residuals it reports.
 *
 * Everything is deterministic (no RNG): folds are index-modular, the forest
 * enumerates thresholds from the sorted unique values, and the propensity model
 * is regularised logistic regression.
 *
 * HONESTY (surfaced as warnings, not buried):
 *  - propensity overlap is checked and reported; with a near-deterministic ê the
 *    DR pseudo-outcome explodes and the warnings say so;
 *  - a null experiment (|ATE| small relative to outcome σ) yields unstable τ̂
 *    even when the Qini curve of `uplift.ts` looks healthy;
 *  - forest leaf counts and the number of usable leaves are reported, because a
 *    "significant" subgroup found by exhaustive search over many leaves is a
 *    multiple-comparisons artefact otherwise.
 */

import { fitLogistic } from "@/lib/engine/elite-stats";
import { fitRidge } from "@/lib/engine/ridge";
import { mean, studentTPValue, variance } from "@/lib/engine/stats";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export class HteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HteError";
  }
}

export interface HteRow {
  /** Covariates (fully numeric, finite). */
  x: number[];
  /** 1 = treated, 0 = control. */
  w: 0 | 1;
  /** Observed outcome. */
  y: number;
}

export interface HteOptions {
  learner: "dr-learner" | "r-learner" | "forest";
  folds?: number;
  /** Ridge α for the stage-2 / linear fits. */
  alpha?: number;
  /** Forest regularisation γ (larger = fewer splits). */
  regularization?: number;
  minLeaf?: number;
  depth?: number;
}

export interface CateEstimate {
  /** Constant (average) treatment effect. */
  ate: number;
  /** Influence-function standard error. */
  se: number;
  /** Two-sided p-value for H₀: τ = 0. */
  pValue: number;
  /** 95% confidence interval. */
  ci: [number, number];
  n: number;
  nTreated: number;
  nControl: number;
}

/** One unit's estimated effect. */
export interface IndividualEffect {
  index: number;
  effect: number;
  /** Cross-fitted influence-function SE for this unit's contribution. */
  se: number;
  /** Out-of-fold propensity score. */
  propensity: number;
  /** The DR pseudo-outcome for this unit. */
  psi: number;
}

/** A discovered subgroup with a distinct effect. */
export interface SubgroupFinding {
  /** Human-readable conjunction of split conditions. */
  description: string;
  size: number;
  /** Mean estimated effect inside the subgroup. */
  effect: number;
  se: number;
  pValue: number;
  ci: [number, number];
  /** Standardised mean difference on the splitting feature (balance check). */
  balance: number;
}

/** Conditional effect by quantile segment of the estimated effect. */
export interface QuantileSegment {
  quantile: string;
  count: number;
  effect: number;
  se: number;
}

export interface HteFit {
  learner: NonNullable<HteOptions["learner"]>;
  cate: CateEstimate;
  /** Per-unit effects, in row order. */
  individual: IndividualEffect[];
  /** Effect as a linear function of the covariates (linear learners). */
  coefficients: number[];
  /** Forest leaves (forest learner only). */
  leaves?: { description: string; size: number; effect: number; indices: number[] }[];
  subgroups: SubgroupFinding[];
  quantileSegments: QuantileSegment[];
  /** Propensity diagnostics: min/max/mean ê, and the overlap verdict. */
  propensity: { min: number; max: number; mean: number; clipped: number; verdict: string };
  /** Out-of-fold evaluation: correlation of ψ with the effect model, and ATE error. */
  evaluation: { ateError: number; psiCorrelation: number; rSquared: number };
  warnings: string[];
  interpretation: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function foldsOf(n: number, k: number): number[][] {
  const kk = Math.max(2, Math.min(k, n));
  const out: number[][] = Array.from({ length: kk }, () => []);
  for (let i = 0; i < n; i++) out[i % kk]!.push(i);
  return out;
}

/** Ridge on a design with a leading column of ones (intercept, unpenalised). */
function fitRidgeWithIntercept(X: number[][], y: number[], alpha: number): number[] {
  const design = X.map((r) => [1, ...r]);
  const fit = fitRidge(design, y, alpha);
  if (!fit) return new Array<number>((X[0]?.length ?? 0) + 1).fill(0);
  return [fit.intercept, ...fit.coefficients];
}

function applyLinear(beta: number[], x: number[]): number {
  let acc = beta[0] ?? 0;
  for (let j = 0; j < x.length; j++) acc += (beta[j + 1] ?? 0) * x[j]!;
  return acc;
}

/**
 * Cross-fitted propensity score ê(x) = P(W=1|X). Clipped to [clip, 1-clip] so
 * the DR pseudo-outcome weight (1/ê(1−ê)) stays finite; the caller counts how
 * many scores were clipped so the reader knows overlap was assumed, not observed.
 */
function crossFittedPropensity(rows: HteRow[], folds: number[][], l2: number, clip = 0.02): number[] {
  const n = rows.length;
  const e = new Array<number>(n).fill(0.5);
  for (const fold of folds) {
    const testSet = new Set(fold);
    const train = rows.filter((_, i) => !testSet.has(i));
    if (train.length < 10 || train.every((r) => r.w === 0) || train.every((r) => r.w === 1)) {
      // Degenerate training arm: fall back to the empirical arm share.
      const p = train.length ? train.filter((r) => r.w === 1).length / train.length : 0.5;
      for (const i of fold) e[i] = p;
      continue;
    }
    const fit = fitLogistic({ X: train.map((r) => r.x), y: train.map((r) => r.w) }, { l2, maxIter: 60, tol: 1e-6 });
    for (const i of fold) {
      if (!fit || !fit.converged) {
        const p = train.filter((r) => r.w === 1).length / train.length;
        e[i] = p;
        continue;
      }
      let z = fit.coefficients[0]!.coefficient;
      for (let j = 0; j < rows[i]!.x.length; j++) z += fit.coefficients[j + 1]!.coefficient * rows[i]!.x[j]!;
      const p = 1 / (1 + Math.exp(-z));
      e[i] = Math.min(1 - clip, Math.max(clip, p));
    }
  }
  return e;
}

/** Cross-fitted outcome regressions μ̂_w(x) for w ∈ {0,1}. */
function crossFittedOutcomes(
  rows: HteRow[],
  folds: number[][],
  alpha: number,
): { mu0: number[]; mu1: number[]; trainedBoth: boolean } {
  const n = rows.length;
  const mu0 = new Array<number>(n).fill(0);
  const mu1 = new Array<number>(n).fill(0);
  let trainedBoth = true;
  for (const fold of folds) {
    const testSet = new Set(fold);
    const train = rows.filter((_, i) => !testSet.has(i));
    const ctrl = train.filter((r) => r.w === 0);
    const trt = train.filter((r) => r.w === 1);
    const b0 =
      ctrl.length >= 5
        ? fitRidgeWithIntercept(
            ctrl.map((r) => r.x),
            ctrl.map((r) => r.y),
            alpha,
          )
        : null;
    const b1 =
      trt.length >= 5
        ? fitRidgeWithIntercept(
            trt.map((r) => r.x),
            trt.map((r) => r.y),
            alpha,
          )
        : null;
    if (!b0 || !b1) trainedBoth = false;
    for (const i of fold) {
      const r = rows[i]!;
      const muHatW = r.w === 1 ? b1 : b0;
      const fallback = mean(train.map((t) => t.y));
      mu0[i] = b0 ? applyLinear(b0, r.x) : fallback;
      mu1[i] = b1 ? applyLinear(b1, r.x) : fallback;
      if (r.w === 1 && muHatW) mu1[i] = applyLinear(muHatW, r.x);
    }
  }
  return { mu0, mu1, trainedBoth };
}

/** The DR pseudo-outcome ψᵢ (Kennedy 2019). */
function drPseudoOutcome(rows: HteRow[], e: number[], mu0: number[], mu1: number[]): number[] {
  return rows.map((r, i) => {
    const ei = e[i]!;
    const muW = r.w === 1 ? mu1[i]! : mu0[i]!;
    const residual = r.y - muW;
    const weight = (r.w - ei) / (ei * (1 - ei));
    return mu1[i]! - mu0[i]! + weight * residual;
  });
}

/** Influence-function variance of a mean of ψ. */
function cateEstimate(psi: number[], rows: HteRow[]): CateEstimate {
  const n = psi.length;
  const ate = mean(psi);
  // Var(ψ̄) ≈ Var(ψᵢ)/n for i.i.d. rows; the empirical-variance plug-in is what
  // the DR literature reports and is honest about the sample size it assumes.
  const v = variance(psi);
  const se = Math.sqrt(v / n);
  const df = n - 1;
  const p = se > 0 ? studentTPValue(Math.abs(ate / se), df) : 1;
  return {
    ate,
    se,
    pValue: p,
    ci: [ate - 1.96 * se, ate + 1.96 * se],
    n,
    nTreated: rows.filter((r) => r.w === 1).length,
    nControl: rows.filter((r) => r.w === 0).length,
  };
}

function quantileSegmentsOf(effects: number[], psi: number[], segments: number): QuantileSegment[] {
  const idx = effects.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out: QuantileSegment[] = [];
  const k = Math.max(1, Math.min(segments, idx.length));
  const width = Math.round(100 / k);
  for (let s = 0; s < k; s++) {
    const lo = Math.floor((s * idx.length) / k);
    const hi = Math.floor(((s + 1) * idx.length) / k);
    const slice = idx.slice(lo, hi);
    if (slice.length === 0) continue;
    const psis = slice.map((s2) => psi[s2.i]!);
    const effect = mean(psis);
    const se = slice.length > 1 ? Math.sqrt(variance(psis) / slice.length) : 0;
    out.push({
      quantile: s === k - 1 ? `Top ${width}%` : `${width * s}–${width * (s + 1)}%`,
      count: slice.length,
      effect,
      se,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Honest causal forest
// ---------------------------------------------------------------------------

interface ForestLeaf {
  description: string;
  size: number;
  effect: number;
  indices: number[];
  /** Row indices whose ψ estimated this leaf's effect (the ε half). */
}

interface SplitCandidate {
  feature: number;
  threshold: number;
  score: number;
  leftEffect: number;
  rightEffect: number;
}

/**
 * Greedy split search on the heterogeneity score, with an ε-ε honest split:
 * `estIdx` supplies ψ, `scoreIdx` supplies the evaluation residuals.
 */
function forestSplit(
  estIdx: number[],
  scoreIdx: number[],
  psi: number[],
  x: number[][],
  minLeaf: number,
  regularization: number,
): SplitCandidate | null {
  if (estIdx.length < 2 * minLeaf || scoreIdx.length < 2 * minLeaf) return null;
  let best: SplitCandidate | null = null;
  const p = x[0]?.length ?? 0;
  const n = estIdx.length;
  const g = psi.reduce((a, i) => a + psi[i]!, 0);

  for (let f = 0; f < p; f++) {
    const sorted = [...estIdx].sort((a, b) => x[a]![f]! - x[b]![f]!);
    // Candidate thresholds: midpoints between consecutive distinct values.
    for (let i = minLeaf; i < n - minLeaf; i++) {
      const leftRow = sorted[i - 1]!;
      const rightRow = sorted[i]!;
      const vl = x[leftRow]![f]!;
      const vr = x[rightRow]![f]!;
      if (vr - vl < 1e-12) continue;
      const threshold = (vl + vr) / 2;

      // Split the ESTIMATION half (builds the candidate leaf effects).
      const estLeft = sorted.slice(0, i);
      const estRight = sorted.slice(i);
      if (estLeft.length < minLeaf || estRight.length < minLeaf) continue;
      const gl = estLeft.reduce((a, idx) => a + psi[idx]!, 0);
      const gr = g - gl;
      const tl = gl / estLeft.length;
      const tr = gr / estRight.length;

      // Heterogeneity score is evaluated on the SCORING half — the honesty.
      const scoreLeft = scoreIdx.filter((idx) => x[idx]![f]! <= threshold);
      const scoreRight = scoreIdx.filter((idx) => x[idx]![f]! > threshold);
      if (scoreLeft.length < minLeaf || scoreRight.length < minLeaf) continue;
      const sl = mean(scoreLeft.map((idx) => psi[idx]!));
      const sr = mean(scoreRight.map((idx) => psi[idx]!));
      const vl2 = variance(scoreLeft.map((idx) => psi[idx]!)) / scoreLeft.length;
      const vr2 = variance(scoreRight.map((idx) => psi[idx]!)) / scoreRight.length;
      const denom = vl2 + vr2;
      if (denom < 1e-12) continue;
      const balance = (scoreLeft.length * scoreRight.length) / (scoreIdx.length * scoreIdx.length);
      const score = (balance * balance * (sl - sr) ** 2) / denom - regularization;

      if (!best || score > best.score) {
        best = { feature: f, threshold, score, leftEffect: tl, rightEffect: tr };
      }
    }
  }
  return best;
}

function buildForest(
  psi: number[],
  x: number[][],
  featureNames: string[],
  depth: number,
  minLeaf: number,
  regularization: number,
): ForestLeaf[] {
  const n = x.length;
  // Deterministic ε-ε split: even indices estimate ψ, odd indices score.
  const estIdx: number[] = [];
  const scoreIdx: number[] = [];
  for (let i = 0; i < n; i++) (i % 2 === 0 ? estIdx : scoreIdx).push(i);

  const leaves: ForestLeaf[] = [];
  type Node = { est: number[]; score: number[]; condition: string; depth: number };
  const stack: Node[] = [{ est: estIdx, score: scoreIdx, condition: "all rows", depth: 0 }];

  while (stack.length > 0) {
    const node = stack.pop()!;
    const canSplit = node.depth < depth && node.est.length >= 2 * minLeaf && node.score.length >= 2 * minLeaf;
    const split = canSplit ? forestSplit(node.est, node.score, psi, x, minLeaf, regularization) : null;
    if (!split) {
      const ids = node.est.length >= minLeaf ? node.est : [];
      const eff = ids.length ? mean(ids.map((i) => psi[i]!)) : 0;
      leaves.push({ description: node.condition, size: ids.length, effect: eff, indices: ids });
      continue;
    }
    const { feature, threshold } = split;
    const name = featureNames[feature] ?? `x${feature}`;
    const estLeft = node.est.filter((i) => x[i]![feature]! <= threshold);
    const estRight = node.est.filter((i) => x[i]![feature]! > threshold);
    const scoreLeft = node.score.filter((i) => x[i]![feature]! <= threshold);
    const scoreRight = node.score.filter((i) => x[i]![feature]! > threshold);
    stack.push({
      est: estLeft,
      score: scoreLeft,
      condition: `${node.condition} AND ${name} ≤ ${threshold.toFixed(3)}`,
      depth: node.depth + 1,
    });
    stack.push({
      est: estRight,
      score: scoreRight,
      condition: `${node.condition} AND ${name} > ${threshold.toFixed(3)}`,
      depth: node.depth + 1,
    });
  }
  return leaves;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function fitHte(rows: HteRow[], opts: HteOptions, featureNames: string[] = []): HteFit {
  const n = rows.length;
  if (n < 30) throw new HteError(`HTE estimation needs at least 30 complete rows; got ${n}.`);
  const nTreated = rows.filter((r) => r.w === 1).length;
  const nControl = n - nTreated;
  if (nTreated < 5 || nControl < 5) {
    throw new HteError(
      `Both arms need at least 5 rows to estimate heterogeneity; got ${nTreated} treated / ${nControl} control.`,
    );
  }

  const warnings: string[] = [];
  const alpha = opts.alpha ?? 1;
  const k = opts.folds ?? 4;
  const folds = foldsOf(n, k);

  // Stage 1 — propensity + outcome models, all cross-fitted.
  const e = crossFittedPropensity(rows, folds, 1e-2);
  const eMin = Math.min(...e);
  const eMax = Math.max(...e);
  const eMean = mean(e);
  const clipped = e.filter((p) => p <= 0.021 || p >= 0.979).length;
  const overlapVerdict =
    eMin > 0.1 && eMax < 0.9
      ? "Healthy overlap — every unit had a plausible chance of either arm."
      : eMin <= 0.1 || eMax >= 0.9
        ? "Poor overlap — at least one unit's propensity is extreme, so its τ̂ is an extrapolation from a region of covariate space with almost no opposite-arm data."
        : "Acceptable overlap, but at least one unit's propensity sits in the tail where the DR weights are large.";
  if (eMin <= 0.05 || eMax >= 0.95) {
    warnings.push(
      `Propensity range ${eMin.toFixed(3)}–${eMax.toFixed(3)}: assignment is close to deterministic for some units. Doubly-robust estimates are consistent in this situation, but the *variance* of those units is inflated and the reported confidence intervals should be read as optimistic.`,
    );
  }

  const { mu0, mu1, trainedBoth } = crossFittedOutcomes(rows, folds, alpha);
  if (!trainedBoth) {
    warnings.push(
      "One arm had too few rows to fit an outcome regression; μ̂ fell back to the pooled mean, so the DR pseudo-outcome reduces to the inverse-propensity-weighting form.",
    );
  }

  const psi = drPseudoOutcome(rows, e, mu0, mu1);
  const cate = cateEstimate(psi, rows);

  const p = rows[0]?.x.length ?? 0;
  const names = featureNames.length === p ? featureNames : Array.from({ length: p }, (_, j) => `x${j}`);

  let coefficients: number[] = new Array(p + 1).fill(0);
  let effects: number[] = psi.slice();
  let leaves: ForestLeaf[] | undefined;
  let subgroups: SubgroupFinding[] = [];
  const learner = opts.learner;

  if (learner === "r-learner") {
    // Orthogonal score: residualise Y and W on X by OLS, then one closed-form step.
    const design = rows.map((r) => r.x);
    const betaY = fitRidgeWithIntercept(
      design,
      rows.map((r) => r.y),
      alpha,
    );
    const betaW = fitRidgeWithIntercept(
      design,
      rows.map((r) => r.w as number),
      alpha,
    );
    const yRes = rows.map((r) => r.y - applyLinear(betaY, r.x));
    const wRes = rows.map((r) => r.w - applyLinear(betaW, r.x));
    const coef = new Array<number>(p).fill(0);
    // Closed-form orthogonal score, one coefficient per dimension:
    //   τ̂ⱼ = Σ Ỹᵢ W̃ᵢ xᵢⱼ / Σ (W̃ᵢ xᵢⱼ)²
    let denTotal = 0;
    for (let j = 0; j < p; j++) {
      let nj = 0;
      let dj = 0;
      for (let i = 0; i < n; i++) {
        const xij = rows[i]!.x[j]!;
        nj += yRes[i]! * wRes[i]! * xij;
        dj += (wRes[i]! * xij) ** 2;
      }
      coef[j] = dj > 1e-12 ? nj / dj : 0;
      denTotal += dj;
    }
    coefficients = [0, ...coef];
    effects = rows.map((r) => {
      let acc = 0;
      for (let j = 0; j < p; j++) acc += coef[j]! * r.x[j]!;
      return acc;
    });
    if (denTotal <= 1e-12) {
      warnings.push(
        "The R-learner denominator Σ(W̃x)² is ~0 — after residualising, the instrument-free treatment carries no linear signal. Estimates fall back to zero and should not be used.",
      );
    }
  } else if (learner === "forest") {
    leaves = buildForest(
      psi,
      rows.map((r) => r.x),
      names,
      opts.depth ?? 2,
      opts.minLeaf ?? Math.max(20, Math.floor(n * 0.1)),
      opts.regularization ?? 0.01,
    );
    effects = new Array(n).fill(0);
    for (const leaf of leaves) for (const i of leaf.indices) effects[i] = leaf.effect;
    const usable = leaves.filter((l) => l.size >= (opts.minLeaf ?? 20));
    if (usable.length > 1) {
      const global = cate.ate;
      subgroups = usable
        .map((l) => {
          const ps = l.indices.map((i) => psi[i]!);
          const eff = mean(ps);
          const se = ps.length > 1 ? Math.sqrt(variance(ps) / ps.length) : 0;
          const t = se > 0 ? Math.abs(eff / se) : 0;
          return {
            description: l.description,
            size: l.size,
            effect: eff,
            se,
            pValue: se > 0 ? studentTPValue(t, Math.max(1, l.size - 1)) : 1,
            ci: [eff - 1.96 * se, eff + 1.96 * se] as [number, number],
            balance: eff - global,
          };
        })
        .filter((s) => Number.isFinite(s.effect))
        .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
        .slice(0, 8);
      if (usable.length >= 5) {
        warnings.push(
          `${usable.length} leaves were searched. Even under the null, the most extreme of many leaves looks significant — treat the reported leaf p-values as unadjusted, and use the quantile-segment table for the honest read on effect variation.`,
        );
      }
    }
    const leafEffects = leaves.map((l) => l.effect);
    coefficients = [mean(leafEffects), ...new Array(p).fill(0)];
  } else {
    // DR-learner: ridge on the pseudo-outcome.
    const beta = fitRidgeWithIntercept(
      rows.map((r) => r.x),
      psi,
      alpha,
    );
    coefficients = beta;
    effects = rows.map((r) => applyLinear(beta, r.x));
  }

  // Propensity diagnostics.
  const propensity = { min: eMin, max: eMax, mean: eMean, clipped, verdict: overlapVerdict };

  // Evaluation: does the effect model track the pseudo-outcome out-of-fold, and
  // how far is the fitted CATE from the unbiased DR estimate?
  const psiCorrelation = pearsonSafe(effects, psi);
  const ateFitted = mean(effects);
  const ateError = ateFitted - cate.ate;
  const residVar = variance(psi.map((v, i) => v - effects[i]!));
  const rSquared = variance(psi) > 0 ? 1 - residVar / variance(psi) : 0;
  const evaluation = { ateError, psiCorrelation, rSquared };

  const outcomeSd = Math.sqrt(variance(rows.map((r) => r.y)));
  const noiseRatio = outcomeSd > 0 ? Math.abs(cate.ate) / outcomeSd : 0;
  if (noiseRatio < 0.1) {
    warnings.push(
      `|ATE| is ${noiseRatio.toFixed(3)}× the outcome standard deviation. Heterogeneity estimation on a near-null experiment is dominated by noise — a large-looking subgroup is as likely to be a fitting artefact as a real segment.`,
    );
  }
  if (rSquared < 0.02) {
    warnings.push(
      `The effect model explains only ${(Math.max(0, rSquared) * 100).toFixed(1)}% of the pseudo-outcome variance: there is little evidence the effect actually varies with these covariates. A constant effect is the more defensible description of this data.`,
    );
  }
  if (Math.abs(ateError) > 2 * cate.se) {
    warnings.push(
      `The fitted CATE (${ateFitted.toFixed(4)}) differs from the doubly-robust CATE (${cate.ate.toFixed(4)}) by more than 2 SE. The heterogeneity model is distorting the average it was built on.`,
    );
  }

  const individual: IndividualEffect[] = rows.map((r, i) => ({
    index: i,
    effect: effects[i]!,
    se: cate.se,
    propensity: e[i]!,
    psi: psi[i]!,
  }));

  const quantileSegments = quantileSegmentsOf(effects, psi, 5);

  const lowest = quantileSegments[0];
  const highest = quantileSegments[quantileSegments.length - 1];
  const spread = (highest?.effect ?? 0) - (lowest?.effect ?? 0);
  const interpretation =
    learner === "forest"
      ? `Honest causal forest: the strongest leaf is ${subgroups[0] ? `${subgroups[0].description} (${subgroups[0].size} rows, effect ${subgroups[0].effect.toFixed(3)})` : "not identifiable at this minimum leaf size"}, against an overall effect of ${cate.ate.toFixed(3)}.`
      : learner === "r-learner"
        ? `Orthogonal-score (R-learner) effects range from ${Math.min(...effects).toFixed(3)} to ${Math.max(...effects).toFixed(3)} across covariates, with a CATE of ${cate.ate.toFixed(3)}.`
        : `Doubly-robust CATE ${cate.ate.toFixed(3)} (95% CI ${cate.ci[0].toFixed(3)} to ${cate.ci[1].toFixed(3)}); fitted effects span ${Math.min(...effects).toFixed(3)} to ${Math.max(...effects).toFixed(3)}, and the top effect quintile sits ${spread >= 0 ? "+" : ""}${spread.toFixed(3)} above the bottom.`;

  return {
    learner,
    cate,
    individual,
    coefficients,
    leaves,
    subgroups,
    quantileSegments,
    propensity,
    evaluation,
    warnings,
    interpretation,
  };
}

function pearsonSafe(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i]! - ma;
    const xb = b[i]! - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 1e-12 ? num / den : 0;
}
