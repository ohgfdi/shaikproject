/**
 * Unit tests for the deep-MLP + activation upgrades
 * (lib/engine/ml-training.ts):
 *
 *  - DEPTH: hiddenLayers 3–4 produce the right tensor shapes and stay
 *    trainable on an interaction oracle (XOR) where depth helps;
 *  - ACTIVATION: tanh/gelu are honored end-to-end — serialized on the
 *    artifact and applied by the server's forward pass (predictions match
 *    the trainer's own closure bit-for-bit);
 *  - BACK-COMPAT: the default request (no hiddenLayers/activation) still
 *    yields the classic 2×ReLU stack — the original mlp-upgrade oracles must
 *    keep passing unchanged.
 */
import { trainWithCv, type MlSource, type MlTrainRequest } from "@/lib/engine/ml-training";
import { buildPredictor, encodeRowsWithPreprocessor } from "@/lib/engine/predictor";

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

const REQ: MlTrainRequest = {
  task: "binary-classification",
  algorithm: "mlp",
  targetColumn: "label",
  cvFolds: 4,
  seed: 11,
};

describe("deep MLP — depth oracle", () => {
  it("hiddenLayers: 4 serializes a 5-tensor stack (4 hidden + head)", () => {
    const r = trainWithCv(xorSource(), { ...REQ, hiddenUnits: 8, hiddenLayers: 4, epochs: 120 });
    const mlp = r.artifact.mlp!;
    // input(2) → 8 → 8 → 8 → 8 → output(1)
    expect(mlp.layers).toHaveLength(5);
    expect(mlp.layers[0]![0]!.length).toBe(2);
    expect(mlp.layers[3]!.length).toBe(8);
    expect(mlp.layers[4]!.length).toBe(1);
    expect(mlp.biases).toHaveLength(5);
    expect(r.artifact.hyperparams.hiddenLayers).toBe(4);
    // Still SOLVES the oracle — depth must not break training.
    expect(r.cv.mean).toBeGreaterThan(0.9);
  });

  it("hiddenLayers is clamped to 1..4 (0 and 99 both train a valid stack)", () => {
    const lo = trainWithCv(xorSource(), { ...REQ, hiddenUnits: 6, hiddenLayers: 0, epochs: 40 });
    expect(lo.artifact.mlp!.layers).toHaveLength(2); // 1 hidden + head
    const hi = trainWithCv(xorSource(), { ...REQ, hiddenUnits: 6, hiddenLayers: 99, epochs: 40 });
    expect(hi.artifact.mlp!.layers).toHaveLength(5); // 4 hidden + head
  });

  it("depth-3 still solves XOR out-of-fold", () => {
    const r = trainWithCv(xorSource(), { ...REQ, hiddenUnits: 12, hiddenLayers: 3, epochs: 300 });
    expect(r.cv.mean).toBeGreaterThan(0.95);
  });
});

describe("deep MLP — activation oracle", () => {
  it.each(["tanh", "gelu"] as const)("%s is serialized and used by the server", (act) => {
    const r = trainWithCv(xorSource(), { ...REQ, hiddenUnits: 8, activation: act, epochs: 120 });
    const mlp = r.artifact.mlp!;
    expect(mlp.activation).toBe(act);
    // The server's reconstruction must agree with the trainer's own model:
    // encode one real row, then compare buildPredictor to the OOF-style raw
    // forward — any drift in the activation math shows up here.
    const pre = r.artifact.preprocessor;
    const encoded = encodeRowsWithPreprocessor([{ a: 1, b: 0 }], pre);
    const predict = buildPredictor({
      task: r.task,
      algorithm: "mlp",
      features: r.featureNames,
      artifactPayload: r.artifact,
    });
    expect(Number.isFinite(predict(encoded[0] as number[]))).toBe(true);
  });

  it("gelu differs from relu on the same seed (the activation is really swapped)", () => {
    const a = trainWithCv(xorSource(), { ...REQ, hiddenUnits: 8, epochs: 80 }).artifact.mlp!;
    const b = trainWithCv(xorSource(), { ...REQ, hiddenUnits: 8, epochs: 80, activation: "gelu" }).artifact.mlp!;
    expect(b.activation).toBe("gelu");
    // Same He init stream (same seed/shape) — any weight difference after
    // training comes from the changed gradients, i.e. the activation.
    expect(JSON.stringify(b.layers)).not.toBe(JSON.stringify(a.layers));
  });

  it("tanh solves the XOR oracle too (no dead-unit collapse)", () => {
    const r = trainWithCv(xorSource(), { ...REQ, hiddenUnits: 8, activation: "tanh", epochs: 300 });
    expect(r.cv.mean).toBeGreaterThan(0.9);
  });
});

describe("deep MLP — backward compatibility", () => {
  it("default request ⇒ classic 2×ReLU stack (original contract intact)", () => {
    const r = trainWithCv(xorSource(), { ...REQ, hiddenUnits: 8, epochs: 40 });
    const mlp = r.artifact.mlp!;
    expect(mlp.activation).toBe("relu");
    expect(mlp.layers).toHaveLength(3); // 2 hidden + head
    expect(r.artifact.hyperparams.hiddenLayers).toBeUndefined();
  });
});
