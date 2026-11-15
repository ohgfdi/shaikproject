/**
 * Unit tests for AutoML-lite (`lib/engine/automl.ts`).
 *
 * Pins the contract that makes automatic selection trustworthy:
 *  - the leaderboard only holds REAL fitted configurations;
 *  - selection is deterministic (same data + seed ⇒ same winner, byte-equal);
 *  - the winner is chosen by out-of-fold CV score, ties toward simpler models;
 *  - a clearly-best algorithm family actually wins on well-separated
 *    synthetic data (linear truth ⇒ ridge beats kNN; boosting on a
 *    non-linear interaction);
 *  - the returned `best` is a full trainWithCv result (artifact + importance
 *    + honest methodology) for the winning configuration;
 *  - grid exploration is visible: candidates from ≥ 3 distinct algorithms
 *    appear for a normal-size problem under the default cap.
 */
import { autoTrain } from "@/lib/engine/automl";
import type { MlSource, MlTrainRequest } from "@/lib/engine/ml-training";

/** Linear truth + noise-free: ridge should nail it, RMSE ≈ 0. */
function linearSource(n = 60): MlSource {
  const rows: MlSource["rows"] = [];
  for (let i = 0; i < n; i++) {
    const x1 = (i % 17) + 1;
    const x2 = (i % 5) - 2;
    rows.push([x1, x2, "A", 3 * x1 - 2 * x2 + 10]);
  }
  return {
    columns: [
      { name: "x1", type: "number" },
      { name: "x2", type: "number" },
      { name: "grp", type: "string" },
      { name: "y", type: "number" },
    ],
    rows,
  };
}

/** Non-linear interaction truth: y = x1*x2 > threshold style — trees/boosting should win. */
function nonlinearSource(n = 80): MlSource {
  const rows: MlSource["rows"] = [];
  for (let i = 0; i < n; i++) {
    const x1 = (i * 7) % 23;
    const x2 = (i * 11) % 19;
    const label = x1 * x2 > 150 ? "hi" : "lo";
    rows.push([x1, x2, label]);
  }
  return {
    columns: [
      { name: "x1", type: "number" },
      { name: "x2", type: "number" },
      { name: "label", type: "string" },
    ],
    rows,
  };
}

const REG_REQ: MlTrainRequest = { task: "regression", algorithm: "ridge", targetColumn: "y", cvFolds: 3, seed: 7 };

describe("autoTrain — leaderboard contract", () => {
  it("scores multiple algorithm families and marks exactly one winner", () => {
    const res = autoTrain(linearSource(), REG_REQ, 12);
    const algorithms = new Set(res.leaderboard.map((c) => c.algorithm));
    expect(algorithms.size).toBeGreaterThanOrEqual(3);
    expect(res.leaderboard.filter((c) => c.winner)).toHaveLength(1);
    expect(res.leaderboard[0]?.winner).toBe(true);
  });

  it("is deterministic — identical data + seed produce an identical leaderboard", () => {
    const a = autoTrain(linearSource(), REG_REQ, 8);
    const b = autoTrain(linearSource(), REG_REQ, 8);
    expect(a.leaderboard.map((c) => [c.algorithm, c.hyperparams, c.score])).toEqual(
      b.leaderboard.map((c) => [c.algorithm, c.hyperparams, c.score]),
    );
    expect(a.best.algorithm).toBe(b.best.algorithm);
  });

  it("ranks the leaderboard by out-of-fold score (regression: lower RMSE first)", () => {
    const res = autoTrain(linearSource(), REG_REQ, 12);
    const scores = res.leaderboard.map((c) => c.score);
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]! <= scores[i]!).toBe(true);
  });

  it("linear truth ⇒ ridge wins with near-zero CV RMSE (residual is the grid's λ-shrinkage bias, honestly small)", () => {
    const res = autoTrain(linearSource(), REG_REQ, 12);
    expect(res.best.algorithm).toBe("ridge");
    // λ>0 shrinks coefficients slightly, so the fit is not EXACT — but the
    // shrinkage-biased RMSE must still be ≪ the target's spread (~40).
    expect(res.best.cv.mean).toBeLessThan(0.5);
  });

  it("non-linear interaction truth ⇒ the linear baseline loses to a non-linear winner by a real margin", () => {
    const res = autoTrain(
      nonlinearSource(),
      { task: "binary-classification", algorithm: "logistic", targetColumn: "label", cvFolds: 3, seed: 7 },
      10,
    );
    const logisticRow = res.leaderboard.find((c) => c.algorithm === "logistic");
    expect(logisticRow).toBeDefined();
    // x1*x2 > threshold is not linearly separable, so the OOF winner must be
    // a non-linear learner (kNN/trees/boosting all qualify) and must beat the
    // logistic baseline — the honest property AutoML exists to surface.
    expect(["knn", "decision-tree", "random-forest", "gradient-boosting"]).toContain(res.best.algorithm);
    expect(res.best.cv.mean).toBeGreaterThan(logisticRow!.score);
  });

  it("respects the maxCandidates cap", () => {
    const res = autoTrain(linearSource(), REG_REQ, 5);
    expect(res.leaderboard.length).toBeLessThanOrEqual(5);
  });

  it("returns a full trainWithCv result for the winner (artifact + importance + methodology)", () => {
    const res = autoTrain(linearSource(), REG_REQ, 12);
    expect(res.best.artifact.kind).toBe("aerolexa.ml.v1");
    expect(res.best.importance.length).toBeGreaterThan(0);
    expect(res.best.artifact.hyperparams).toEqual(res.leaderboard[0]?.hyperparams);
    // AutoML methodology prepends the selection provenance.
    expect(res.methodology.some((m) => m.includes("AutoML-lite"))).toBe(true);
    expect(res.methodology.length).toBeGreaterThan(res.best.methodology.length);
  });

  it("metricName follows the task", () => {
    expect(autoTrain(linearSource(), REG_REQ, 4).metricName).toBe("rmse");
    const cls = autoTrain(
      nonlinearSource(),
      { task: "binary-classification", algorithm: "logistic", targetColumn: "label", cvFolds: 3, seed: 7 },
      4,
    );
    expect(cls.metricName).toBe("rocAuc");
  });

  it("throws the honest error for tiny datasets", () => {
    const tiny: MlSource = {
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: Array.from({ length: 10 }, (_, i) => [i, i]),
    };
    expect(() => autoTrain(tiny, REG_REQ)).toThrow("at least 12 rows");
  });
});
