/**
 * Unit tests for the advanced-trainer → ModelCard adapter
 * (lib/engine/ml-card.ts): the mapping that exposes the k-fold CV engine
 * (trainWithCv) through the same ModelCard contract the registry, UI and
 * Python export pipeline already consume. Oracle numbers come from the real
 * engine — the adapter must not lose or distort them.
 */
import { advancedModelCard } from "@/lib/engine/ml-card";
import { trainWithCv, type MlTrainResult } from "@/lib/engine/ml-training";
import type { ColumnDef } from "@/lib/types";

const columns: ColumnDef[] = [
  { name: "x1", type: "number" },
  { name: "x2", type: "number" },
  { name: "label", type: "string" },
];

/** Deterministic regression fixture: y = 3·x1 − 2·x2 + noise(i%2). */
function regressionRows(n = 60): (string | number | null)[][] {
  return Array.from({ length: n }, (_, i) => {
    const x1 = i * 1.7;
    const x2 = (i % 7) * 0.9;
    return [x1, x2, 3 * x1 - 2 * x2 + (i % 2)];
  });
}

/** Deterministic binary fixture: class = x1 above median. */
function classificationRows(n = 60): (string | number | null)[][] {
  return Array.from({ length: n }, (_, i) => {
    const x1 = i;
    const x2 = (i * 3) % 11;
    return [x1, x2, i >= n / 2 ? "yes" : "no"];
  });
}

function source(rows: (string | number | null)[][]) {
  return { columns, rows };
}

describe("advancedModelCard — regression (ridge)", () => {
  const result = trainWithCv(source(regressionRows()), {
    task: "regression",
    algorithm: "ridge",
    targetColumn: "label",
    cvFolds: 4,
    seed: 7,
  });
  const card = advancedModelCard(result, "Pricing CV");

  it("keeps the CV report verbatim (out-of-fold numbers are the headline)", () => {
    expect(card.metrics.cvFolds).toBe(result.cv.folds);
    expect(card.metrics.cvMetric).toBe("rmse");
    expect(card.metrics.cvMean).toBe(result.cv.mean);
    expect(card.metrics.cvSd).toBe(result.cv.sd);
  });

  it("labels the engine honestly", () => {
    expect(card.metadata.engine).toBe("cv-ml-trainer");
    expect(card.metadata.realComputation).toBe(true);
    expect(card.algorithm).toContain("k-fold CV engine");
  });

  it("carries ridge weights + intercept on the card", () => {
    expect(card.weights.length).toBe(result.artifact.featureNames.length);
    expect(typeof card.intercept).toBe("number");
    expect(card.coefficients?.x1).toBeDefined();
  });

  it("maps permutation importance with its method stated", () => {
    expect(card.featureImportance!.length).toBeGreaterThan(0);
    for (const f of card.featureImportance!) expect(f.method).toBe("permutation (out-of-fold)");
  });

  it("produces a generalization assessment with a stated risk rule", () => {
    const g = card.generalization!;
    expect(["low", "medium", "high"]).toContain(g.risk);
    expect(g.explanation).toContain("out-of-fold");
    expect(g.primaryMetric).toBe("rmse");
  });

  it("preserves the k-fold structure for the registry", () => {
    expect(card.crossValidation!.method).toBe("k-fold");
    expect(card.crossValidation!.folds).toHaveLength(result.cv.folds);
  });

  it("features match the design matrix", () => {
    expect(card.features).toEqual(result.featureNames);
  });
});

describe("advancedModelCard — classification (logistic)", () => {
  const result: MlTrainResult = trainWithCv(source(classificationRows()), {
    task: "binary-classification",
    algorithm: "logistic",
    targetColumn: "label",
    cvFolds: 4,
    seed: 7,
  });
  const card = advancedModelCard(result, "Churn CV");

  it("maps the binary task and exposes AUC-based CV metrics", () => {
    expect(card.task).toBe("classification");
    expect(card.metrics.cvMetric).toBe("rocAuc");
    expect(card.metrics.rocAuc).toBeDefined();
  });

  it("exposes Wald p-values from the IRLS fit", () => {
    expect(card.coefficientPValues).toBeDefined();
    expect(Object.values(card.coefficientPValues!).every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it("records the class mapping", () => {
    expect(card.classMap).toEqual({ positive: "yes", negative: "no" });
  });

  it("carries class balance provenance", () => {
    expect(card.metrics.positiveRows).toBe(result.classBalance?.positive);
    expect(card.metrics.negativeRows).toBe(result.classBalance?.negative);
  });
});

describe("advancedModelCard — honesty contract", () => {
  it("demoNote distinguishes in-sample from out-of-fold", () => {
    const card = advancedModelCard(
      trainWithCv(source(regressionRows()), { task: "regression", algorithm: "ridge", targetColumn: "label" }),
      "Note check",
    );
    expect(card.demoNote).toContain("out-of-fold");
    expect(card.demoNote).toContain("In-sample");
  });

  it("name comes from the request, not the engine", () => {
    const card = advancedModelCard(
      trainWithCv(source(regressionRows()), { task: "regression", algorithm: "ridge", targetColumn: "label" }),
      "My custom name",
    );
    expect(card.name).toBe("My custom name");
  });
});
