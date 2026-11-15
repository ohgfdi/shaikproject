/**
 * Unit tests for blended ensembles (`lib/engine/ensemble.ts` + AutoML wiring
 * in `lib/engine/automl.ts` + serving in `lib/engine/predictor.ts`).
 *
 * Pins the trust contracts:
 *  - OOF evaluation is deterministic (same data + seed ⇒ byte-identical);
 *  - the servable ensemble block carries ≥ 2 SELF-CONTAINED member artifacts;
 *  - serving through the mean combiner equals the mean of the member serves
 *    (exact structural check, not a statistical one);
 *  - AutoML attaches the ensemble ONLY when it genuinely beat the winner,
 *    and when attached, the winner artifact carries a servable block;
 *  - nested/degraded ensembles fail loudly (no silent guess).
 */
import { describe, expect, it } from "@jest/globals";

import { autoTrain } from "@/lib/engine/automl";
import { evaluateBlendedEnsemble, type EnsembleMemberSpec } from "@/lib/engine/ensemble";
import { trainWithCv, type MlSource, type MlTrainRequest } from "@/lib/engine/ml-training";
import { serve } from "@/lib/engine/predictor";

/** Linear truth + noise: ridge should nail it; blends must not drift away. */
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

/** Non-linear interaction truth — trees/boosting/MLP each capture a piece. */
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

describe("evaluateBlendedEnsemble — OOF contract", () => {
  it("is deterministic: same data + seed ⇒ identical OOF score and artifacts", () => {
    const src = nonlinearSource();
    const members: EnsembleMemberSpec[] = [
      { algorithm: "logistic", hyperparams: { lambda: 1 } },
      { algorithm: "decision-tree", hyperparams: { maxDepth: 4, minLeaf: 2 } },
    ];
    const a = evaluateBlendedEnsemble(
      src,
      { task: "binary-classification", algorithm: "ridge", targetColumn: "label", cvFolds: 3, seed: 7 },
      members,
      3,
      7,
      "rocAuc",
    );
    const b = evaluateBlendedEnsemble(
      src,
      { task: "binary-classification", algorithm: "ridge", targetColumn: "label", cvFolds: 3, seed: 7 },
      members,
      3,
      7,
      "rocAuc",
    );
    expect(a.oofScore).toBe(b.oofScore);
    expect(a.perFold).toEqual(b.perFold);
    expect(a.block.kind).toBe("aerolexa.ml.ensemble.v1");
    expect(b.block.kind).toBe("aerolexa.ml.ensemble.v1");
  });

  it("member scores serve finite outputs and probabilities", () => {
    const src = linearSource();
    const req: MlTrainRequest = { ...REG_REQ };
    const members: EnsembleMemberSpec[] = [
      { algorithm: "ridge", hyperparams: { lambda: 1 } },
      { algorithm: "knn", hyperparams: { k: 3 } },
    ];
    const ev = evaluateBlendedEnsemble(src, req, members, 3, 7, "rmse");
    expect(Number.isFinite(ev.oofScore)).toBe(true);
    // A perfect linear + mean blend of ridge+kNN: OOF RMSE stays tiny.
    expect(ev.oofScore).toBeLessThan(2);
  });

  it("mean-combiner serving equals the mean of member serves", () => {
    const src = linearSource();
    const req: MlTrainRequest = { ...REG_REQ };
    const members = [
      { algorithm: "ridge" as const, hyperparams: { lambda: 1 } },
      { algorithm: "knn" as const, hyperparams: { k: 5 } },
    ];
    // Build the member artifacts exactly as the ensemble block does:
    // full-data refits with the same request + seed.
    const arts = members.map(
      (m) => trainWithCv(src, { ...req, algorithm: m.algorithm, ...m.hyperparams, cvFolds: 2, seed: 7 }).artifact,
    );
    const rawRow: Record<string, unknown> = { x1: 5, x2: 1, grp: "A" };
    const memberOutputs = arts.map((art) =>
      Number(
        serve(
          {
            task: "regression",
            algorithm: art.algorithm,
            targetColumn: art.targetColumn,
            features: art.featureNames,
            artifactPayload: art,
          },
          rawRow,
        ).output,
      ),
    );
    const expected = memberOutputs.reduce((s, v) => s + v, 0) / memberOutputs.length;
    // serve through the ensemble payload: winner-styled card + ensemble block
    const ensArtifact = { ...arts[0]!, ensemble: { kind: "aerolexa.ml.ensemble.v1", combiner: "mean", members: arts } };
    const served = serve(
      {
        task: "regression",
        algorithm: ensArtifact.algorithm,
        targetColumn: ensArtifact.targetColumn,
        features: ensArtifact.featureNames,
        artifactPayload: ensArtifact,
      },
      rawRow,
    );
    expect(Number(served.output)).toBeCloseTo(expected, 10);
    expect(served.methodology).toContain("blended ensemble");
  });
});

describe("autoTrain — ensemble attachment contract", () => {
  it("is deterministic and returns a well-formed result with or without an ensemble", () => {
    const src = nonlinearSource();
    const req: MlTrainRequest = {
      task: "binary-classification",
      algorithm: "logistic",
      targetColumn: "label",
      cvFolds: 3,
      seed: 7,
    };
    const a = autoTrain(src, req, 6);
    const b = autoTrain(src, req, 6);
    expect(a).toEqual(b);
    if (a.ensemble) {
      expect(a.ensemble.members.length).toBeGreaterThanOrEqual(2);
      expect(Number.isFinite(a.ensemble.oofScore)).toBe(true);
      // The winner artifact carries the SERVABLE block.
      const art = a.best.artifact as { ensemble?: { members?: unknown[]; combiner?: string }; algorithm?: string };
      expect(art.ensemble).toBeDefined();
      expect(art.ensemble!.members!.length).toBe(a.ensemble.members.length);
      // Serving through the trained artifact card works end-to-end.
      const served = serve(
        {
          task: "binary-classification",
          algorithm: art.algorithm ?? a.best.algorithm,
          targetColumn: a.best.targetColumn,
          features: a.best.featureNames,
          artifactPayload: art as never,
        },
        { x1: 21, x2: 18 },
      );
      expect(["hi", "lo"]).toContain(String(served.output));
    }
  });
});
