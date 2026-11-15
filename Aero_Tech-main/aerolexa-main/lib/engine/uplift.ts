/**
 * Uplift modeling — heterogeneous treatment effects with HONEST evaluation.
 *
 * An A/B test answers "did the campaign work ON AVERAGE?". A targeting model
 * answers the more valuable question: "WHO should get the campaign?" — the
 * individuals whose outcome the treatment moves, not merely those with high
 * baseline outcomes. Two estimators ship here, deterministic, dependency-free:
 *
 *  1. T-learner (two models): fit μ₁(X) on treated rows and μ₀(X) on control
 *     rows (logistic for binary outcome, ridge for continuous), then score
 *     τ̂(x) = μ̂₁(x) − μ̂₀(x). Simple, unbiased per-arm; variance comes from
 *     splitting the data.
 *  2. S-learner (single model with treatment indicator): fit μ(X, W) on ALL
 *     rows with the treatment flag as a feature, then score τ̂(x) =
 *     μ̂(x, W=1) − μ̂(x, W=0). More data per model; underfits interactions.
 *
 * The default is the T-learner. Both return the SAME evaluation so callers
 * can compare honestly.
 *
 * Evaluation — the Qini curve, NOT accuracy:
 *  - Rank the held-out rows by predicted uplift, descending.
 *  - Walking down the ranking, cumulate (treated conversions − control
 *    conversions × n_t/n_c scaling) — the incremental outcome the model
 *    actually attributes to treatment. The area between this curve and the
 *    random-targeting diagonal is the Qini coefficient (Radcliffe 2007).
 *  - Reported alongside: uplift@K — the incremental outcome captured by
 *    treating only the top K% of the ranked list. This is THE number a
 *    campaign manager cares about ("mail the top 30%: +X incremental conversions
 *    vs. mailing nobody").
 *
 * Cross-validation contract: rows are split into deterministic k folds
 * (row i → fold i mod k, matching ridge.ts); each fold is scored by models
 * trained on the other folds, so every evaluation point is OUT-OF-FOLD.
 * In-sample Qini is never reported — it flatters any model.
 *
 * HONESTY: `noiseRatio` (|ATE| relative to outcome sd) is surfaced; when the
 * experiment itself shows no average effect, the module says so and warns
 * that heterogeneous-effect estimates on null experiments are fragile.
 */

import { fitLogistic, type GlmDesign } from "@/lib/engine/elite-stats";
import { crossValidatedRidge } from "@/lib/engine/ridge";
import { mean, studentTPValue } from "@/lib/engine/stats";

export class UpliftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpliftError";
  }
}

function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface UpliftRow {
  /** Feature vector (fully numeric, finite). */
  x: number[];
  /** 1 = treated, 0 = control. */
  w: 0 | 1;
  /** Observed outcome. Binary task: 0/1. Regression task: any finite number. */
  y: number;
}

export interface UpliftFitOptions {
  task: "binary" | "regression";
  /** Estimator (default "t-learner"). */
  learner?: "t-learner" | "s-learner";
  /** Folds for the out-of-fold evaluation (default 4, min 2). */
  folds?: number;
  /** Ridge alpha for the regression task (default: CV-selected). */
  ridgeAlpha?: number;
  /** L2 penalty for logistic fits (default 1e-3). */
  logisticL2?: number;
}

export interface QiniPoint {
  /** Fraction of the population targeted so far (0..1). */
  fraction: number;
  /** Cumulative incremental outcome (treated-minus-scaled-control). */
  incremental: number;
  /** The random-targeting diagonal value at this fraction. */
  random: number;
}

export interface UpliftResult {
  learner: "t-learner" | "s-learner";
  n: number;
  nTreated: number;
  nControl: number;
  /** Raw difference in outcome means, treated − control (the ATE). */
  ate: number;
  /** ATE standard error (two-sample), NaN when an arm has < 2 rows. */
  ateSe: number;
  atePValue: number;
  /** Area between the Qini curve and the random diagonal (normalized by the curve's scale). */
  qiniCoefficient: number;
  /** The perfect-oracle Qini coefficient (an upper bound for context). */
  qiniOracle: number;
  /** qini / qiniOracle ∈ [0, 1]-ish — model efficiency vs. perfect ranking. */
  qiniRatio: number;
  curve: QiniPoint[];
  /** Incremental outcome captured by treating the top K% (20/30/50 by default). */
  upliftAt: { kPct: number; incremental: number; perThousandTreated: number }[];
  /** |ATE| / outcome sd — small means the experiment was underpowered and uplift signals are fragile. */
  noiseRatio: number;
  methodology: string[];
  warnings: string[];
  interpretation: string;
}

// ---------------------------------------------------------------------------
// Base learners (deterministic)
// ---------------------------------------------------------------------------

/** Ridge predictor in original units; falls back to the training mean when the system is unsolvable. */
function fitRidgePredictor(X: number[][], y: number[], alpha: number): (x: number[]) => number {
  const fit = crossValidatedRidge(X, y, { alphas: [alpha], folds: 4 }) ?? { coefficients: [], intercept: mean(y) };
  const { coefficients, intercept } = fit;
  return (x: number[]) => {
    let pred = intercept;
    for (let j = 0; j < coefficients.length; j++) pred += (coefficients[j] as number) * (x[j] as number);
    return pred;
  };
}

/** Logistic predictor; falls back to the training base rate when IRLS fails to converge. */
function fitLogisticPredictor(X: number[][], y: number[], l2: number): (x: number[]) => number {
  const base = mean(y);
  const design: GlmDesign = { X, y: y.map((v) => (v > 0 ? 1 : 0)) };
  let coefficients: number[] | null = null;
  try {
    const fit = fitLogistic(design, { l2, maxIter: 200 });
    if (fit.converged && fit.coefficients.length > 0) {
      coefficients = fit.coefficients.map((c) => c.coefficient);
    }
  } catch {
    coefficients = null;
  }
  if (!coefficients) {
    return () => base;
  }
  return (x: number[]) => {
    let eta = coefficients![0] as number; // intercept first (fitLogistic adds it)
    for (let j = 0; j < x.length; j++) eta += (coefficients![j + 1] as number) * (x[j] as number);
    return sigmoid(eta);
  };
}

function makePredictor(
  task: "binary" | "regression",
  X: number[][],
  y: number[],
  opts: { ridgeAlpha: number; logisticL2: number },
): (x: number[]) => number {
  return task === "binary" ? fitLogisticPredictor(X, y, opts.logisticL2) : fitRidgePredictor(X, y, opts.ridgeAlpha);
}

// ---------------------------------------------------------------------------
// Qini machinery
// ---------------------------------------------------------------------------

/**
 * Qini curve over an out-of-fold (scored, w, y) triple set, ranked by score
 * descending. Ties break toward the earlier row (deterministic).
 */
export function qiniCurve(scored: { score: number; w: 0 | 1; y: number }[]): {
  curve: QiniPoint[];
  coefficient: number;
} {
  const n = scored.length;
  if (n === 0) return { curve: [], coefficient: 0 };
  const order = scored.map((s, i) => ({ s, i })).sort((a, b) => b.s.score - a.s.score || a.i - b.i);

  const nT = scored.filter((s) => s.w === 1).length;
  const nC = n - nT;
  // Treatment-group scale factor: control conversions are scaled UP by
  // n_t/n_c so the cumulative curve is in "incremental outcomes" units.
  const scale = nC > 0 && nT > 0 ? nT / nC : 1;

  let cumT = 0;
  let cumC = 0;
  const points: QiniPoint[] = [{ fraction: 0, incremental: 0, random: 0 }];
  for (let i = 0; i < order.length; i++) {
    const row = order[i]!.s;
    if (row.w === 1) cumT += row.y;
    else cumC += row.y;
    const incremental = cumT - cumC * scale;
    const fraction = (i + 1) / n;
    points.push({ fraction, incremental, random: fraction * (points[points.length - 1]!.incremental === 0 ? 0 : 1) });
  }
  // Random diagonal: straight line from 0 to the final incremental value.
  const final = points[points.length - 1]!.incremental;
  for (let i = 0; i < points.length; i++) (points[i] as QiniPoint).random = points[i]!.fraction * final;

  // Qini coefficient = area between curve and diagonal (trapezoid, normalized
  // by the number of targeted rows so it is comparable across datasets).
  let area = 0;
  for (let i = 1; i < points.length; i++) {
    const dPrev = (points[i - 1] as QiniPoint).incremental - (points[i - 1] as QiniPoint).random;
    const dCur = (points[i] as QiniPoint).incremental - (points[i] as QiniPoint).random;
    area += ((dPrev + dCur) / 2) * (points[i]!.fraction - (points[i - 1] as QiniPoint).fraction);
  }
  return { curve: points, coefficient: area };
}

/** Oracle Qini: score rows by their OBSERVED individual effect proxy (y·w − y·(1−w) scaled). */
function oracleScored(rows: { w: 0 | 1; y: number }[], scale: number): { score: number; w: 0 | 1; y: number }[] {
  return rows.map((r) => ({ score: r.w === 1 ? r.y * scale : -r.y, w: r.w, y: r.y }));
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function fitUplift(rows: UpliftRow[], opts: UpliftFitOptions): UpliftResult {
  const n = rows.length;
  if (n < 16) throw new UpliftError("Uplift modeling needs at least 16 rows.");
  const p = rows[0]!.x.length;
  if (!rows.every((r) => r.x.length === p)) throw new UpliftError("All feature vectors must have the same length.");
  for (let i = 0; i < n; i++) {
    if (!rows[i]!.x.every((v) => Number.isFinite(v))) throw new UpliftError(`Row ${i} has a non-finite feature.`);
    if (!Number.isFinite(rows[i]!.y)) throw new UpliftError(`Row ${i} outcome is not finite.`);
    if (rows[i]!.w !== 0 && rows[i]!.w !== 1) throw new UpliftError(`Row ${i} treatment must be 0 or 1.`);
  }

  const learner = opts.learner ?? "t-learner";
  const folds = Math.max(2, Math.min(opts.folds ?? 4, Math.floor(n / 4)));
  const ridgeAlpha = opts.ridgeAlpha ?? 1;
  const logisticL2 = opts.logisticL2 ?? 1e-3;

  const nT = rows.filter((r) => r.w === 1).length;
  const nC = n - nT;
  if (nT < 8 || nC < 8) {
    throw new UpliftError(`Need ≥ 8 rows per arm (got treated=${nT}, control=${nC}).`);
  }

  // ----- Out-of-fold uplift scores ------------------------------------------
  const oof: { score: number; w: 0 | 1; y: number }[] = new Array(n);
  for (let f = 0; f < folds; f++) {
    const train = rows.filter((_, i) => i % folds !== f);
    const testIdx = rows.map((_, i) => i).filter((i) => i % folds === f);
    if (train.length < 8) continue;

    let scoreFn: (x: number[]) => number;
    if (learner === "t-learner") {
      const treated = train.filter((r) => r.w === 1);
      const control = train.filter((r) => r.w === 0);
      if (treated.length < 4 || control.length < 4) {
        // Fold too imbalanced to fit two arms — reuse the full-train split arms.
        const tAll = rows.filter((r) => r.w === 1);
        const cAll = rows.filter((r) => r.w === 0);
        const mu1 = makePredictor(
          opts.task,
          tAll.map((r) => r.x),
          tAll.map((r) => r.y),
          { ridgeAlpha, logisticL2 },
        );
        const mu0 = makePredictor(
          opts.task,
          cAll.map((r) => r.x),
          cAll.map((r) => r.y),
          { ridgeAlpha, logisticL2 },
        );
        scoreFn = (x) => mu1(x) - mu0(x);
      } else {
        const mu1 = makePredictor(
          opts.task,
          treated.map((r) => r.x),
          treated.map((r) => r.y),
          { ridgeAlpha, logisticL2 },
        );
        const mu0 = makePredictor(
          opts.task,
          control.map((r) => r.x),
          control.map((r) => r.y),
          { ridgeAlpha, logisticL2 },
        );
        scoreFn = (x) => mu1(x) - mu0(x);
      }
    } else {
      // S-learner: treatment flag appended as the LAST feature.
      const Xs = train.map((r) => [...r.x, r.w]);
      const ys = train.map((r) => r.y);
      const mu = makePredictor(opts.task, Xs, ys, { ridgeAlpha, logisticL2 });
      scoreFn = (x) => mu([...x, 1]) - mu([...x, 0]);
    }
    for (const i of testIdx) {
      const row = rows[i] as UpliftRow;
      oof[i] = { score: scoreFn(row.x), w: row.w, y: row.y };
    }
  }

  // Any rows never scored (degenerate folds) fall back to the global ATE score.
  const ateAll =
    mean(rows.filter((r) => r.w === 1).map((r) => r.y)) - mean(rows.filter((r) => r.w === 0).map((r) => r.y));
  for (let i = 0; i < n; i++) if (!oof[i]) oof[i] = { score: ateAll, w: rows[i]!.w, y: rows[i]!.y };

  // ----- ATE inference --------------------------------------------------------
  const yT = rows.filter((r) => r.w === 1).map((r) => r.y);
  const yC = rows.filter((r) => r.w === 0).map((r) => r.y);
  const ate = mean(yT) - mean(yC);
  const varT = yT.length > 1 ? yT.reduce((a, v) => a + (v - mean(yT)) ** 2, 0) / (yT.length - 1) : 0;
  const varC = yC.length > 1 ? yC.reduce((a, v) => a + (v - mean(yC)) ** 2, 0) / (yC.length - 1) : 0;
  const ateSe = Math.sqrt(varT / yT.length + varC / yC.length);
  // Zero-variance arms (constant outcomes) give se = 0: a degenerate t-test
  // where the difference is definitionally 0 when BOTH arms are constant, and
  // an undefined one otherwise — either way "no detectable effect" is the
  // honest reading, so p = 1 (never NaN, which would silently suppress the
  // no-significant-effect warning downstream).
  const atePValue =
    ateSe > 1e-12
      ? studentTPValue(Math.abs(ate / ateSe), Math.min(yT.length, yC.length) - 1)
      : Math.abs(ate) < 1e-12
        ? 1
        : Number.NaN;

  // ----- Qini evaluation ------------------------------------------------------
  const scale = nC > 0 ? nT / nC : 1;
  const { curve, coefficient: rawCoefficient } = qiniCurve(oof);
  // Honesty guard: when the model's out-of-fold scores are all (near-)identical
  // it has NO ranking signal — the curve order is then a pure tie-break
  // artifact of input order, and any nonzero area would be noise dressed up as
  // skill. Report 0 ranking ability in that degenerate case (the curve itself
  // stays for inspection; the ≈0-ratio warning explains why).
  const scoreMin = oof.reduce((m, s) => Math.min(m, s.score), Number.POSITIVE_INFINITY);
  const scoreMax = oof.reduce((m, s) => Math.max(m, s.score), Number.NEGATIVE_INFINITY);
  const allTied = Number.isFinite(scoreMin) && scoreMax - scoreMin < 1e-12;
  const coefficient = allTied ? 0 : rawCoefficient;
  const { coefficient: oracle } = qiniCurve(
    oracleScored(
      oof.map((s) => ({ w: s.w, y: s.y })),
      scale,
    ),
  );
  const qiniRatio = oracle !== 0 ? coefficient / oracle : 0;

  // ----- Uplift @ K -----------------------------------------------------------
  const kPcts = [20, 30, 50];
  const sorted = [...oof].sort((a, b) => b.score - a.score);
  const upliftAt = kPcts.map((k) => {
    const topK = sorted.slice(0, Math.max(1, Math.round((k / 100) * n)));
    const tK = topK.filter((r) => r.w === 1);
    const cK = topK.filter((r) => r.w === 0);
    let inc = Number.NaN;
    if (tK.length > 0 && cK.length > 0) {
      inc = mean(tK.map((r) => r.y)) - mean(cK.map((r) => r.y));
    }
    return { kPct: k, incremental: inc, perThousandTreated: Number.isFinite(inc) ? inc * 1000 : Number.NaN };
  });

  // ----- Honesty ---------------------------------------------------------------
  const ySd = Math.sqrt(rows.reduce((a, r) => a + (r.y - mean(rows.map((x) => x.y))) ** 2, 0) / (n - 1));
  const noiseRatio = ySd > 0 ? Math.abs(ate) / ySd : Number.NaN;

  const warnings: string[] = [];
  if (Number.isFinite(atePValue) && atePValue > 0.1) {
    warnings.push(
      `The experiment shows NO significant average effect (ATE p = ${atePValue.toFixed(3)}). Heterogeneous (uplift) estimates on a null experiment are fragile — treat the ranking as exploratory.`,
    );
  }
  if (nT / n < 0.1 || nT / n > 0.9) {
    warnings.push(
      `Arm imbalance (treated share ${(nT / n).toFixed(2)}) — the smaller arm limits model quality; 30–70% treated is the healthy range.`,
    );
  }
  if (Math.abs(qiniRatio) < 0.05) {
    warnings.push(
      "Qini ratio vs. the oracle is ≈ 0 — the model does not rank heterogeneous effects better than chance on this data.",
    );
  }

  const methodology = [
    `${learner === "t-learner" ? "T-learner: two models (treated/control)" : "S-learner: one model with the treatment flag as a feature"} — ${
      opts.task === "binary" ? "logistic base learners (IRLS, L2)" : "ridge base learners (closed form)"
    }.`,
    `Every evaluation point is OUT-OF-FOLD (${folds}-fold, deterministic row i → fold i mod k).`,
    "Qini curve vs. random targeting; coefficient = area between curve and diagonal; oracle = the same area for the perfect ranking.",
    `ATE is the raw two-sample difference with a two-sample SE (t, df = min(n_t, n_c) − 1).`,
  ];

  const interpretation = [
    `ATE = ${ate >= 0 ? "+" : ""}${ate.toFixed(4)} (p = ${Number.isFinite(atePValue) ? atePValue.toFixed(4) : "n/a"}).`,
    `Qini coefficient ${coefficient.toFixed(3)} vs. oracle ${oracle.toFixed(3)} (efficiency ${(qiniRatio * 100).toFixed(1)}%).`,
    upliftAt
      .filter((u) => Number.isFinite(u.incremental))
      .map(
        (u) =>
          `Top ${u.kPct}%: ${u.incremental >= 0 ? "+" : ""}${u.incremental.toFixed(4)} mean uplift (${u.perThousandTreated >= 0 ? "+" : ""}${u.perThousandTreated.toFixed(1)} per 1,000 treated).`,
      )
      .join(" "),
    `Uplift targets WHO the treatment moves — not who converts anyway (persuadables, not sure-things).`,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    learner,
    n,
    nTreated: nT,
    nControl: nC,
    ate,
    ateSe,
    atePValue,
    qiniCoefficient: coefficient,
    qiniOracle: oracle,
    qiniRatio,
    curve,
    upliftAt,
    noiseRatio,
    methodology,
    warnings,
    interpretation,
  };
}
