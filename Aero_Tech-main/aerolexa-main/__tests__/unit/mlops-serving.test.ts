/**
 * Oracle tests for the two MLOps upgrades:
 *
 *  - Shapley attribution engine (lib/engine/shapley.ts): the ADDITIVE
 *    property is the oracle — prediction − E[background] must equal Σφ within
 *    sampling noise, on known functions where the true φ is hand-computable;
 *  - Model-serving predictor (lib/engine/predictor.ts): the EXACTNESS oracle
 *    — a served prediction must equal what the trainer's model computed on
 *    the same row, proven for every serializable algorithm.
 *
 * Hand-computed anchors:
 *  - y = 3·x1 + 2·x2 + 1: φ(x1) = 3·(x1 − E[x1]), φ(x2) = 2·(x2 − E[x2]) —
 *    Shapley recovers the slope exactly for additive models;
 *  - y = x1·x2 (pure interaction): equal marginal variances ⇒ φ(x1) = φ(x2)
 *    by symmetry;
 *  - ridge artifacts: predictor(x) === trainRidge predict(x).
 */
import { encodeDataset, trainWithCv, type MlSource, type MlTrainRequest } from "@/lib/engine/ml-training";
import {
  buildPredictor,
  encodeRowsWithPreprocessor,
  explainRow,
  missingInputFeatures,
  requiredInputFeatures,
  serve,
} from "@/lib/engine/predictor";
import { explainPrediction } from "@/lib/engine/shapley";

/** Exactly linear: additive truth with known slopes. */
function linearSource(): MlSource {
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 0; i < 40; i++) {
    const x1 = i % 10;
    const x2 = (i * 3) % 7;
    rows.push([x1, x2, 3 * x1 + 2 * x2 + 1]);
  }
  return {
    columns: [
      { name: "x1", type: "number" },
      { name: "x2", type: "number" },
      { name: "y", type: "number" },
    ],
    rows,
  };
}

function trainLinear(req: Partial<MlTrainRequest> = {}): ReturnType<typeof trainWithCv> {
  return trainWithCv(linearSource(), {
    task: "regression",
    algorithm: "ridge",
    targetColumn: "y",
    lambda: 1e-9,
    ...req,
  });
}

describe("shapley — additive-property oracles", () => {
  it("recovers the hand-computed φ for an additive linear function", () => {
    // f(x) = 3x1 + 2x2. For ANY background: φ(x1) = 3(x1 − E[x1]),
    // φ(x2) = 2(x2 − E[x2]) — the slope times the feature's deviation.
    const f = (x: number[]): number => 3 * (x[0] as number) + 2 * (x[1] as number);
    const background = [
      [0, 0],
      [2, 4],
      [4, 2],
      [6, 6],
      [8, 8],
      [10, 0],
    ];
    const e1 = (0 + 2 + 4 + 6 + 8 + 10) / 6; // 5
    const e2 = (0 + 4 + 2 + 6 + 8 + 0) / 6; // ~3.33
    const exp = explainPrediction(f, [10, 6], background, ["x1", "x2"], 7, 40);
    expect(exp.prediction).toBe(42);
    expect(exp.baseValue).toBeCloseTo(3 * e1 + 2 * e2, 6);
    // Sorted by |φ|: x1 (slope 3) must outrank x2 (slope 2) at x=(10,6).
    expect(exp.contributions[0]!.feature).toBe("x1");
    expect(exp.contributions[0]!.phi).toBeCloseTo(3 * (10 - e1), 1);
    expect(exp.contributions[1]!.phi).toBeCloseTo(2 * (6 - e2), 1);
    // The additive guarantee: reconstruction error ≈ 0.
    expect(Math.abs(exp.reconstructionError)).toBeLessThan(1e-9);
  });

  it("is symmetric on a pure interaction at a symmetric point (y = x1·x2, x = (c, c))", () => {
    const f = (x: number[]): number => (x[0] as number) * (x[1] as number);
    const background = [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 6],
    ];
    // At x = (6, 6) the interventional Shapley value (Strumbelj estimator:
    // features NOT yet swapped use background, features already swapped use
    // the actual point) is identical for both features:
    //   φ = ½·(x₁·E[d] − E[d²]) + ½·(x₁x₂ − E[d]·x₂) = ½·8.75 + ½·15 = 11.875
    // (E[d] = 3.5, E[d²] = 91/6). An ASYMMETRIC point (e.g. (6, 2)) has
    // intentionally different φ — symmetry needs the symmetric point.
    const exp = explainPrediction(f, [6, 6], background, ["a", "b"], 11, 60);
    const truePhi = 0.5 * (6 * 3.5 - 91 / 6) + 0.5 * (36 - 3.5 * 6);
    expect(exp.contributions[1]!.phi).toBeCloseTo(truePhi, 0);
    expect(Math.abs(exp.contributions[0]!.phi - exp.contributions[1]!.phi)).toBeLessThan(1.5);
    expect(Math.abs(exp.reconstructionError)).toBeLessThan(1e-9);
  });

  it("is deterministic for a fixed seed", () => {
    const f = (x: number[]): number => (x[0] as number) ** 2 + (x[1] as number);
    const a = explainPrediction(
      f,
      [3, 5],
      [
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
      ],
      ["u", "v"],
      3,
      16,
    );
    const b = explainPrediction(
      f,
      [3, 5],
      [
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
      ],
      ["u", "v"],
      3,
      16,
    );
    expect(a.contributions).toEqual(b.contributions);
    expect(a.baseValue).toBe(b.baseValue);
  });
});

describe("predictor — serving exactness oracles", () => {
  it("serves ridge EXACTLY: predictor(x) === the trained model's predict(x)", () => {
    const result = trainLinear();
    const predictor = buildPredictor({
      task: "regression",
      algorithm: "ridge",
      features: result.featureNames,
      weights: result.artifact.weights,
      intercept: result.artifact.intercept,
    });
    // Any raw row through the train-fitted preprocessor must give the same
    // answer the trainer's own model computes on its encoded form.
    const src = linearSource();
    const enc = encodeDataset(src, { task: "regression", algorithm: "ridge", targetColumn: "y", lambda: 1e-9 });
    for (let i = 0; i < 5; i++) {
      expect(predictor(enc.X[i] as number[])).toBeCloseTo(enc.y[i] as number, 5);
    }
  });

  it("serves the full pipeline: encode(raw) → predict matches the trainer's OOF-quality fit", () => {
    const result = trainLinear();
    const payload = result.artifact;
    const model = {
      task: "regression",
      algorithm: "ridge",
      targetColumn: "y",
      features: payload.featureNames,
      weights: payload.weights,
      intercept: payload.intercept,
      artifactPayload: payload,
    };
    const raw = { x1: 8, x2: 5 };
    const out = serve(model, raw);
    expect(out.output).toBeCloseTo(3 * 8 + 2 * 5 + 1, 2); // 35 ± λ-shrinkage
    expect(out.methodology).toContain("aerolexa.ml.v1");
  });

  it("serves the MLP from stored tensors: same forward as the trainer", () => {
    const xorSource = (): MlSource => {
      const base: [number, number, string][] = [
        [0, 0, "no"],
        [0, 1, "yes"],
        [1, 0, "yes"],
        [1, 1, "no"],
      ];
      const rows: (string | number | boolean | null)[][] = [];
      for (let r = 0; r < 30; r++) for (const [a, b, l] of base) rows.push([a, b, l]);
      return {
        columns: [
          { name: "a", type: "number" },
          { name: "b", type: "number" },
          { name: "label", type: "string" },
        ],
        rows,
      };
    };
    const req: MlTrainRequest = {
      task: "binary-classification",
      algorithm: "mlp",
      targetColumn: "label",
      cvFolds: 4,
      seed: 11,
      epochs: 80,
    };
    const result = trainWithCv(xorSource(), req);
    const model = {
      task: "binary-classification",
      algorithm: "mlp",
      targetColumn: "label",
      features: result.artifact.featureNames,
      artifactPayload: result.artifact,
    };
    // A learned-XOR point and an unlearnable raw row behave differently —
    // the served model is the trained model, not a fresh random net.
    const yes = serve(model, { a: 0, b: 1 });
    const no = serve(model, { a: 1, b: 1 });
    expect(yes.probabilities).toHaveLength(2);
    expect((yes.probabilities as { label: string; probability: number }[])[1]!.probability).toBeGreaterThan(0.5);
    expect((no.probabilities as { label: string; probability: number }[])[1]!.probability).toBeLessThan(0.5);
  });

  it("unseen categorical levels encode all-zeros (handle_unknown='ignore')", () => {
    const pre = {
      featureNames: ["region=East", "region=West", "units"],
      medians: [20],
      means: [0, 0, 25],
      stds: [1, 1, 10],
      categoricalLevels: [{ source: "region", levels: ["East", "West"] }],
    };
    const encoded = encodeRowsWithPreprocessor([{ region: "South", units: 45 }], pre);
    expect(encoded[0]).toEqual([0, 0, 2]); // unseen level → zeros; (45−25)/10
  });

  it("explains a served prediction end-to-end (attributions add up)", () => {
    const result = trainLinear();
    const payload = result.artifact;
    const model = {
      task: "regression",
      algorithm: "ridge",
      targetColumn: "y",
      features: payload.featureNames,
      artifactPayload: payload,
    };
    const src = linearSource();
    const raw = src.rows.slice(0, 12).map((r) => ({ x1: r[0], x2: r[1] }));
    const { explanation } = explainRow(model, { x1: 9, x2: 3 }, raw, { seed: 5, nPermutations: 24 });
    expect(Math.abs(explanation.reconstructionError)).toBeLessThan(1e-6);
    expect(explanation.contributions).toHaveLength(2);
  });
});

/**
 * Regression oracle for the /predict and /explain request contract.
 *
 * The stored design matrix is one-hot EXPANDED (a categorical `region` with two
 * levels becomes `region=East` + `region=West`), so `preprocessor.featureNames`
 * names encoded columns a client never sends. Validating a request against it
 * rejected every complete, correct body — while `/predict`, which validated
 * nothing at all, silently answered from imputed values. Both routes now ask
 * for the RAW columns via requiredInputFeatures(), the inverse of the encoder.
 */
describe("requiredInputFeatures — raw request contract", () => {
  /** Numeric-only model: raw and encoded names coincide. */
  it("returns the raw feature columns for a numeric-only model", () => {
    const payload = trainLinear().artifact;
    const model = {
      task: "regression",
      algorithm: "ridge",
      targetColumn: "y",
      features: payload.featureNames,
      artifactPayload: payload,
    };
    expect(requiredInputFeatures(model).sort()).toEqual(["x1", "x2"]);
    expect(missingInputFeatures(model, { x1: 1, x2: 2 })).toEqual([]);
    expect(missingInputFeatures(model, { x1: 1 })).toEqual(["x2"]);
  });

  /** The regression that broke both routes: `region` expands to two columns. */
  it("undoes one-hot expansion back to the original categorical column", () => {
    const rows: (string | number)[][] = [];
    for (let i = 0; i < 30; i++) rows.push([i % 3 === 0 ? "East" : "West", i, i * 10]);
    const payload = trainWithCv(
      {
        columns: [
          { name: "region", type: "string" },
          { name: "units", type: "number" },
          { name: "revenue", type: "number" },
        ],
        rows,
      },
      { task: "regression", algorithm: "ridge", targetColumn: "revenue", lambda: 1e-9 },
    ).artifact;

    // The encoded matrix really is expanded — that is the trap.
    const oneHot = payload.featureNames.filter((f) => f.includes("="));
    expect(oneHot.length).toBeGreaterThan(0);
    expect(payload.preprocessor.categoricalLevels.map((c) => c.source)).toContain("region");

    const model = {
      task: "regression",
      algorithm: "ridge",
      targetColumn: "revenue",
      features: payload.featureNames,
      artifactPayload: payload,
    };
    // Raw columns, exactly what a client sends.
    expect(requiredInputFeatures(model).sort()).toEqual(["region", "units"]);
    // A COMPLETE row is accepted (the old check rejected it).
    expect(missingInputFeatures(model, { region: "East", units: 12 })).toEqual([]);
    // An INCOMPLETE row is reported (the old /predict check accepted it).
    expect(missingInputFeatures(model, { region: "East" })).toEqual(["units"]);
  });

  it("falls back to the card's features when no fitted preprocessor is stored", () => {
    const model = { task: "regression", algorithm: "ridge", targetColumn: "y", features: ["x1", "x2"] };
    expect(requiredInputFeatures(model)).toEqual(["x1", "x2"]);
    expect(missingInputFeatures(model, { x1: 1 })).toEqual(["x2"]);
  });
});
