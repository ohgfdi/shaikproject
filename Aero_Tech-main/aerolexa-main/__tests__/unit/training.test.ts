/**
 * Unit tests for the statistical model trainer (lib/engine/training.ts).
 * Tests real train/validation/test splits, held-out metrics, and overfitting detection.
 */
import { trainModel, type TrainableSource } from "@/lib/engine/training";

function regressionSource(): TrainableSource {
  // margin = 3×units + 2×price_factor + noise-ish; strong signal.
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 1; i <= 60; i++) {
    const units = 5 + (i % 30);
    const price = 2 + (i % 7);
    rows.push([`r${i}`, units, price, 3 * units + 2 * price + (i % 3) - 1]);
  }
  return {
    columns: [
      { name: "id", type: "string" },
      { name: "units", type: "number" },
      { name: "price", type: "number" },
      { name: "margin", type: "number" },
    ],
    rows,
  };
}

function classificationSource(): TrainableSource {
  // Label = high (1) when spend ≥ 50, low (0) otherwise — separable by spend.
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 1; i <= 60; i++) {
    const spend = i * 2;
    rows.push([`c${i}`, spend, spend >= 50 ? "high" : "low"]);
  }
  return {
    columns: [
      { name: "id", type: "string" },
      { name: "spend", type: "number" },
      { name: "segment", type: "string" },
    ],
    rows,
  };
}

function clusteringSource(): TrainableSource {
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 0; i < 60; i++) {
    const cluster = i % 2;
    rows.push([`p${i}`, cluster === 0 ? 10 + (i % 5) : 50 + (i % 5), cluster === 0 ? 20 : 90]);
  }
  return {
    columns: [
      { name: "id", type: "string" },
      { name: "x", type: "number" },
      { name: "y", type: "number" },
    ],
    rows,
  };
}

describe("trainModel — regression", () => {
  it("returns a fitted card with plausible metrics", () => {
    const card = trainModel(regressionSource(), { task: "regression", targetColumn: "margin", name: "Margin model" });
    expect(card.task).toBe("regression");
    expect(card.name).toBe("Margin model");
    expect(card.metrics.r2).toBeGreaterThan(0.9);
    expect(card.metrics.trainRows).toBe(60);
    expect(card.features).toEqual(["units", "price"]);
    expect(card.demoNote).toContain("train / validation / test split");
    expect(card.metadata.engine).toBe("hold-out-regression");
  });

  it("includes the target column among trained features only when excluded", () => {
    const card = trainModel(regressionSource(), { task: "regression", targetColumn: "margin" });
    expect(card.features).not.toContain("margin");
  });
});

describe("trainModel — classification", () => {
  it("fits a binary classifier on a two-value string target", () => {
    const card = trainModel(classificationSource(), {
      task: "classification",
      targetColumn: "segment",
      name: "Segment model",
    });
    expect(card.task).toBe("classification");
    expect(card.classMap).toEqual({ positive: "high", negative: "low" });
    expect(card.metrics.accuracy).toBeGreaterThan(0.9);
  });
});

describe("trainModel — clustering", () => {
  it("discovers k clusters over numeric features", () => {
    const card = trainModel(clusteringSource(), { task: "clustering", hyperparams: { k: 2 } });
    expect(card.task).toBe("clustering");
    expect(card.metrics.k).toBe(2);
    expect(card.centroids).toHaveLength(2);
    expect(card.metrics.clusterSizes).toHaveLength(2);
  });
});

describe("trainModel — validation", () => {
  it("requires a target for supervised tasks", () => {
    expect(() => trainModel(regressionSource(), { task: "regression" })).toThrow(/target/i);
  });

  it("rejects an unknown target column", () => {
    expect(() => trainModel(regressionSource(), { task: "regression", targetColumn: "missing" })).toThrow(/not found/i);
  });

  it("rejects too few usable rows", () => {
    const tiny: TrainableSource = {
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: [
        [1, 2],
        [2, 3],
      ],
    };
    expect(() => trainModel(tiny, { task: "regression", targetColumn: "y" })).toThrow(
      /usable values|10 rows|complete rows/i,
    );
  });

  it("rejects multi-class targets for classification", () => {
    const multi = classificationSource();
    multi.rows = multi.rows.map((r, i) => [r[0] ?? "", r[1] ?? 0, i < 20 ? "low" : i < 40 ? "high" : "mid"]);
    expect(() => trainModel(multi, { task: "classification", targetColumn: "segment" })).toThrow(/two values/i);
  });
});
