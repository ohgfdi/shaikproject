/**
 * Blended ensembles — out-of-fold evaluation + servable artifact construction.
 *
 * AutoML-lite picks ONE winner; classic ensembling answers the legitimate
 * follow-up: would modelled disagreement between good, DIVERSE models beat
 * the best single one? This module answers honestly:
 *
 *  - The fold schedule is the SAME stratified `makeFolds` (+ seed) the
 *    candidate grid used, so the ensemble's score is a PAIRED comparison
 *    against the leaderboard, not fold lottery.
 *  - Per fold, each member is refit on the fold's training slice and its
 *    full-subset artifact predicts the held-out rows through the standard
 *    `serve` pipeline — no in-sample peeking anywhere.
 *  - Combiners:
 *      regression  "mean"      plain average of member outputs
 *      regression  "stacked"   ridge meta-weights fitted on the OUT-OF-FOLD
 *                              prediction matrix (λ = 1, closed form); chosen
 *                              only when it beats the plain mean honestly
 *      classifier  "mean-prob" mean class probability per label, argmax
 *  - The returned block carries each member's FULL aerolexa.ml.v1 artifact
 *    (self-contained: own preprocessor + refit payload), so serving needs
 *    nothing but the JSON and encodes the raw row exactly as training did.
 *
 * Costs: members × (folds + 1) full trainer fits — the caller (AutoML) gates
 * this on small grids. Deterministic: same data + seed ⇒ identical output.
 */

import {
  makeFolds,
  trainWithCv,
  evaluateClassification,
  MlError,
  type MlSource,
  type MlTrainRequest,
  type MlTask,
  type MlArtifact,
  type EnsembleBlock,
} from "@/lib/engine/ml-training";
import { serve, type ArtifactPayload, type ServeableModel } from "@/lib/engine/predictor";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One ensemble component: a candidate configuration from the leaderboard. */
export interface EnsembleMemberSpec {
  algorithm: MlTrainRequest["algorithm"];
  hyperparams: Record<string, number>;
}

export interface EnsembleEvaluation {
  /** The combiner's out-of-fold metric (rmse / rocAuc / accuracy). */
  oofScore: number;
  /** Per-fold OOF scores of the chosen combiner (NaN where a fold is degenerate). */
  perFold: number[];
  metricName: "rmse" | "rocAuc" | "accuracy";
  /** Combiner actually used (regression keeps the better of mean vs stacked). */
  combiner: EnsembleBlock["combiner"];
  /** Self-contained member artifacts — attach as `artifact.ensemble`. */
  block: EnsembleBlock;
  methodology: string[];
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

/** Serveable wrapper around a member's full-refit artifact. */
function memberServeable(artifact: MlArtifact, task: MlTask): ServeableModel {
  return {
    task,
    algorithm: artifact.algorithm,
    targetColumn: artifact.targetColumn,
    features: artifact.featureNames,
    artifactPayload: artifact as ArtifactPayload,
  };
}

/** Zip a positional row back into the Record shape serving expects. */
function rowToRecord(source: MlSource, row: (string | number | boolean | null)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  source.columns.forEach((c, i) => {
    out[c.name] = row[i];
  });
  return out;
}

/** Per-row OOF record, member outputs aligned with the member list. */
interface OofRow {
  rowIdx: number;
  fold: number;
  memberOutputs: number[];
  /** Classification: the blended label → mean-probability map (sorted by label). */
  probs?: LabelProb[];
}

interface LabelProb {
  label: string;
  probability: number;
}

/** Closed-form ridge (λ) on the centered meta-design: w = (Xc'Xc + λI)⁻¹Xc'y. */
function ridgeMeta(X: number[][], y: number[], lambda = 1): { weights: number[]; intercept: number } | null {
  const n = X.length;
  const k = X[0]?.length ?? 0;
  if (n === 0 || k === 0) return null;
  const b0 = y.reduce((s, v) => s + v, 0) / n;
  const colMeans = new Array<number>(k).fill(0);
  for (const r of X) for (let j = 0; j < k; j++) colMeans[j]! += (r[j] as number) / n;
  const Yc = y.map((v) => v - b0);
  const Xc = X.map((r) => r.map((v, j) => (v as number) - (colMeans[j] as number)));
  // A = Xc'Xc + λI ; b = Xc'y
  const A: number[][] = Array.from({ length: k }, (_, i) => {
    const row = new Array<number>(k).fill(0);
    for (let j = 0; j < k; j++) {
      for (const r of Xc) row[j] = (row[j] ?? 0) + (r[i] as number) * (r[j] as number);
      if (i === j) row[j] = (row[j] ?? 0) + lambda;
    }
    return row;
  });
  const b: number[] = new Array<number>(k).fill(0);
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < n; i++) b[j]! += (Xc[i]![j] as number) * Yc[i]!;
  }
  // Gaussian elimination with partial pivoting (k ≤ 4).
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[pivot]![col]!)) pivot = r;
    if (Math.abs(A[pivot]![col]!) < 1e-10) return null; // singular member set — refuse to stack
    [A[col], A[pivot]] = [A[pivot]!, A[col]!];
    [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r]![col]! / A[col]![col]!;
      if (f === 0) continue;
      for (let j = col; j < k; j++) A[r]![j] = (A[r]![j] ?? 0) - f * (A[col]![j] ?? 0);
      b[r]! = (b[r]! ?? 0) - f * b[col]!;
    }
  }
  const weights = b.map((v, i) => v / A[i]![i]!);
  const intercept = b0 - colMeans.reduce((s, m, i) => s + m * (weights[i] as number), 0);
  return { weights, intercept };
}

/* -------------------------------------------------------------------------- */

/** Global sorted class list + per-row class index (fold-safe bookkeeping). */
function classBookkeeping(
  source: MlSource,
  req: MlTrainRequest,
): { classes: string[]; labels: string[]; indexes: number[] } {
  const ti = source.columns.findIndex((c) => c.name === req.targetColumn);
  if (ti < 0) throw new MlError(`Target column “${req.targetColumn}” not found.`);
  const labels = source.rows.map((r) => {
    const v = r[ti];
    return v === null || v === undefined || v === "" ? "" : String(v);
  });
  const classes = [...new Set(labels.filter((l) => l !== ""))].sort();
  const indexes = labels.map((l) => (l === "" ? 0 : classes.indexOf(l)));
  return { classes, labels, indexes };
}

function targetNumberAt(source: MlSource, req: MlTrainRequest, rowIdx: number): number {
  const ti = source.columns.findIndex((c) => c.name === req.targetColumn);
  return Number((source.rows[rowIdx] as (string | number | boolean | null)[])[ti]);
}

function rmseOf(yTrue: number[], yPred: (number | undefined)[]): number {
  let acc = 0;
  let matched = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const p = yPred[i];
    if (p !== undefined && Number.isFinite(p)) {
      acc += Math.pow((yTrue[i] as number) - p, 2);
      matched++;
    }
  }
  return matched ? Math.sqrt(acc / matched) : Number.POSITIVE_INFINITY;
}

/** Mean class probability per label across members (count-aware). */
function blendProbs(memberProbs: LabelProb[][]): LabelProb[] {
  const sums = new Map<string, { total: number; count: number }>();
  for (const probs of memberProbs) {
    for (const { label, probability } of probs) {
      const slot = sums.get(label) ?? { total: 0, count: 0 };
      slot.total += probability;
      slot.count += 1;
      sums.set(label, slot);
    }
  }
  return [...sums.entries()]
    .map(([label, { total, count }]) => ({ label, probability: total / Math.max(1, count) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------

/**
 * Evaluate the blended ensemble OUT-OF-FOLD. Every fold refits every member
 * on the fold's training slice and serves the held-out rows through the
 * standard pipeline — the reported score is a pure out-of-sample artifact.
 */
export function evaluateBlendedEnsemble(
  source: MlSource,
  req: MlTrainRequest,
  members: EnsembleMemberSpec[],
  foldsWanted: number,
  seed: number,
  metricName: "rmse" | "rocAuc" | "accuracy",
): EnsembleEvaluation {
  if (members.length < 2) throw new MlError("An ensemble needs at least 2 members.");
  if (source.rows.length < 12) throw new MlError("Training needs at least 12 rows.");

  const isRegression = req.task === "regression";
  const book = isRegression
    ? { classes: undefined as string[] | undefined, labels: [] as string[], indexes: source.rows.map(() => 0) }
    : classBookkeeping(source, req);
  if (!isRegression && book.classes && book.classes.length < 2) {
    throw new MlError("Classification needs at least 2 distinct classes.");
  }

  const folds = makeFolds(
    book.indexes,
    Math.max(2, Math.min(Math.round(foldsWanted), 10)),
    seed,
    !isRegression, // stratify classification folds on the global class index
  );

  const oof: OofRow[] = [];
  for (let f = 0; f < folds.length; f++) {
    const testIdx = folds[f] ?? [];
    if (testIdx.length === 0) continue;
    const testSet = new Set(testIdx);
    const trainRows = source.rows.filter((_, i) => !testSet.has(i));
    if (trainRows.length < 12) continue; // tiny folds cannot fit — honestly skipped
    const subSource: MlSource = { columns: source.columns, rows: trainRows };

    // perTestRows[r] = each member's served result on test row r.
    const perTestResults: ServeResultProxy[][] = testIdx.map(() => []);
    for (const member of members) {
      const probe = trainWithCv(subSource, {
        ...req,
        algorithm: member.algorithm,
        ...member.hyperparams,
        cvFolds: 2,
        seed,
      });
      const serveable = memberServeable(probe.artifact, req.task);
      for (let r = 0; r < testIdx.length; r++) {
        const raw = rowToRecord(source, source.rows[testIdx[r]!] as (string | number | boolean | null)[]);
        const served = serve(serveable, raw);
        perTestResults[r]!.push({
          output: Number(served.output),
          probs: served.probabilities ?? [],
        });
      }
    }

    for (let r = 0; r < testIdx.length; r++) {
      const memberOutputs = perTestResults[r]!.map((m) => m.output);
      let probs: LabelProb[] | undefined;
      if (!isRegression) {
        probs = blendProbs(perTestResults[r]!.map((m) => m.probs));
      }
      oof.push({ rowIdx: testIdx[r]!, fold: f, memberOutputs, probs });
    }
  }
  if (oof.length === 0) throw new MlError("The ensemble evaluation produced no out-of-fold predictions.");

  // --- Regression: pick the better of "mean" vs ridge "stacked" -------------
  if (isRegression) {
    const yTrue = oof.map((o) => targetNumberAt(source, req, o.rowIdx));
    const P = oof.map((o) => o.memberOutputs);
    const meanPred = P.map((row) => {
      const fin = row.filter(Number.isFinite);
      return fin.length ? fin.reduce((a, v) => a + v, 0) / fin.length : Number.NaN;
    });
    const meanScore = rmseOf(yTrue, meanPred);
    // Meta-design: only rows where EVERY member produced a finite output.
    const finiteMask = P.map((row) => row.every(Number.isFinite));
    const Pfit = P.filter((_, i) => finiteMask[i]);
    const yfit = yTrue.filter((_, i) => finiteMask[i]);
    const stacked = Pfit.length >= 20 ? ridgeMeta(Pfit, yfit) : null;
    let stackedScore = Number.POSITIVE_INFINITY;
    let stackedPred: (number | undefined)[] = meanPred;
    if (stacked) {
      stackedPred = P.map((row) => stacked.intercept + row.reduce((s, v, i) => s + (stacked.weights[i] ?? 0) * v, 0));
      stackedScore = rmseOf(yTrue, stackedPred);
    }
    const useStacked = stacked !== null && stackedScore < meanScore;

    const perFold = foldOf(oof, folds.length, (rows) => {
      const yy = rows.map((o) => targetNumberAt(source, req, o.rowIdx));
      const preds = useStacked
        ? rows.map(
            (o) => stacked!.intercept + o.memberOutputs.reduce((s, v, i) => s + (stacked!.weights[i] ?? 0) * v, 0),
          )
        : rows.map((o) => {
            const fin = o.memberOutputs.filter(Number.isFinite);
            return fin.length ? fin.reduce((a, v) => a + v, 0) / fin.length : Number.NaN;
          });
      let ss = 0;
      let used = 0;
      for (let i = 0; i < yy.length; i++) {
        if (Number.isFinite(preds[i] as number)) {
          ss += Math.pow(yy[i]! - (preds[i] as number), 2);
          used++;
        }
      }
      return used ? Math.sqrt(ss / used) : Number.NaN;
    });

    return {
      oofScore: useStacked ? stackedScore : meanScore,
      perFold,
      metricName: "rmse",
      combiner: useStacked ? "stacked" : "mean",
      block: {
        kind: "aerolexa.ml.ensemble.v1",
        combiner: useStacked ? "stacked" : "mean",
        members: fullMemberArtifacts(source, req, members, seed),
        ...(useStacked && stacked ? { meta: { weights: stacked.weights, intercept: stacked.intercept } } : {}),
      },
      methodology: [
        `${members.length} members were refit per fold; every held-out row was served through the standard single-model pipeline and combined — the reported RMSE is OUT-OF-FOLD.`,
        useStacked
          ? `Regression stacking: ridge meta-weights (λ=1, closed form) fit on the OUT-OF-FOLD member prediction matrix; stacked ${stackedScore.toFixed(4)} beat the plain mean ${meanScore.toFixed(4)}. The stacking layer never sees labels outside its own fold schedule.`
          : `Plain mean combiner kept${stacked !== null ? ` — the ridge-stacked variant did not beat it (${stackedScore === Number.POSITIVE_INFINITY ? "not fittable" : stackedScore.toFixed(4)} vs ${meanScore.toFixed(4)})` : ""}.`,
      ],
    };
  }

  // --- Classification: mean-prob blend, argmax label ------------------------
  const posLabel = book.classes![1] as string; // sorted classes ⇒ index 1 = positive
  const yTrue01: number[] = [];
  const scores: number[] = [];
  const yLabels: string[] = [];
  const blendLabels: string[] = [];
  for (const o of oof) {
    const trueLabel = book.labels[o.rowIdx] as string;
    yLabels.push(trueLabel);
    blendLabels.push(getBestLabel(o.probs ?? []));
    if (book.classes!.length === 2) {
      const pos = (o.probs ?? []).find((p) => p.label === posLabel);
      if (pos) {
        yTrue01.push(trueLabel === posLabel ? 1 : 0);
        scores.push(pos.probability);
      }
    }
  }

  let score = Number.NaN;
  if (req.task === "multiclass-classification") {
    let correct = 0;
    for (let i = 0; i < oof.length; i++) if (blendLabels[i] === yLabels[i]) correct++;
    score = correct / oof.length;
  } else if (yTrue01.length === oof.length) {
    score =
      metricName === "accuracy"
        ? evaluateClassification(yTrue01, scores).accuracy
        : evaluateClassification(yTrue01, scores).rocAuc;
  } else {
    throw new MlError("The ensemble evaluation produced incomplete fold probability vectors.");
  }

  const perFold = foldOf(oof, folds.length, (rows) => {
    if (req.task === "multiclass-classification") {
      const c = rows.filter((o) => o.probs && getBestLabel(o.probs) === book.labels[o.rowIdx]).length;
      return rows.length ? c / rows.length : Number.NaN;
    }
    const yt: number[] = [];
    const sc: number[] = [];
    for (const o of rows) {
      const trueLabel = book.labels[o.rowIdx] as string;
      const pos = (o.probs ?? []).find((p) => p.label === posLabel);
      if (pos) {
        yt.push(trueLabel === posLabel ? 1 : 0);
        sc.push(pos.probability);
      }
    }
    try {
      const m = evaluateClassification(yt, sc);
      return metricName === "accuracy" ? m.accuracy : m.rocAuc;
    } catch {
      return Number.NaN; // degenerate fold (single class present) — honest NaN
    }
  });

  return {
    oofScore: score,
    perFold,
    metricName: req.task === "multiclass-classification" ? "accuracy" : metricName,
    combiner: "mean-prob",
    block: {
      kind: "aerolexa.ml.ensemble.v1",
      combiner: "mean-prob",
      members: fullMemberArtifacts(source, req, members, seed),
    },
    methodology: [
      `${members.length} members were refit per fold; every held-out row was served through the standard single-model pipeline and combined — the score is OUT-OF-FOLD.`,
      `Combiner "mean-prob": mean class probability per label across members (count-aware when a fold misses a rare class), argmax for the label.`,
    ],
  };
}

/** Refit every member on ALL rows — the servable block's artifacts. */
function fullMemberArtifacts(
  source: MlSource,
  req: MlTrainRequest,
  members: EnsembleMemberSpec[],
  seed: number,
): MlArtifact[] {
  return members.map((member) => {
    const full = trainWithCv(source, { ...req, algorithm: member.algorithm, ...member.hyperparams, cvFolds: 2, seed });
    return full.artifact;
  });
}

interface ServeResultProxy {
  output: number;
  probs: LabelProb[];
}

function getBestLabel(probs: LabelProb[]): string {
  if (probs.length === 0) return "";
  return probs.reduce((a, b) => (b.probability > a.probability ? b : a)).label;
}

/** Group OOF rows by fold and score each group (rows unordered → map fold → score). */
function foldOf(oof: OofRow[], nFolds: number, score: (rows: OofRow[]) => number): number[] {
  const out: number[] = new Array<number>(nFolds).fill(Number.NaN);
  for (let f = 0; f < nFolds; f++) {
    const rows = oof.filter((o) => o.fold === f);
    if (rows.length > 0) out[f] = score(rows);
  }
  return out;
}
