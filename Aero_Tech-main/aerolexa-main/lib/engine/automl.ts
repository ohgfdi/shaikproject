/**
 * AutoML-lite — automatic model + hyperparameter selection over the SAME
 * deterministic trainers in `ml-training.ts`.
 *
 * The advanced trainer already had real algorithms (ridge, logistic/softmax,
 * CART, random forest, kNN, Friedman gradient boosting) and honest out-of-fold
 * CV. What it lacked is the outer loop every AutoML system provides: TRY MANY
 * configurations, score them on the SAME folds, and hand back the winner with
 * its full leaderboard — so the user sees WHY a model won, not just that one
 * did.
 *
 * Design (matches the repo's trust bar):
 *  - Reuses `makeFolds` with the request seed so every candidate is scored on
 *    IDENTICAL fold assignments — a paired comparison, not fold lottery.
 *  - Grids are small and deterministic (no random search): per algorithm the
 *    repo's proven defaults plus 2 sensible alternatives per tuned knob.
 *  - `maxCandidates` caps total fits (candidates × folds × refit) so the loop
 *    stays interactive; the cap keeps the FIRST candidates in a fixed order
 *    (algorithms in registry order, grid points in listed order).
 *  - Every candidate carries its CV metric; ties break by fit cost (fewer
 *    trees/simpler model first) then name — deterministic.
 *  - The winner is retrained through `trainWithCv`, so the returned result is
 *    the SAME shape the registry/UI already consume (artifact, importance,
 *    methodology) with an added `automl` block.
 *
 * Honest labelling: the selection metric is out-of-fold; the winner's final
 * metrics come from trainWithCv and keep their in-sample labels. The
 * leaderboard reports per-candidate fold metrics — no test-set leakage
 * anywhere (there is no test set at all; selection is CV-internal).
 */

import { evaluateBlendedEnsemble, type EnsembleMemberSpec } from "@/lib/engine/ensemble";
import {
  trainWithCv,
  type MlSource,
  type MlTrainRequest,
  type MlTask,
  type MlAlgorithm,
  type MlTrainResult,
  type MlArtifact,
  MlError,
} from "@/lib/engine/ml-training";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutoMlCandidate {
  algorithm: MlAlgorithm;
  hyperparams: Record<string, number>;
  /** Out-of-fold selection metric (lower is better for rmse). */
  score: number;
  /** Per-fold scores, same folds for every candidate. */
  perFold: number[];
  /** Number of model fits this candidate needed (folds + 1 full refit) — the tie-break proxy for cost. */
  fits: number;
  /** True when this candidate was the overall winner. */
  winner?: boolean;
}

export interface AutoMlResult {
  /** The full trainWithCv result for the winning configuration. */
  best: MlTrainResult;
  /** Deterministic leaderboard, best first. */
  leaderboard: AutoMlCandidate[];
  /** The metric name selection optimized. */
  metricName: "rmse" | "rocAuc" | "accuracy";
  methodology: string[];
  /**
   * Present when the blended ensemble (top members refit per fold, OOF
   * combined) OUT-performed the winner. The winner artifact carries the
   * servable `ensemble` block — predicting serves the blend, not the single
   * model; the leaderboard/provenance keep both numbers.
   */
  ensemble?: {
    oofScore: number;
    perFold: number[];
    combiner: string;
    members: string[];
    methodology: string[];
  };
}

interface GridPoint {
  hyperparams: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Grids — small, deterministic, centered on the repo's proven defaults
// ---------------------------------------------------------------------------

/** Candidate algorithms per task, in fixed try order. */
function algorithmsFor(task: MlTask): MlAlgorithm[] {
  if (task === "regression") return ["ridge", "decision-tree", "random-forest", "gradient-boosting", "knn", "mlp"];
  return ["logistic", "decision-tree", "random-forest", "gradient-boosting", "knn", "mlp"];
}

function gridFor(algorithm: MlAlgorithm): GridPoint[] {
  switch (algorithm) {
    case "ridge":
      return [{ lambda: 0.1 }, { lambda: 1 }, { lambda: 10 }].map((h) => ({ hyperparams: h }));
    case "logistic":
      return [{ lambda: 0.1 }, { lambda: 1 }].map((h) => ({ hyperparams: h }));
    case "decision-tree":
      return [
        { maxDepth: 4, minLeaf: 2 },
        { maxDepth: 6, minLeaf: 3 },
        { maxDepth: 10, minLeaf: 5 },
      ].map((h) => ({ hyperparams: h }));
    case "random-forest":
      return [
        { nTrees: 40, maxDepth: 6, minLeaf: 2 },
        { nTrees: 80, maxDepth: 8, minLeaf: 2 },
      ].map((h) => ({ hyperparams: h }));
    case "gradient-boosting":
      return [
        { nTrees: 60, learningRate: 0.1, maxDepth: 3, minLeaf: 2 },
        { nTrees: 100, learningRate: 0.05, maxDepth: 3, minLeaf: 2 },
      ].map((h) => ({ hyperparams: h }));
    case "knn":
      return [{ k: 3 }, { k: 5 }, { k: 9 }].map((h) => ({ hyperparams: h }));
    case "mlp":
      // Small deterministic nets: the interaction-capable dark-horse candidate.
      // Modest epochs keep the whole grid interactive; the third point probes
      // the DEPTH axis (3 layers) the classic engine could not express.
      return (
        [
          { hiddenUnits: 16, epochs: 120 },
          { hiddenUnits: 32, epochs: 120 },
          { hiddenUnits: 32, hiddenLayers: 3, epochs: 120 },
        ] as Record<string, number>[]
      ).map((h) => ({ hyperparams: h }));
  }
}

/** Cost proxy for tie-breaking: total fits weighted by ensemble size. */
function costOf(_algorithm: MlAlgorithm, hyperparams: Record<string, number>, folds: number): number {
  const trees = hyperparams.nTrees ?? 1;
  const epochs = hyperparams.epochs ?? 0; // MLP epoch cost counts against ties
  const layers = hyperparams.hiddenLayers ?? 0; // deeper stacks cost more too
  return (folds + 1) * trees + epochs + layers * 16;
}

/** ABOVE this row count the ensemble's members × folds refits stay out of interactive budget. */
const ENSEMBLE_MAX_ROWS = 20_000;
/** Ensemble probes at most this many folds regardless of the grid's fold count. */
const ENSEMBLE_MAX_FOLDS = 5;

/**
 * The ensemble's member set: the TOP leaderboard entries with DISTINCT
 * algorithms (a blend of same-algorithm grid points just averages one
 * algorithm family, which gradient-boosting already is). Diversity —
 * parametric vs tree vs instance-based vs neural — is the point.
 */
function ensembleMembers(candidates: AutoMlCandidate[], maxMembers = 3): EnsembleMemberSpec[] {
  const used = new Set<string>();
  const out: EnsembleMemberSpec[] = [];
  for (const c of candidates) {
    if (used.has(c.algorithm)) continue;
    used.add(c.algorithm);
    out.push({ algorithm: c.algorithm, hyperparams: c.hyperparams });
    if (out.length >= maxMembers) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

/**
 * Score one candidate on the SHARED folds (out-of-fold). Delegates to
 * trainWithCv with the candidate's algorithm/hyperparams — identical fold
 * derivation (same seed + stratified makeFolds), so scores are comparable
 * across candidates by construction.
 */
function scoreCandidate(source: MlSource, req: MlTrainRequest, seed: number): { score: number; perFold: number[] } {
  const probe = trainWithCv(source, { ...req, seed });
  return { score: probe.cv.mean, perFold: probe.cv.perFold };
}

/** Number of distinct algorithm families on the leaderboard. */
function distinctAlgorithms(candidates: AutoMlCandidate[]): number {
  return new Set(candidates.map((c) => c.algorithm)).size;
}

/**
 * Run the AutoML search: every algorithm's grid is scored with identical
 * folds; the winner is retrained via `trainWithCv` for the full result.
 *
 * @param source  The encoded-ready raw table (same shape as trainWithCv).
 * @param req     Task + target/features; hyperparams on `req` are IGNORED for
 *                candidates (the grid supplies them) but respected as the
 *                base request (task, targetColumn, featureColumns, cvFolds, seed).
 * @param maxCandidates  Hard cap on scored candidates (default 12).
 */
export function autoTrain(source: MlSource, req: MlTrainRequest, maxCandidates = 12): AutoMlResult {
  const n = source.rows.length;
  if (n < 12) throw new MlError("Training needs at least 12 rows.");
  const folds = Math.max(2, Math.min(req.cvFolds ?? 5, 10));
  if (folds > n) throw new MlError("More CV folds than rows.");
  const seed = req.seed ?? 42;

  // Baseline probe: establishes the task's selection metric name from the
  // SAME fold machinery every candidate will use.
  const probe = trainWithCv(source, { ...req, cvFolds: folds, seed });
  const metricName = probe.cv.metricName;

  const candidates: AutoMlCandidate[] = [];
  const higherIsBetter = metricName !== "rmse";

  outer: for (const algorithm of algorithmsFor(req.task)) {
    for (const point of gridFor(algorithm)) {
      if (candidates.length >= maxCandidates) break outer;
      const candidateReq: MlTrainRequest = { ...req, algorithm, ...point.hyperparams, cvFolds: folds, seed };
      let scored: { score: number; perFold: number[] };
      try {
        scored = scoreCandidate(source, candidateReq, seed);
      } catch {
        // A candidate that cannot fit (e.g. logistic on multiclass) is
        // skipped — the leaderboard only holds REAL, fitted configurations.
        continue;
      }
      candidates.push({
        algorithm,
        hyperparams: point.hyperparams,
        score: scored.score,
        perFold: scored.perFold,
        fits: folds + 1,
      });
    }
  }
  if (candidates.length === 0) throw new MlError("No candidate configuration could be fitted on this data.");

  // Winner: best score; ties break by fit cost (simpler first), then
  // algorithm name then hyperparam signature — fully deterministic.
  const sign = higherIsBetter ? -1 : 1;
  candidates.sort(
    (a, b) =>
      sign * (a.score - b.score) ||
      costOf(a.algorithm, a.hyperparams, folds) - costOf(b.algorithm, b.hyperparams, folds) ||
      a.algorithm.localeCompare(b.algorithm) ||
      JSON.stringify(a.hyperparams).localeCompare(JSON.stringify(b.hyperparams)),
  );
  const winner = candidates[0]!;
  winner.winner = true;

  // Final full result through the real trainer (artifact, importance, labels).
  const best = trainWithCv(source, {
    ...req,
    algorithm: winner.algorithm,
    ...winner.hyperparams,
    cvFolds: folds,
    seed,
  });

  // Ensemble probe: can a DIVERSE blend of the top members beat the winner
  // out-of-fold? Runs only within interactive budget (row gate above); any
  // failure falls back to the single-model winner — never a dead end.
  let ensemble: AutoMlResult["ensemble"];
  const members = ensembleMembers(candidates);
  if (members.length >= 2 && distinctAlgorithms(candidates) >= 2 && source.rows.length <= ENSEMBLE_MAX_ROWS) {
    try {
      const evaluated = evaluateBlendedEnsemble(
        source,
        { ...req, algorithm: winner.algorithm },
        members,
        Math.min(folds, ENSEMBLE_MAX_FOLDS),
        seed,
        metricName,
      );
      const better = higherIsBetter ? evaluated.oofScore > winner.score : evaluated.oofScore < winner.score;
      if (better) {
        ensemble = {
          oofScore: evaluated.oofScore,
          perFold: evaluated.perFold,
          combiner: evaluated.combiner,
          members: evaluated.block.members.map((m) => `${m.algorithm}(${JSON.stringify(m.hyperparams)})`),
          methodology: evaluated.methodology,
        };
        (best.artifact as MlArtifact).ensemble = evaluated.block;
        best.methodology.push(...evaluated.methodology.map((m) => `Ensemble serve override: ${m}`));
      }
    } catch {
      // An ensemble that cannot be evaluated (fold degeneracy, member refit
      // failure) silently KEEP the single-model winner — AutoML must always
      // return a valid result, the blend is an upside, never a requirement.
    }
  }

  const methodology = [
    `AutoML-lite: ${candidates.length} algorithm × hyperparameter configurations were scored on the SAME ${folds} stratified CV folds (out-of-fold ${metricName}); the winner is refit by the standard trainer — selection never touches a test set.`,
    `Leaderboard: ${candidates
      .slice(0, 5)
      .map((c) => `${c.algorithm}(${JSON.stringify(c.hyperparams)}) = ${Number(c.score).toFixed(4)}`)
      .join("; ")}.`,
    ...best.methodology,
    `Selection ties break toward simpler models (fewer ensemble members). Deterministic: same data + seed ⇒ same winner.`,
  ];
  if (ensemble) {
    methodology.push(
      `Ensemble verdict: a ${ensemble.members.length}-member blend (${ensemble.combiner}) scored OOF ${ensemble.oofScore.toFixed(4)} and BEAT the best single model (${winner.score.toFixed(4)}) — predictions serve the blend; both artifacts are attached.`,
    );
  }

  return { best, leaderboard: candidates, metricName, methodology, ...(ensemble ? { ensemble } : {}) };
}

export type { MlTrainRequest, MlTask, MlAlgorithm, MlTrainResult };
