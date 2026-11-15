import { runHypothesisTest } from "@/lib/engine/hypothesis";
import { trainModel, type TrainableSource } from "@/lib/engine/training";
import { runWhatIf, type WhatIfSource } from "@/lib/engine/whatif";

function regressionSource(): TrainableSource {
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 1; i <= 80; i++) {
    const x = 2 * i + 5;
    const z = (i % 7) + 1;
    rows.push([`r${i}`, x, z, 3 * x + 2 * z + (i % 2 ? 0.1 : -0.1)]);
  }
  return {
    columns: [
      { name: "id", type: "string" },
      { name: "x", type: "number" },
      { name: "z", type: "number" },
      { name: "y", type: "number" },
    ],
    rows,
  };
}

describe("real model statistics", () => {
  it("recovers known regression coefficients and significant p-values", () => {
    const card = trainModel(regressionSource(), {
      task: "regression",
      targetColumn: "y",
      testRatio: 0.25,
      cvFolds: 5,
    });

    expect(card.coefficients?.x).toBeCloseTo(3, 1);
    expect(card.coefficients?.z).toBeCloseTo(2, 1);
    expect(card.coefficientPValues?.x).toBeLessThan(0.001);
    expect(card.split?.testRows).toBe(20);
    expect(card.metrics.r2).toBeGreaterThan(0.99);
  });

  it("reports distinct metrics for five cross-validation folds", () => {
    const card = trainModel(regressionSource(), { task: "regression", targetColumn: "y", cvFolds: 5 });
    expect(card.crossValidation?.folds).toHaveLength(5);
    expect(new Set(card.crossValidation?.folds.map((fold) => fold.metrics.rmse)).size).toBe(5);
  });

  it("includes feature importance and residual diagnostics", () => {
    const card = trainModel(regressionSource(), { task: "regression", targetColumn: "y" });
    expect(card.featureImportance?.map((item) => item.feature)).toEqual(expect.arrayContaining(["x", "z"]));
    expect(card.residualDiagnostics?.residuals.length).toBeGreaterThan(0);
    expect(card.residualDiagnostics?.interpretation).toEqual(expect.any(String));
  });

  it("trains real tree ensembles with configurable hyperparameters", () => {
    for (const algorithm of ["random-forest", "gradient-boosting"] as const) {
      const card = trainModel(regressionSource(), {
        task: "regression",
        targetColumn: "y",
        algorithm,
        hyperparams: { estimators: 7, learningRate: 0.2 },
      });
      expect(card.algorithm.toLowerCase()).toContain(algorithm.replace("-", " ").split(" ")[0]);
      expect(card.params.estimators).toBe(7);
      expect(card.featureImportance?.length).toBe(2);
      expect(card.metrics.testRmse).toEqual(expect.any(Number));
    }
  });
});

describe("hypothesis tests", () => {
  it("matches a two-sample t-test reference", () => {
    const result = runHypothesisTest({
      kind: "t-test",
      groups: [
        [2, 4, 6, 8, 10],
        [1, 3, 5, 7, 9],
      ],
    });
    expect(result.statistic).toBeCloseTo(0.5, 3);
    expect(result.pValue).toBeGreaterThan(0.4);
    expect(result.assumptions).toHaveLength(1);
  });

  it("returns chi-square and ANOVA statistics with assumption checks", () => {
    const chi = runHypothesisTest({
      kind: "chi-square",
      table: [
        [10, 30],
        [30, 10],
      ],
    });
    expect(chi.statistic).toBeCloseTo(20, 5);
    expect(chi.pValue).toBeLessThan(0.05);

    const anova = runHypothesisTest({
      kind: "anova",
      groups: [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ],
    });
    expect(anova.statistic).toBeCloseTo(27, 5);
    expect(anova.pValue).toBeLessThan(0.05);
    expect(anova.assumptions.some((assumption) => assumption.name.includes("variance"))).toBe(true);
  });
});

describe("real what-if regression", () => {
  it("returns coefficient inference for a strong relationship", () => {
    // Deterministic small noise so SSE > 0 and the inference (SE, p, CI) is
    // exercised in its real regime; a perfectly noise-free line would be the
    // degenerate σ̂ = 0 case (p = 0) that the stats oracle covers separately.
    const source: WhatIfSource = {
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: Array.from({ length: 40 }, (_, index) => [index + 1, 100 + 2 * (index + 1) + (index % 3) * 0.25]),
    };
    const result = runWhatIf(source, { driverColumn: "x", outcomeColumn: "y", pctChange: 5 });
    expect(result.fallback).toBe(false);
    expect(result.model.pValue).toBeLessThan(0.001);
    expect(result.model.confidenceInterval[0]).toBeLessThan(result.model.slope);
    expect(result.model.confidenceInterval[1]).toBeGreaterThan(result.model.slope);
  });

  it("reports p = 0 for a noise-free perfect fit (matches statsmodels), not 1", () => {
    const source: WhatIfSource = {
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: Array.from({ length: 40 }, (_, index) => [index + 1, 100 + 2 * (index + 1)]),
    };
    const result = runWhatIf(source, { driverColumn: "x", outcomeColumn: "y", pctChange: 5 });
    expect(result.fallback).toBe(false);
    expect(result.model.pValue).toBe(0);
    expect(result.model.slopeStandardError).toBe(0);
  });

  it("keeps the hypothetical fallback below the r-squared threshold", () => {
    const source: WhatIfSource = {
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: Array.from({ length: 20 }, (_, index) => [index, 50 + (index % 5)]),
    };
    expect(runWhatIf(source, { driverColumn: "x", outcomeColumn: "y", pctChange: 10 }).fallback).toBe(true);
  });
});

describe("train / validation / test discipline", () => {
  it("splits rows three ways and reports each split separately", () => {
    const card = trainModel(regressionSource(), { task: "regression", targetColumn: "y", testRatio: 0.25 });
    const split = card.split;
    expect(split?.trainRows).toBeGreaterThan(0);
    expect(split?.validationRows).toBeGreaterThan(0);
    expect(split?.testRows).toBeGreaterThan(0);
    expect((split?.trainRows ?? 0) + (split?.validationRows ?? 0) + (split?.testRows ?? 0)).toBe(80);
    expect(card.metrics.validationR2).toEqual(expect.any(Number));
    expect(card.metrics.testR2).toEqual(expect.any(Number));
    expect(card.generalization?.primaryMetric).toBe("R²");
  });

  it("rates a strong, well-specified model as low overfitting risk", () => {
    const card = trainModel(regressionSource(), { task: "regression", targetColumn: "y" });
    expect(card.generalization?.risk).toBe("low");
  });

  it("flags a noise-fitting model as an overfitting risk instead of letting it look great", () => {
    // 24 training rows, 12 pure-noise features, an unrelated target: classic
    // overfitting. The guard must surface it, not report the training R² alone.
    const rows: (string | number | boolean | null)[][] = [];
    for (let i = 0; i < 40; i++) {
      const features = Array.from({ length: 12 }, (_, j) => ((i * (j + 3) * 7919) % 101) / 100);
      const target = ((i * 104729) % 97) - 48; // unrelated to the features
      rows.push([...features, target]);
    }
    const source: TrainableSource = {
      columns: [
        ...Array.from({ length: 12 }, (_, j) => ({ name: `f${j}`, type: "number" as const })),
        { name: "y", type: "number" as const },
      ],
      rows,
    };
    const card = trainModel(source, { task: "regression", targetColumn: "y", testRatio: 0.2 });
    expect(["medium", "high"]).toContain(card.generalization?.risk);
    expect(card.generalization?.explanation).toMatch(/held-out/i);
    // The same assessment is exposed on metrics so the Models list can show it.
    expect(card.metrics.generalization).toEqual(card.generalization);
  });

  it("reports a held-out generalization check for classification too", () => {
    const rows: (string | number | boolean | null)[][] = [];
    for (let i = 1; i <= 60; i++) {
      const spend = i * 2;
      rows.push([`c${i}`, spend, spend >= 50 ? "high" : "low"]);
    }
    const source: TrainableSource = {
      columns: [
        { name: "id", type: "string" },
        { name: "spend", type: "number" },
        { name: "segment", type: "string" },
      ],
      rows,
    };
    const card = trainModel(source, { task: "classification", targetColumn: "segment" });
    expect(card.generalization?.primaryMetric).toBe("accuracy");
    expect(card.metrics.validationAccuracy).toEqual(expect.any(Number));
    expect(card.split?.validationRows).toBeGreaterThan(0);
  });
});
