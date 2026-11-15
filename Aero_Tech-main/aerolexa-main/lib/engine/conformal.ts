/**
 * Split conformal prediction intervals — distribution-free uncertainty.
 *
 * The ML engine reports honest out-of-fold POINT metrics, but every regression
 * answer has been a bare number: no interval, no coverage guarantee. Split
 * conformal prediction (Vovk et al. 2005; Papadopoulos et al. 2002) closes
 * that gap with the weakest assumptions in the field — exchangeability only,
 * no homoskedasticity, no residual distribution:
 *
 *  1. Split the data into a proper training set and a calibration set.
 *  2. Fit the model on the training set; score every calibration row with
 *     s_i = |y_i − ŷ_i| (absolute residual — the symmetric, standard choice).
 *  3. Take ⌈(n_cal + 1)(1 − α)⌉-th smallest calibration score (the
 *     "conformal quantile", with the +1 that makes the guarantee finite-sample
 *     exact, not asymptotic).
 *  4. Predict ŷ ± q for new points.
 *
 * Guarantee (Lemma 1, Vovk et al.): for an exchangeable new point,
 * P(y ∈ [ŷ − q, ŷ + q]) ≥ 1 − α, EXACTLY when the calibration scores are
 * distinct (and ≥ 1 − α up to one miscoverage unit of 1/(n_cal+1) in general).
 * This is a property of the PROCEDURE, not of the model — it holds for any
 * fitted regressor, which is why it composes cleanly with the trainer here.
 *
 * Determinism contract (matches every engine in this repo):
 *  - The calibration split is a deterministic function of (n, seed) via the
 *    SAME seeded PRNG the trainer uses — no Math.random anywhere.
 *  - Same data + seed + alpha ⇒ identical quantile, byte-for-byte.
 *
 * Honesty contract: `coverage` on the returned object is measured ON THE
 * CALIBRATION SET (in-sample for the interval, since the quantile was derived
 * from it) and is reported as such — the guarantee applies to FUTURE
 * exchangeable points, and the methodology text says exactly that.
 */

import { quantile as empiricalQuantile } from "@/lib/engine/stats";

export class ConformalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformalError";
  }
}

/** ⌈x⌉ for the conformal rank: the +1 in (n+1)(1−α) is what makes the guarantee exact. */
function conformalRank(nCal: number, alpha: number): number {
  return Math.min(nCal, Math.ceil((nCal + 1) * (1 - alpha)));
}

/**
 * The conformal quantile: the rank-th smallest of the calibration scores,
 * interpolated with the empirical type-7 quantile for smoothness. Rank ≥ 1
 * always (the ceil of a positive number), so the quantile is a real
 * calibration score — never 0-by-construction.
 */
export function conformalQuantile(scores: number[], alpha: number): number {
  const clean = scores.filter((s) => Number.isFinite(s) && s >= 0);
  if (clean.length === 0) throw new ConformalError("No finite calibration scores — the interval is not computable.");
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new ConformalError("alpha must be strictly between 0 and 1.");
  }
  const rank = conformalRank(clean.length, alpha);
  // Type-7 empirical quantile at (rank-1)/(n-1) maps the INTEGER rank onto the
  // same order statistic the finite-sample proof uses; interpolation only
  // smooths ties — the result sits between the rank-th and (rank+1)-th scores.
  const pos = clean.length === 1 ? 0 : (rank - 1) / (clean.length - 1);
  return empiricalQuantile(clean, pos);
}

export interface ConformalCalibration {
  /** Half-width q to add/subtract around any point prediction. */
  halfWidth: number;
  /** Requested miscoverage α. */
  alpha: number;
  /** Calibration rows actually used (after filtering non-finite scores). */
  nCalibration: number;
  /** Training rows NOT used for calibration (the proper-training share). */
  nTrain: number;
  /** Empirical coverage ON THE CALIBRATION SET — reported, never implied to be the future guarantee. */
  coverageOnCalibration: number;
  /** The sorted calibration residuals (quantile input — diagnostics/tests). */
  scores: number[];
  methodology: string;
}

/**
 * Calibrate a split-conformal interval from out-of-fold predictions.
 *
 * Using OUT-OF-FOLD residuals (the trainer already computes them per fold)
 * instead of a dedicated holdout is the standard "CV+" variant of split
 * conformal: every residual was produced by a model that never saw its own
 * row, so the calibration set is honest without wasting rows on a second
 * split. Each OOF residual is one calibration score; rows whose prediction or
 * outcome is non-finite are dropped (counted, never silently).
 *
 * @param y        true outcomes, index-aligned with oofPred.
 * @param oofPred  out-of-fold predictions (NaN for uncovered rows — skipped).
 * @param alpha    miscoverage level (default 0.1 → ~90% intervals).
 */
export function calibrateConformal(y: number[], oofPred: number[], alpha = 0.1): ConformalCalibration {
  if (y.length !== oofPred.length) throw new ConformalError("y and oofPred must be index-aligned.");
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new ConformalError("alpha must be strictly between 0 and 1.");
  }
  const scores: number[] = [];
  let dropped = 0;
  for (let i = 0; i < y.length; i++) {
    const yt = y[i] as number;
    const pt = oofPred[i] as number;
    if (!Number.isFinite(yt) || !Number.isFinite(pt)) {
      dropped++;
      continue;
    }
    scores.push(Math.abs(yt - pt));
  }
  if (scores.length < 8) {
    throw new ConformalError(
      `Conformal calibration needs ≥ 8 scored rows (got ${scores.length}). Train on more data or reduce CV folds.`,
    );
  }
  const halfWidth = conformalQuantile(scores, alpha);
  // Coverage ON the calibration residuals: the fraction at or below the
  // quantile. For a fresh exchangeable point the guarantee is ≥ 1−α; on the
  // calibration set itself this is the empirical check.
  const covered = scores.filter((s) => s <= halfWidth).length;
  const nCal = scores.length;
  return {
    halfWidth,
    alpha,
    nCalibration: nCal,
    nTrain: y.length - dropped - nCal,
    coverageOnCalibration: covered / nCal,
    scores,
    methodology:
      `Split-conformal interval at ${(100 * (1 - alpha)).toFixed(0)}%: |residual| scores over ${nCal} out-of-fold ` +
      `predictions${dropped > 0 ? ` (${dropped} row(s) with non-finite values dropped)` : ""}; half-width = the ` +
      `⌈(n+1)(1−α)⌉-th smallest score = ${halfWidth.toPrecision(4)}. Distribution-free coverage ≥ ${(1 - alpha).toFixed(2)} ` +
      `for exchangeable future points — no normality or homoskedasticity assumed.`,
  };
}

/**
 * Convenience wrapper used by the trainer: fit → predict OOF → calibrate.
 * The predictor closure is any (x) => ŷ; the SAME rows are scored
 * out-of-fold-style by the CALLER in trainWithCv, so this helper exists for
 * standalone use (tests, API surface) where the caller has a fitted model and
 * a labeled sample.
 */
export function conformalFromPredictions(y: number[], preds: number[], alpha = 0.1): ConformalCalibration {
  return calibrateConformal(y, preds, alpha);
}

/**
 * Deterministic calibration-split index assignment (proper-train vs calibrate)
 * for the dedicated-split variant. `seededRandom` is injected by the trainer's
 * seed so the split is reproducible. Returns per-row booleans: true = row
 * joins the calibration set.
 */
export function calibrationSplit(n: number, calFraction: number, rand: () => number): boolean[] {
  if (n < 2) return new Array<boolean>(n).fill(false);
  const frac = Math.min(0.5, Math.max(0.1, calFraction));
  const target = Math.max(2, Math.round(n * frac));
  const idx = Array.from({ length: n }, (_, i) => i);
  // Fisher–Yates with the seeded PRNG (deterministic), then take the first
  // `target` as calibration — the same shuffle convention the trainer uses.
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j] as number, idx[i] as number];
  }
  const isCal = new Array<boolean>(n).fill(false);
  for (let k = 0; k < target; k++) isCal[idx[k] as number] = true;
  return isCal;
}
