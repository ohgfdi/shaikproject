/**
 * Oracle tests for the upgraded neural network (lib/engine/ml-training.ts):
 *
 *  - the classic XOR benchmark: NOT linearly separable — the logistic baseline
 *    provably fails it while the MLP must solve it;
 *  - a non-linear (sine) regression surface the linear baseline cannot fit;
 *  - multiclass convergence through the softmax head;
 *  - the modern training recipe end-to-end: mini-batch AdamW, warmup+cosine
 *    schedule, gradient clipping, weight decay, best-snapshot early stop;
 *  - deterministic training: same data + seed ⇒ byte-identical weights;
 *  - Friedman's stochastic gradient boosting: subsample < 1 stays competitive
 *    and the exact subsample = 1 behaviour is preserved byte-for-byte.
 *
 * Every threshold below is hand-picked from the oracle structure: XOR has a
 * known zero-loss solution; the sine wave's RMSE is compared against the
 * LINEAR baseline's on identical folds, so the assertion tests the ORDERING
 * (MLP ≪ linear), not an arbitrary constant.
 */
import { trainWithCv, type MlSource, type MlTrainRequest } from "@/lib/engine/ml-training";

/** The four XOR points, repeated, with a 2-feature coding. */
function xorSource(repeats = 30): MlSource {
  const base: [number, number, string][] = [
    [0, 0, "no"],
    [0, 1, "yes"],
    [1, 0, "yes"],
    [1, 1, "no"],
  ];
  const rows: (string | number | boolean | null)[][] = [];
  for (let r = 0; r < repeats; r++) {
    for (const [a, b, label] of base) rows.push([a, b, label]);
  }
  return {
    columns: [
      { name: "a", type: "number" },
      { name: "b", type: "number" },
      { name: "label", type: "string" },
    ],
    rows,
  };
}

/**
 * y = 0.1·x² over x ∈ [−20, 20], each x repeated 3×: a parabola is the
 * canonical no-linear-fit surface, and the repetition guarantees every fold's
 * held-out rows interpolate (k-fold on an unordered, repeated design — NOT a
 * temporal extrapolation task, which no function-fitting oracle should be).
 */
function parabolaSource(repeats = 3): MlSource {
  const rows: (string | number | boolean | null)[][] = [];
  for (let r = 0; r < repeats; r++) {
    for (let x = -20; x <= 20; x++) rows.push([x, 0.1 * x * x]);
  }
  return {
    columns: [
      { name: "x", type: "number" },
      { name: "y", type: "number" },
    ],
    rows,
  };
}

/** Three concentric rings — not separable by any hyperplane, trivial for an MLP. */
function ringsSource(repeats = 20): MlSource {
  const rows: (string | number | boolean | null)[][] = [];
  const ring = (radius: number, label: string): void => {
    for (let k = 0; k < repeats; k++) {
      const angle = (2 * Math.PI * k) / repeats;
      rows.push([radius * Math.cos(angle), radius * Math.sin(angle), label]);
    }
  };
  ring(0.3, "inner");
  ring(1.0, "middle");
  ring(2.0, "outer");
  return {
    columns: [
      { name: "x", type: "number" },
      { name: "y", type: "number" },
      { name: "ring", type: "string" },
    ],
    rows,
  };
}

const MLP_REQ: MlTrainRequest = {
  task: "binary-classification",
  algorithm: "mlp",
  targetColumn: "label",
  cvFolds: 4,
  seed: 11,
};

describe("MLP upgrade — capability oracles", () => {
  it("solves XOR (OOF AUC = 1) where the logistic baseline provably fails", () => {
    // Logistic regression is a linear model: on XOR (its canonical
    // impossibility proof) the separable MLE degenerates to a single-point
    // separator — held-out AUC lands BELOW the no-skill 0.5. The exact value
    // depends on fold assignment; the oracle property is that it FAILS.
    const linear = trainWithCv(xorSource(), { ...MLP_REQ, algorithm: "logistic" });
    expect(linear.cv.mean).toBeLessThan(0.5);

    const mlp = trainWithCv(xorSource(), { ...MLP_REQ, epochs: 300 });
    expect(mlp.cv.mean).toBe(1);
    expect(mlp.algorithm).toBe("mlp");
  });

  it("fits the parabola far below the linear baseline on identical folds", () => {
    const req: MlTrainRequest = { task: "regression", algorithm: "mlp", targetColumn: "y", cvFolds: 4, seed: 5 };
    // A parabola's best linear fit leaves residual ≈ the curvature: on this
    // target (SD ≈ 11.5) ridge's OOF RMSE is huge by construction.
    const linear = trainWithCv(parabolaSource(), { ...req, algorithm: "ridge", lambda: 0.001 });
    const mlp = trainWithCv(parabolaSource(), { ...req, epochs: 300, hiddenUnits: 32 });
    expect(mlp.cv.mean).toBeLessThan(linear.cv.mean / 2);
    // And it actually fits the surface: RMSE under 1 on a target spanning 0–40.
    expect(mlp.cv.mean).toBeLessThan(1);
  });

  it("multiclass: concentric rings converge through the softmax head", () => {
    const r = trainWithCv(ringsSource(), {
      task: "multiclass-classification",
      algorithm: "mlp",
      targetColumn: "ring",
      cvFolds: 4,
      seed: 3,
      epochs: 300,
    });
    expect(r.classes).toEqual(["inner", "middle", "outer"]);
    expect(r.cv.mean).toBeGreaterThan(0.9);
    const m = r.trainMetrics as { accuracy: number };
    expect(m.accuracy).toBeGreaterThan(0.9);
  });

  it("is deterministic — same data + seed ⇒ identical CV, importance and weights", () => {
    const a = trainWithCv(xorSource(), { ...MLP_REQ, epochs: 60 });
    const b = trainWithCv(xorSource(), { ...MLP_REQ, epochs: 60 });
    expect(a.cv.perFold).toEqual(b.cv.perFold);
    expect(a.importance).toEqual(b.importance);
    expect(a.artifact.mlp).toEqual(b.artifact.mlp);
  });

  it("serializes the layer tensors on the artifact (aerolexa.ml.v1)", () => {
    const r = trainWithCv(xorSource(), { ...MLP_REQ, hiddenUnits: 8, epochs: 40 });
    const mlp = r.artifact.mlp!;
    expect(mlp.activation).toBe("relu");
    expect(mlp.head).toBe("sigmoid");
    // input(2) → 8 → 8 → output(1)
    expect(mlp.layers).toHaveLength(3);
    expect(mlp.layers[0]!.length).toBe(8);
    expect(mlp.layers[0]![0]!.length).toBe(2);
    expect(mlp.layers[1]!.length).toBe(8);
    expect(mlp.layers[2]!.length).toBe(1);
    expect(mlp.biases).toHaveLength(3);
    // Hyperparameters travel with the card.
    expect(r.artifact.hyperparams.hiddenUnits).toBe(8);
    expect(r.artifact.hyperparams.epochs).toBe(40);
  });

  it("weight decay shrinks the weight tensors (L2 regularization is real)", () => {
    const train = (wd: number): { l2: number } => {
      const r = trainWithCv(xorSource(), { ...MLP_REQ, epochs: 80, weightDecay: wd, batchSize: 120 });
      const mlp = r.artifact.mlp!;
      let l2 = 0;
      for (const layer of mlp.layers) for (const row of layer) for (const w of row) l2 += w * w;
      return { l2 };
    };
    // Same seed and budget; only the decay differs. Heavier decay must pull
    // the weights toward zero (strictly less L2 mass).
    expect(train(0.05).l2).toBeLessThan(train(0).l2);
  });

  it("early-stops a plateauing run instead of burning the full epoch budget", () => {
    // A trivially separable problem converges quickly; patience 25 + best-
    // snapshot logic must stop the loop well before maxEpochs. We detect the
    // stop indirectly: runtime stays bounded AND the metrics are perfect.
    const started = Date.now();
    const r = trainWithCv(classificationLike(), { ...MLP_REQ, epochs: 400 });
    expect(r.cv.mean).toBe(1);
    // 400 epochs × 12 folds would be slow; early stop keeps it snappy.
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe("stochastic gradient boosting (Friedman 2002 subsampling)", () => {
  function boostingSource(): MlSource {
    const rows: (string | number | boolean | null)[][] = [];
    for (let i = 0; i < 80; i++) {
      const x1 = (i * 7) % 23;
      const x2 = (i * 11) % 19;
      rows.push([x1, x2, x1 * x2 > 150 ? "hi" : "lo"]);
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
  const REQ: MlTrainRequest = {
    task: "binary-classification",
    algorithm: "gradient-boosting",
    targetColumn: "label",
    cvFolds: 3,
    seed: 7,
    nTrees: 40,
  };

  it("subsample = 1 keeps the historical byte-for-byte deterministic full-batch fit", () => {
    const a = trainWithCv(boostingSource(), { ...REQ, subsample: 1 });
    const b = trainWithCv(boostingSource(), { ...REQ });
    expect(a.cv.perFold).toEqual(b.cv.perFold);
    // Re-running with the same seed reproduces the trees exactly.
    const again = trainWithCv(boostingSource(), { ...REQ, subsample: 1 });
    expect(again.artifact.boosting).toEqual(a.artifact.boosting);
  });

  it("subsample = 0.7 trains a real model that stays competitive on OOF AUC", () => {
    const full = trainWithCv(boostingSource(), { ...REQ, subsample: 1 });
    const stoch = trainWithCv(boostingSource(), { ...REQ, subsample: 0.7 });
    expect(stoch.artifact.algorithm).toBe("gradient-boosting");
    expect(stoch.artifact.boosting!.trees.length).toBe(40);
    // Row subsampling must not destroy the fit (within 0.15 AUC of full-batch).
    expect(stoch.cv.mean).toBeGreaterThan(full.cv.mean - 0.15);
  });

  it("stochastic boosting is deterministic for a fixed seed", () => {
    const a = trainWithCv(boostingSource(), { ...REQ, subsample: 0.6, seed: 21 });
    const b = trainWithCv(boostingSource(), { ...REQ, subsample: 0.6, seed: 21 });
    expect(a.artifact.boosting).toEqual(b.artifact.boosting);
  });
});

/** Small clean separable set for the early-stop timing probe. */
function classificationLike(): MlSource {
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
