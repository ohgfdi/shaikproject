/**
 * Shapley-value feature attributions — the honest, model-agnostic way to
 * answer "why did the model output THIS number for THIS row?".
 *
 * Algorithm: permutation Shapley sampling (Strumbelj & Kononenko 2014; the
 * same estimator the SHAP library's `permutation` explainer uses). For each
 * of R seeded random feature permutations, walk the features in order, swap
 * each feature's value from the row being explained into a background row,
 * and record the model-output delta at each step. Every (feature, subset)
 * marginal contribution is visited once per permutation; averaging the
 * position-weighted deltas yields unbiased Shapley values that satisfy the
 * additive property: f(x) − E[f(background)] = Σ φᵢ (exactly, within
 * sampling noise).
 *
 * Design (matches the repo's trust bar):
 *  - Works on ANY black box: one `predict(x) => number` closure. No model
 *    introspection, no assumptions — the same code explains ridge, forests,
 *    boosting and the MLP.
 *  - The background is REAL data (rows sampled from the training set, seeded
 *    PRNG) — expectations are computed over the actual distribution, never
 *    invented zeros.
 *  - Deterministic for a fixed seed: same model + row + background + seed ⇒
 *    identical attributions byte-for-byte.
 *  - Base value, per-feature attributions and the reconstruction error are
 *    all returned, so the caller can DISPLAY the additive guarantee instead
 *    of asking for trust.
 */

import { seededRandom } from "@/lib/engine/ml-training";
import { mean, variance } from "@/lib/engine/stats";

/** One feature's Shapley attribution for a single prediction. */
export interface ShapleyContribution {
  /** Feature name (design-matrix column label). */
  feature: string;
  /** φᵢ — the feature's additive contribution to this prediction. */
  phi: number;
  /** |φᵢ| rank convenience: the caller can sort; we return the raw order. */
  absPhi: number;
}

export interface ShapleyExplanation {
  /** f(x) — the model's actual output for the explained row. */
  prediction: number;
  /** E[f(background)] — the expectation every φᵢ adds up from. */
  baseValue: number;
  /** Per-feature attributions, sorted by |φᵢ| descending. */
  contributions: ShapleyContribution[];
  /** prediction − (baseValue + Σφ) — must be ≈ 0; sampled, so we prove it. */
  reconstructionError: number;
  /** Provenance: what was computed, how, with how many samples. */
  methodology: string;
}

/**
 * Permutation Shapley sampling for one row against a background sample.
 *
 * @param predict  The black-box scoring function over design-matrix rows.
 * @param x        The row to explain (design-matrix encoding).
 * @param background  Real rows (design-matrix encoding) forming the
 *                    expectation. 2–64 rows is the accuracy/speed sweet spot.
 * @param featureNames  Labels for the design columns (result order).
 * @param seed   Determinism control (default 42).
 * @param nPermutations  Random permutations to average (default 32).
 */
export function explainPrediction(
  predict: (x: number[]) => number,
  x: number[],
  background: number[][],
  featureNames: string[],
  seed = 42,
  nPermutations = 32,
): ShapleyExplanation {
  const p = x.length;
  if (p === 0) throw new Error("Cannot explain an empty row.");
  if (!background.length) throw new Error("Shapley explanations need a background sample of real rows.");
  if (nPermutations < 1) throw new Error("nPermutations must be at least 1.");

  const rand = seededRandom(seed);
  const prediction = predict(x);
  const baseValue = mean(background.map((b) => predict(b)));

  const phiSums = new Array<number>(p).fill(0);
  for (let r = 0; r < nPermutations; r++) {
    // One random order of the features.
    const order = Array.from({ length: p }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j] as number, order[i] as number];
    }
    // Average the marginal contribution over the background sample
    // (Strumbelj & Kononenko §3.2 — reduces variance vs a single z).
    for (const b of background) {
      let prev = predict(b);
      const z = [...b];
      for (const f of order) {
        z[f] = x[f] as number;
        const cur = predict(z);
        phiSums[f]! += cur - prev;
        prev = cur;
      }
    }
  }

  const divisor = nPermutations * background.length;
  const contributions: ShapleyContribution[] = featureNames.map((feature, f) => {
    const phi = phiSums[f]! / divisor;
    return { feature, phi, absPhi: Math.abs(phi) };
  });
  contributions.sort((a, b) => b.absPhi - a.absPhi);

  const sumPhi = contributions.reduce((s, c) => s + c.phi, 0);
  const reconstructionError = prediction - (baseValue + sumPhi);

  return {
    prediction,
    baseValue,
    contributions,
    reconstructionError,
    methodology:
      `Permutation Shapley sampling (Strumbelj & Kononenko 2014): ${nPermutations} seeded random feature permutations, ` +
      `marginal contributions averaged over ${background.length} background rows drawn from the training data. ` +
      `Additive guarantee: prediction ≈ base value + Σ attributions (reconstruction error ${reconstructionError.toExponential(2)}). ` +
      `Attributions are model-agnostic — they explain the prediction, they are NOT causal effects.`,
  };
}

/**
 * Global-style summary: explain a sample of rows and aggregate |φ| per
 * feature. Complements permutation importance with DIRECTIONAL, per-prediction
 * evidence — and unlike the in-sample importance it can be computed on any
 * rows the caller selects (e.g. held-out folds).
 */
export interface ShapleyGlobalSummary {
  /** feature → mean |φ| across explained rows (sorted desc). */
  meanAbsPhi: { feature: number; value: number }[];
  /** feature → mean signed φ across explained rows. */
  meanPhi: { feature: number; value: number }[];
  /** Rows explained (after the caller's cap). */
  rowsExplained: number;
  methodology: string;
}

/** Aggregate Shapley explanations over (up to) `maxRows` rows. */
export function summarizeShapley(
  predict: (x: number[]) => number,
  X: number[][],
  background: number[][],
  featureNames: string[],
  maxRows = 50,
  seed = 42,
): ShapleyGlobalSummary {
  if (!X.length) throw new Error("No rows to explain.");
  const p = featureNames.length;
  const absSum = new Array<number>(p).fill(0);
  const signedSum = new Array<number>(p).fill(0);
  const rows = X.slice(0, maxRows);
  rows.forEach((x, i) => {
    const exp = explainPrediction(predict, x, background, featureNames, seed + i, 8);
    exp.contributions.forEach((c) => {
      // contributions are sorted by |φ| — map back by feature name index.
      const idx = featureNames.indexOf(c.feature);
      absSum[idx]! += c.absPhi;
      signedSum[idx]! += c.phi;
    });
  });
  const k = rows.length || 1;
  const toSorted = (arr: number[]): { feature: number; value: number }[] =>
    arr.map((value, feature) => ({ feature, value: value / k })).sort((a, b) => b.value - a.value);
  return {
    meanAbsPhi: toSorted(absSum),
    meanPhi: toSorted(signedSum),
    rowsExplained: rows.length,
    methodology:
      `Mean |Shapley φ| across ${rows.length} rows (8 permutations each, seeded) — a directional complement to ` +
      `permutation importance. Global, still not causal.`,
  };
}

/** Convenience: variance of a column (used by tests to sanity-check spread). */
export function columnVariance(X: number[][], j: number): number {
  return variance(
    X.map((r) => r[j] as number),
    true,
  );
}
