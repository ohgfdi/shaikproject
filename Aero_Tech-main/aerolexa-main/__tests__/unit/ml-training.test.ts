/**
 * Oracle tests for the ML training engine (lib/engine/ml-training.ts):
 * preprocessing mechanics, model recovery of known functions, CV determinism,
 * hand-computed ROC/PR AUC, and honest metric framing.
 */
import {
  applyPreprocessor,
  encodeDataset,
  evaluateClassification,
  evaluateRegression,
  trainWithCv,
  type MlSource,
  type MlTrainRequest,
} from "@/lib/engine/ml-training";

function regressionSource(): MlSource {
  // y = 3x + 2 (exactly, no noise) — ridge must recover it.
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 0; i < 40; i++) {
    const x = i - 20;
    rows.push([x, 3 * x + 2]);
  }
  return {
    columns: [
      { name: "x", type: "number" },
      { name: "y", type: "number" },
    ],
    rows,
  };
}

function classificationSource(): MlSource {
  // label = "yes" iff spend ≥ 50 — separable; logistic/tree/forest must ace it.
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 0; i < 60; i++) {
    const spend = i * 2;
    rows.push([spend, spend >= 50 ? "yes" : "no"]);
  }
  return {
    columns: [
      { name: "spend", type: "number" },
      { name: "label", type: "string" },
    ],
    rows,
  };
}

describe("preprocessing", () => {
  it("one-hots categoricals and standardizes numerics (train-fit)", () => {
    const src: MlSource = {
      columns: [
        { name: "region", type: "string" },
        { name: "units", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: [
        ["East", 10, 1],
        ["West", 20, 2],
        ["East", 30, 3],
        [null, 40, 4],
      ],
    };
    const enc = encodeDataset(src, { task: "regression", algorithm: "ridge", targetColumn: "y" });
    // Features keep SOURCE column order: region (categorical → one-hot) first,
    // then units (numeric, standardized).
    expect(enc.pre.featureNames).toEqual(["region=East", "region=West", "units"]);
    // units mean = 25, SAMPLE sd (√(500/3)) ≈ 12.9099: standardized (10−25)/12.9099.
    // One-hot columns are standardized like any other column (sklearn
    // OneHotEncoder→StandardScaler pipeline semantics).
    // East col [1,0,1,0]: mean 0.5, sample sd √(1/3) → (1−0.5)/0.5774 = 0.8660.
    // West col [0,1,0,0]: mean 0.25, sample sd 0.5 → (0−0.25)/0.5 = −0.5.
    const sd = Math.sqrt(500 / 3);
    expect(enc.X[0]![2]).toBeCloseTo((10 - 25) / sd, 6);
    expect(enc.X[0]![0]).toBeCloseTo((1 - 0.5) / Math.sqrt(1 / 3), 6); // East
    expect(enc.X[0]![1]).toBeCloseTo((0 - 0.25) / 0.5, 6); // West
    // Row 3's NULL is in `region` (units = 40): East/West both 0 →
    // standardized West = (0 − 0.25)/0.5 = −0.5; units = (40 − 25)/sd.
    expect(enc.X[3]![2]).toBeCloseTo((40 - 25) / sd, 6);
    expect(enc.X[3]![0]).toBeCloseTo((0 - 0.5) / Math.sqrt(1 / 3), 6);

    // A null NUMERIC value is median-imputed (median of [10,20,40] = 20), the
    // imputed value joins the moment computation: mean 22.5, sample sd
    // √(475/3) ≈ 12.5831 → z = (20 − 22.5)/12.5831 ≈ −0.1987.
    const src2: MlSource = {
      columns: [
        { name: "units", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: [
        [10, 1],
        [20, 2],
        [null, 3],
        [40, 4],
      ],
    };
    const enc2 = encodeDataset(src2, { task: "regression", algorithm: "ridge", targetColumn: "y" });
    expect(enc2.pre.medians[0]).toBe(20);
    expect(enc2.X[2]![0]).toBeCloseTo((20 - 22.5) / Math.sqrt(475 / 3), 6);
  });

  it("applyPreprocessor maps new rows through the SAME fitted transform", () => {
    const src = regressionSource();
    const enc = encodeDataset(src, { task: "regression", algorithm: "ridge", targetColumn: "y" });
    const newX = applyPreprocessor(src, enc.pre, {
      task: "regression",
      algorithm: "ridge",
      targetColumn: "y",
      featureColumns: ["x"],
    });
    // Row 0 standardized value must match the encode-time value.
    expect(newX[0]![0]).toBeCloseTo(enc.X[0]![0] as number, 6);
  });
});

describe("models recover known functions", () => {
  it("ridge recovers exact-linear data (λ→0 ⇒ exact; λ=1 ⇒ small shrinkage)", () => {
    const exact = trainWithCv(regressionSource(), {
      task: "regression",
      algorithm: "ridge",
      targetColumn: "y",
      cvFolds: 4,
      lambda: 1e-9,
    });
    // With no penalty, OLS on exact-linear data must recover it perfectly.
    expect(exact.cv.mean).toBeLessThan(1e-6);
    const em = exact.trainMetrics as { r2: number; rmse: number };
    expect(em.r2).toBeCloseTo(1, 6);
    expect(em.rmse).toBeLessThan(1e-6);

    // λ = 1 on 40 standardized rows shrinks the slope by ~2.5% — small,
    // finite RMSE, R² still ≈ 1 (the regularization doing exactly its job).
    const shrunk = trainWithCv(regressionSource(), {
      task: "regression",
      algorithm: "ridge",
      targetColumn: "y",
      cvFolds: 4,
      lambda: 1,
    });
    const sm = shrunk.trainMetrics as { r2: number; rmse: number };
    expect(sm.rmse).toBeLessThan(2);
    expect(sm.r2).toBeGreaterThan(0.99);
  });

  it("logistic aces a separable classification (AUC = 1)", () => {
    const r = trainWithCv(classificationSource(), {
      task: "binary-classification",
      algorithm: "logistic",
      targetColumn: "label",
      cvFolds: 4,
    });
    expect(r.cv.mean).toBe(1);
    const m = r.trainMetrics as { rocAuc: number; accuracy: number };
    expect(m.rocAuc).toBe(1);
    expect(m.accuracy).toBe(1);
    expect(r.glmDiagnostics!.converged).toBe(true);
    // The important feature is ranked first; shuffling it moves the metric.
    expect(r.importance[0]!.feature).toBe("spend");
    expect(r.importance[0]!.importance).toBeGreaterThan(0);
  });

  it("decision tree and random forest ace separable data and serialize artifacts", () => {
    for (const algorithm of ["decision-tree", "random-forest"] as const) {
      const r = trainWithCv(classificationSource(), {
        task: "binary-classification",
        algorithm,
        targetColumn: "label",
        cvFolds: 3,
        seed: 7,
      });
      expect(r.cv.mean).toBe(1);
      expect(r.artifact.kind).toBe("aerolexa.ml.v1");
      expect(r.artifact.algorithm).toBe(algorithm);
      if (algorithm === "random-forest") expect(r.artifact.forest!.length).toBe(40);
      if (algorithm === "decision-tree") expect(r.artifact.tree).toBeDefined();
    }
  });

  it("kNN recovers the regression surface on dense data", () => {
    const src: MlSource = {
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: Array.from({ length: 60 }, (_, i) => [i, i * 2] as (string | number | boolean | null)[]),
    };
    const r = trainWithCv(src, { task: "regression", algorithm: "knn", targetColumn: "y", k: 3, cvFolds: 4 });
    // kNN on a linear grid: each fold's neighbors are adjacent rows → tiny error.
    expect(r.cv.mean).toBeLessThan(4);
  });

  it("is deterministic for a fixed seed", () => {
    const req: MlTrainRequest = {
      task: "binary-classification",
      algorithm: "random-forest",
      targetColumn: "label",
      cvFolds: 3,
      seed: 11,
    };
    const a = trainWithCv(classificationSource(), req);
    const b = trainWithCv(classificationSource(), req);
    expect(a.cv.perFold).toEqual(b.cv.perFold);
    expect(a.importance).toEqual(b.importance);
  });

  it("cross-algorithm misuse is rejected with a clear error", () => {
    expect(() =>
      trainWithCv(classificationSource(), { task: "binary-classification", algorithm: "ridge", targetColumn: "label" }),
    ).toThrow(/Ridge is a regression/);
    expect(() =>
      trainWithCv(regressionSource(), { task: "regression", algorithm: "logistic", targetColumn: "y" }),
    ).toThrow(/Logistic regression is a classification/);
  });

  it("methodology notes are always present (honest framing)", () => {
    const r = trainWithCv(classificationSource(), {
      task: "binary-classification",
      algorithm: "logistic",
      targetColumn: "label",
    });
    expect(r.methodology.some((m) => m.includes("out-of-fold"))).toBe(true);
    expect(r.methodology.some((m) => m.includes("IN-SAMPLE"))).toBe(true);
    expect(r.methodology.some((m) => m.includes("NOT a causal effect"))).toBe(true);
  });
});

describe("metrics", () => {
  it("ROC AUC is hand-computable on a tiny example", () => {
    // scores: positives {5, 3}, negatives {4, 1} → AUC = 0.75
    // pairs sorted: 5(pos),4(neg),3(pos),1(neg): ROC points
    // (0,0),(0,0.5),(0.5,0.5),(0.5,1),(1,1) → AUC = 0.5·0.5 + 0.5·1 = 0.75
    const r = evaluateClassification([1, 0, 1, 0], [5, 4, 3, 1]);
    expect(r.rocAuc).toBeCloseTo(0.75, 6);
  });

  it("PR AUC (average precision) matches the hand computation", () => {
    // Same data: PR points (0.5, 1.0), (1.0, 0.6667) → AP = 0.5·1 + 0.5·0.6667 = 0.8333
    const r = evaluateClassification([1, 0, 1, 0], [5, 4, 3, 1]);
    expect(r.prAuc).toBeCloseTo(1 * 0.5 + (2 / 3) * 0.5, 5);
  });

  it("perfect ranking gives AUC 1 and the confusion matrix at 0.5", () => {
    const r = evaluateClassification([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]);
    expect(r.rocAuc).toBe(1);
    expect(r.confusion).toEqual({ tp: 2, fp: 0, tn: 2, fn: 0 });
    expect(r.accuracy).toBe(1);
  });

  it("regression metrics are exact", () => {
    const r = evaluateRegression([1, 2, 3], [2, 3, 4]); // constant error 1
    expect(r.mae).toBe(1);
    expect(r.rmse).toBe(1);
    // ssTot = 2; ssRes = 3 → r² = −0.5
    expect(r.r2).toBeCloseTo(-0.5, 6);
  });
});
