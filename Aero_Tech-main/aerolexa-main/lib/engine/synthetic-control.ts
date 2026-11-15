/**
 * Synthetic control — the reference design for one treated unit + many
 * untreated peers (Abadie & Gardeazabal 2003; Abadie, Diamond, Hainmueller
 * 2010). Where difference-in-differences needs many treated units and
 * parallel-trends luck, synthetic control needs only ENOUGH PRE-PERIODS:
 * it builds a weighted combination of the untreated units that reproduces
 * the treated unit's pre-treatment path, then reads the counterfactual off
 * that combination in the post period.
 *
 * The estimator (Abadie et al., convex formulation on the outcome path):
 *
 *   min_w ||X₁ − X₀w||²   s.t.   w ≥ 0, Σw = 1
 *
 * where X₀ stacks the donors' pre-period outcomes and X₁ is the treated
 * unit's pre-period path. The simplex constraint is exactly what makes the
 * counterfactual interpretable ("a weighted blend of peers") and what
 * prevents extrapolation: a negative-weight blend can masquerade as a fit,
 * a convex blend cannot leave the donor hull.
 *
 * Solver — Frank–Wolfe (projected gradient on the simplex):
 *   1. w ← uniform start, then iterate:
 *   2. g = X₀ᵀ(X₀w − X₁); s = argmin_j g_j (the classic FW vertex step),
 *   3. w ← (1 − γ)w + γ·e_s, γ = 2/(t+1) (deterministic schedule),
 *   4. stop when the duality gap gᵀw − min_j g_j < tol.
 * Frank–Wolfe converges O(1/t) and every iterate stays ON the simplex, so
 * w ≥ 0 and Σw = 1 hold at every step — no projection errors, no RNG.
 *
 * Inference — PLACEBO TESTS, the method's own recommended protocol:
 *  1. Pre-fit honesty: preRmse relative to the treated level is reported on
 *     every result; a poor pre-fit is flagged, never hidden.
 *  2. In-space placebo: re-run the SAME estimator with every donor as the
 *     pseudo-treated unit (the treated unit + remaining donors as peers).
 *     The treated unit's mean post-gap must be extreme relative to the
 *     placebo gaps. The p-value is the permutation rank — EXACT under the
 *     random-assignment-of-treatment-to-units null (Conley & Taber 2011
 *     style), no asymptotic approximation.
 *  3. ATT significance additionally uses the pre-period gap variance as the
 *     "no treatment" scale (NaN when there are fewer than 4 pre-periods —
 *     never invented from thin air).
 *
 * DETERMINISM: fixed initialization + closed-form gradient steps. Same data
 * ⇒ byte-identical weights, gaps and p-value. No Math.random anywhere.
 *
 * HONESTY: the identifying assumption ("donors reproduce the pre-path AND no
 * simultaneous shock hits only the treated unit") is printed on every result.
 * Missing data is REJECTED — a synthetic control needs a complete panel;
 * silent imputation would bend the counterfactual.
 */

import { mean, studentTPValue } from "@/lib/engine/stats";

export class SyntheticControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyntheticControlError";
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface SyntheticControlInput {
  /** Outcomes, time-major: outcomes[t][0] is the treated unit at time t; outcomes[t][j] donor j. */
  outcomes: number[][];
  /** Number of leading time rows that are PRE-treatment (integer ≥ 2). */
  prePeriods: number;
  /** Donor names, aligned with columns 1..n−1 (for the report). */
  donorNames?: string[];
  treatedName?: string;
  /** Frank–Wolfe iterations (default 1000). */
  maxIter?: number;
  /** Duality-gap tolerance (default 1e-10). */
  tol?: number;
}

export interface SyntheticControlResult {
  treatedName: string;
  /** Solution weights over donors (all ≥ 0, sum to 1). Index j ↔ donor j. */
  weights: number[];
  /** Donor names aligned with `weights` (auto "donor_1"… when unnamed). */
  donorNames: string[];
  /** Pre-period RMS gap between treated and synthetic. */
  preRmse: number;
  /** Post-period RMS gap — the treatment-effect scale. */
  postRmse: number;
  /** Per-period gap: treated − synthetic (isPost marks t ≥ prePeriods). */
  gaps: { t: number; gap: number; isPost: boolean }[];
  /** Average treatment effect on the treated unit over the post period. */
  att: number;
  /** ATT SE from the pre-period gap variance; NaN when prePeriods < 4. */
  attSe: number;
  /** Two-sided p-value for att ≠ 0 (NaN when attSe is NaN). */
  attPValue: number;
  /** |ATT| / |mean pre-period treated level| — the interpretable size. */
  relativeAtt: number;
  /** Number of in-space placebo fits. */
  placeboCount: number;
  /** Permutation p-value: rank of the treated |post-gap| among 1 + placeboCount. */
  placeboPValue: number;
  /** Treated unit's rank of |post gap| (1 = most extreme). */
  placeboRank: number;
  /** Donor contribution breakdown (weight % over non-zero weights). */
  contributions: { name: string; weight: number; pct: number }[];
  /** Duality gap at solver stop (convergence evidence). */
  dualityGap: number;
  /** ALWAYS present: the assumption this estimate leans on. */
  identifyingAssumption: string;
  warnings: string[];
  interpretation: string;
}

// ---------------------------------------------------------------------------
// Core solver
// ---------------------------------------------------------------------------

/** Frank–Wolfe over the simplex for min_w ||X₀w − x₁||². Deterministic. */
export function solveSimplexLeastSquares(
  X0: number[][],
  x1: number[],
  maxIter = 1000,
  tol = 1e-10,
): { w: number[]; gap: number } {
  const T = x1.length;
  const J = X0[0]?.length ?? 0;
  if (T === 0 || J === 0) return { w: [], gap: Number.NaN };

  // Uniform start — deterministic, on-simplex.
  let w = new Array<number>(J).fill(1 / J);

  // ∇½||X₀w − x₁||² = X₀ᵀ(X₀w − x₁) — the factor ½ cancels in argmin/stop tests.
  let gap = Number.POSITIVE_INFINITY;
  for (let iter = 1; iter <= maxIter; iter++) {
    const g = new Array<number>(J).fill(0);
    for (let t = 0; t < T; t++) {
      const row = X0[t] as number[];
      let pred = 0;
      for (let j = 0; j < J; j++) pred += row[j]! * w[j]!;
      const r = pred - x1[t]!;
      for (let j = 0; j < J; j++) g[j]! += row[j]! * r;
    }
    // Simplex argmin of g is the one-hot of its smallest coordinate.
    let s = 0;
    for (let j = 1; j < J; j++) if (g[j]! < g[s]!) s = j;
    gap = 0;
    for (let j = 0; j < J; j++) gap += g[j]! * (w[j]! - (j === s ? 1 : 0));
    if (gap <= tol) break;
    const gamma = 2 / (iter + 1);
    const next = new Array<number>(J);
    for (let j = 0; j < J; j++) next[j] = (1 - gamma) * w[j]! + gamma * (j === s ? 1 : 0);
    w = next;
  }
  return { w, gap };
}

function rmse(v: number[]): number {
  if (v.length === 0) return Number.NaN;
  let acc = 0;
  for (const x of v) acc += x * x;
  return Math.sqrt(acc / v.length);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function syntheticControl(input: SyntheticControlInput): SyntheticControlResult {
  const Y = input.outcomes;
  const T = Y.length;
  const T0 = Math.floor(input.prePeriods);
  const nUnits = Y[0]?.length ?? 0;
  const maxIter = input.maxIter ?? 1000;
  const tol = input.tol ?? 1e-10;

  if (T < 4) throw new SyntheticControlError("Need at least 4 time periods (≥2 pre + ≥2 post).");
  if (!Number.isInteger(input.prePeriods) || T0 < 2) {
    throw new SyntheticControlError("prePeriods must be an integer ≥ 2.");
  }
  if (T0 >= T - 1) {
    throw new SyntheticControlError("Need at least 1 post-treatment period (prePeriods < total periods − 1).");
  }
  if (nUnits < 2) throw new SyntheticControlError("Need at least 1 treated unit + 1 donor.");
  for (let t = 0; t < T; t++) {
    const row = Y[t] as number[];
    if (row.length !== nUnits) {
      throw new SyntheticControlError(
        `Row ${t} has ${row.length} units; expected ${nUnits} — the panel must be rectangular.`,
      );
    }
    for (let i = 0; i < nUnits; i++) {
      if (!Number.isFinite(row[i] as number)) {
        throw new SyntheticControlError(
          `outcomes[${t}][${i}] is not a finite number — synthetic control needs a COMPLETE panel; impute upstream, transparently.`,
        );
      }
    }
  }

  const treated = Array.from({ length: T }, (_, t) => Y[t]![0] as number);
  const donors = Array.from({ length: T }, (_, t) => (Y[t] as number[]).slice(1));
  const J = donors[0]!.length;

  const { w, gap } = solveSimplexLeastSquares(donors.slice(0, T0), treated.slice(0, T0), maxIter, tol);

  // Full-path synthetic series with the weights FROZEN at T₀ — they are never
  // re-fit on post data (that would leak the treatment into the counterfactual).
  const synthetic = Array.from({ length: T }, (_, t) => {
    const row = donors[t] as number[];
    let v = 0;
    for (let j = 0; j < w.length; j++) v += (w[j] as number) * row[j]!;
    return v;
  });

  const gapsAll = treated.map((v, t) => v - synthetic[t]!);
  const preGaps = gapsAll.slice(0, T0);
  const postGaps = gapsAll.slice(T0);
  const preRmse = rmse(preGaps);
  const postRmse = rmse(postGaps);
  const att = mean(postGaps);
  const treatedLevel = mean(treated.slice(0, T0));
  const relativeAtt = treatedLevel !== 0 ? Math.abs(att) / Math.abs(treatedLevel) : Number.NaN;

  // ATT SE from the pre-period gap variance: the pre-gaps are this unit's
  // empirical "no treatment" gap distribution; sd(gaps)·√(1/T₀ + 1/T₁) is the
  // honest (conservative) scale for the post-period mean. NaN when T₀ < 4.
  let attSe = Number.NaN;
  let attPValue = Number.NaN;
  if (T0 >= 4) {
    const m = mean(preGaps);
    const varPre = preGaps.reduce((a, g) => a + (g - m) ** 2, 0) / (T0 - 1);
    attSe = Math.sqrt(varPre * (1 / T0 + 1 / postGaps.length));
  }
  if (Number.isFinite(attSe) && attSe > 0) {
    attPValue = studentTPValue(Math.abs(att / attSe), T0 + postGaps.length - 2);
  }

  // ----- In-space placebos: every donor re-fit as pseudo-treated ------------
  //
  // The treated unit's post-period statistic MUST be computed exactly the way
  // each placebo's is, or the ranking compares incommensurable quantities: the
  // placebo score is the RMS of the post gaps, so the treated score is its own
  // post-gap RMS — not the mean `att`. (Ranking RMS placebos against a MEAN
  // effect silently biases the p-value whenever the treated unit's gaps are
  // not constant across the post period.)
  //
  // Peers for placebo d are the treated unit + every donor except d — the
  // standard in-space protocol (Abadie et al. 2010 §5.2). Note the
  // consequence: a donor that is nearly collinear with the treated unit's
  // pre-path will lean on the treated series as its own synthetic control and
  // therefore inherit the treated unit's jump. With few donors that can make
  // a real effect look indistinguishable from noise; the p-value reports that
  // honestly rather than hiding it.
  const treatedScore = rmse(postGaps) * Math.sign(att || 1);
  const placeboGaps: number[] = [];
  let placeboRank = Number.NaN;
  let placeboPValue = Number.NaN;
  for (let d = 0; d < J; d++) {
    const pseudo = Array.from({ length: T }, (_, t) => donors[t]![d] as number);
    const peers = Array.from({ length: T }, (_, t) => [
      treated[t] as number,
      ...donors[t]!.slice(0, d),
      ...donors[t]!.slice(d + 1),
    ]);
    const fit = solveSimplexLeastSquares(peers.slice(0, T0), pseudo.slice(0, T0), maxIter, tol);
    let acc = 0;
    for (let t = T0; t < T; t++) {
      let syn = 0;
      const row = peers[t] as number[];
      for (let j = 0; j < fit.w.length; j++) syn += (fit.w[j] as number) * row[j]!;
      const g = pseudo[t]! - syn;
      acc += g * g;
    }
    placeboGaps.push(Math.sqrt(acc / postGaps.length) * Math.sign(att || 1));
  }
  if (placeboGaps.length > 0) {
    let rank = 1;
    for (const g of placeboGaps) if (g > treatedScore) rank++;
    placeboRank = rank;
    placeboPValue = rank / (placeboGaps.length + 1);
  }

  const warnings: string[] = [];
  const preFitShare =
    Number.isFinite(treatedLevel) && treatedLevel !== 0 ? preRmse / Math.abs(treatedLevel) : Number.NaN;
  if (Number.isFinite(preFitShare) && preFitShare > 0.1) {
    warnings.push(
      `Poor pre-fit (pre RMSE = ${preRmse.toFixed(4)} is ${(preFitShare * 100).toFixed(1)}% of the treated unit's pre-period mean) — the counterfactual is fragile; consider more donors or a longer pre-period.`,
    );
  }
  if (Number.isFinite(placeboPValue) && placeboPValue > 0.1) {
    warnings.push(
      `In-space placebo p = ${placeboPValue.toFixed(3)} — the treated unit's post-gap is not extreme among placebo units; the estimate is not distinguishable from unit-level noise.`,
    );
  }

  const donorNames = input.donorNames ?? Array.from({ length: w.length }, (_, j) => `donor_${j + 1}`);
  const treatedName = input.treatedName ?? "treated";
  const wSum = w.reduce((a, b) => a + b, 0) || 1;
  const contributions = w
    .map((weight, j) => ({ name: donorNames[j] as string, weight, pct: (weight / wSum) * 100 }))
    .filter((c) => c.weight > 1e-6)
    .sort((a, b) => b.weight - a.weight);

  const interpretation = [
    `Synthetic ${treatedName} = convex combination of ${contributions.length} donor(s), fit on ${T0} pre-periods (duality gap ${gap.toExponential(1)}).`,
    `Average post-period effect: ${att >= 0 ? "+" : ""}${att.toFixed(4)} per period (${(relativeAtt * 100).toFixed(1)}% of the pre-period level), post RMSE ${postRmse.toFixed(4)}.`,
    Number.isFinite(attPValue)
      ? `Pre-gap-variance t-test: p = ${attPValue.toFixed(4)}.`
      : `Pre-gap t-test unavailable (fewer than 4 pre-periods) — rely on the placebo rank.`,
    Number.isFinite(placeboPValue)
      ? `Placebo rank ${placeboRank}/${placeboGaps.length + 1} (permutation p = ${placeboPValue.toFixed(3)}): ${
          placeboPValue <= 0.05
            ? "the treated unit's gap IS extreme among donors — consistent with a real effect."
            : "the treated gap is NOT extreme among donors."
        }`
      : `No placebo inference available.`,
    `Identifying assumption: donors reproduce the pre-path AND no simultaneous shock hits only the treated unit.`,
  ].join(" ");

  return {
    treatedName,
    weights: w,
    donorNames,
    preRmse,
    postRmse,
    gaps: gapsAll.map((g, t) => ({ t, gap: g, isPost: t >= T0 })),
    att,
    attSe,
    attPValue,
    relativeAtt,
    placeboCount: placeboGaps.length,
    placeboPValue,
    placeboRank,
    contributions,
    dualityGap: gap,
    identifyingAssumption:
      "Donors can reproduce the treated unit's pre-treatment path, and no unobserved simultaneous shock hits the treated unit alone.",
    warnings,
    interpretation,
  };
}
