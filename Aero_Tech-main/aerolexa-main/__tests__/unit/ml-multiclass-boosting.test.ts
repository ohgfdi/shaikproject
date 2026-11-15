/**
 * Oracle tests for the NEW advanced-engine capabilities:
 *   - multiclass classification (softmax + OvR ensemble paths)
 *   - real gradient boosting (Friedman logit-boost, Newton leaves)
 *   - determinism (same seed → identical metrics)
 *
 * Fixtures are deterministic and hand-separable so the tests pin exact
 * recoverable structure, mirroring ml-training.test.ts conventions.
 */
import { advancedModelCard } from "@/lib/engine/ml-card";
import { evaluateMulticlass, trainWithCv, type MlSource } from "@/lib/engine/ml-training";

/** Three separable classes along x1 with x2 noise. */
function multiclassSource(n = 90): MlSource {
  const rows: (string | number | null)[][] = [];
  for (let i = 0; i < n; i++) {
    const x1 = i;
    const x2 = (i * 5) % 7;
    const label = x1 < n / 3 ? "A" : x1 < (2 * n) / 3 ? "B" : "C";
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

/** Deterministic binary fixture (alternating classes) for the logit-booster. */
function boostingSource(n = 80): MlSource {
  const rows: (string | number | null)[][] = [];
  for (let i = 0; i < n; i++) {
    const x1 = i;
    const x2 = (i * 3) % 13;
    const label = i % 2 === 0 ? "neg" : "pos";
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

describe("multiclass classification (softmax path)", () => {
  const result = trainWithCv(multiclassSource(), {
    task: "multiclass-classification",
    algorithm: "logistic",
    targetColumn: "label",
    cvFolds: 3,
    seed: 7,
  });

  it("encodes K classes and reports per-class counts", () => {
    expect(result.classes).toEqual(["A", "B", "C"]);
    expect(result.classCounts).toEqual([30, 30, 30]);
  });

  it("reports accuracy as the CV metric (not rocAuc)", () => {
    expect(result.cv.metricName).toBe("accuracy");
  });

  it("achieves high out-of-fold accuracy on the separable fixture", () => {
    expect(result.cv.mean).toBeGreaterThan(0.9);
    expect(result.cv.sd).toBeLessThan(0.1);
  });

  it("in-sample refit confusion matrix is K×K", () => {
    const m = result.trainMetrics as unknown as { confusion: number[][] };
    expect(m.confusion.length).toBe(3);
    expect(m.confusion[0]!.length).toBe(3);
  });

  it("is deterministic (same seed → identical metrics)", () => {
    const again = trainWithCv(multiclassSource(), {
      task: "multiclass-classification",
      algorithm: "logistic",
      targetColumn: "label",
      cvFolds: 3,
      seed: 7,
    });
    expect(again.cv).toEqual(result.cv);
  });

  it("rejects ridge on a multiclass target", () => {
    expect(() =>
      trainWithCv(multiclassSource(), {
        task: "multiclass-classification",
        algorithm: "ridge",
        targetColumn: "label",
        cvFolds: 3,
      }),
    ).toThrow(/Ridge is a regression algorithm/);
  });
});

describe("multiclass OvR gradient boosting", () => {
  const result = trainWithCv(multiclassSource(), {
    task: "multiclass-classification",
    algorithm: "gradient-boosting",
    targetColumn: "label",
    cvFolds: 3,
    nTrees: 25,
    learningRate: 0.5,
    seed: 7,
  });

  it("beats the 1/3-chance accuracy out-of-fold", () => {
    expect(result.cv.mean).toBeGreaterThan(1 / 3);
  });

  it("serializes a K-booster OvR artifact", () => {
    expect(result.artifact.boostingOvr?.length).toBe(3);
    expect(result.artifact.boostingOvr?.[0]?.trees.length).toBe(25);
  });
});

describe("binary gradient boosting (logit-boost)", () => {
  const result = trainWithCv(boostingSource(), {
    task: "binary-classification",
    algorithm: "gradient-boosting",
    targetColumn: "label",
    cvFolds: 4,
    nTrees: 40,
    learningRate: 0.3,
    seed: 7,
  });

  it("stores the boosting state (base, rate, trees)", () => {
    expect(result.artifact.boosting?.trees.length).toBe(40);
    expect(result.artifact.boosting?.learningRate).toBe(0.3);
    expect(typeof result.artifact.boosting?.base).toBe("number");
  });

  it("is deterministic across runs", () => {
    const again = trainWithCv(boostingSource(), {
      task: "binary-classification",
      algorithm: "gradient-boosting",
      targetColumn: "label",
      cvFolds: 4,
      nTrees: 40,
      learningRate: 0.3,
      seed: 7,
    });
    expect(again.cv).toEqual(result.cv);
  });
});

describe("gradient boosting regression (squared loss)", () => {
  const rows: (string | number | null)[][] = [];
  for (let i = 0; i < 40; i++) {
    const x = i - 20;
    rows.push([x, 3 * x + 2]);
  }
  const result = trainWithCv(
    {
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows,
    },
    {
      task: "regression",
      algorithm: "gradient-boosting",
      targetColumn: "y",
      cvFolds: 4,
      nTrees: 60,
      learningRate: 0.3,
      maxDepth: 3,
      seed: 7,
    },
  );

  it("recovers the function in-sample and beats the mean-predictor baseline out-of-fold", () => {
    expect(result.cv.metricName).toBe("rmse");
    // Trees are step functions: on a perfect line they interpolate held-out
    // rows with slope-sized error (sklearn behaves the same). The honest bar:
    // crush the mean-predictor baseline (RMSE ≈ std(y) ≈ 20) out-of-fold and
    // recover the function in-sample.
    expect(result.cv.mean).toBeLessThan(10);
    const train = result.trainMetrics as { r2: number };
    expect(train.r2).toBeGreaterThan(0.99);
  });
});

describe("evaluateMulticlass (oracle)", () => {
  it("computes accuracy and macro metrics by hand", () => {
    // Hand case: 6 rows, 3 classes, 4 correct.
    const m = evaluateMulticlass([0, 0, 1, 1, 2, 2], [0, 1, 1, 1, 2, 0]);
    expect(m.accuracy).toBeCloseTo(4 / 6, 9);
    // Class 0: TP=1 FP=1 FN=1 → P=R=F1=0.5; class 1: TP=2 FP=1 FN=1 → P=2/3 R=1 F1=0.8;
    // class 2: TP=1 FP=0 FN=1 → P=1 R=0.5 F1=2/3.
    expect(m.macroPrecision).toBeCloseTo((0.5 + 2 / 3 + 1) / 3, 9);
    expect(m.macroRecall).toBeCloseTo((0.5 + 1 + 0.5) / 3, 9);
    expect(m.macroF1).toBeCloseTo((0.5 + 0.8 + 2 / 3) / 3, 9);
    expect(m.confusion).toEqual([
      [1, 1, 0],
      [0, 2, 0],
      [1, 0, 1],
    ]);
  });
});

describe("advancedModelCard — multiclass", () => {
  const result = trainWithCv(multiclassSource(), {
    task: "multiclass-classification",
    algorithm: "logistic",
    targetColumn: "label",
    cvFolds: 3,
    seed: 7,
  });
  const card = advancedModelCard(result, "Segments CV");

  it("maps multiclass metrics onto the card", () => {
    expect(card.metrics.classList).toEqual(["A", "B", "C"]);
    expect(card.metrics.classCounts).toEqual([30, 30, 30]);
    expect(card.metrics.testAccuracy).toBe(result.cv.mean);
    expect(card.metrics.generalization?.primaryMetric).toBe("accuracy");
  });

  it("keeps the honest engine label", () => {
    expect(card.algorithm).toContain("k-fold CV engine");
    expect(card.demoNote).toContain("Multiclass:");
  });

  it("does not attach a binary classMap to a multiclass card", () => {
    expect(card.classMap).toBeUndefined();
  });
});
