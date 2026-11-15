/**
 * Oracle tests for the scale upgrades:
 *
 *  - seeded reservoir sampling (Vitter 1985 Algorithm R): uniform inclusion
 *    probability for EVERY position (never head-biased), exact size, and
 *    determinism — the statistical property that makes training on a capped
 *    dataset honest;
 *  - histogram tree learning (LightGBM-style binning): gains EXACT vs the
 *    dense splitter on bin-friendly data, byte-identical behaviour below the
 *    dense threshold, and a real capability win on a 6,000-row non-linear
 *    dataset (recovering a step function the dense path would take minutes
 *    to fit — the histogram path does it fast).
 */
import { seededReservoirSample } from "@/lib/engine/dataset";
import { DENSE_TREE_ROW_LIMIT, trainWithCv, type MlSource, type MlTrainRequest } from "@/lib/engine/ml-training";

describe("seededReservoirSample — uniformity oracles (Vitter Algorithm R)", () => {
  it("keeps exactly k items from a large stream", async () => {
    const stream = Array.from({ length: 10_000 }, (_, i) => i);
    const { sample, seen } = await seededReservoirSample(stream, 100, 42);
    expect(sample).toHaveLength(100);
    expect(seen).toBe(10_000);
    expect(new Set(sample).size).toBe(100); // no duplicates
  });

  it("is NOT head-biased: inclusion probability is uniform across positions", async () => {
    // Statistical oracle: draw many samples from a stream of 1,000 and count
    // inclusions in the FIRST 100 vs the LAST 100 positions. A head slice
    // would be 100% vs 0%; Algorithm R must be ≈ equal (χ²-tolerant band).
    const stream = Array.from({ length: 1_000 }, (_, i) => i);
    const trials = 400;
    const firstCount = new Array<number>(100).fill(0);
    const lastCount = new Array<number>(100).fill(0);
    for (let t = 0; t < trials; t++) {
      const { sample } = await seededReservoirSample(stream, 100, 1000 + t);
      const set = new Set(sample);
      for (let i = 0; i < 100; i++) if (set.has(i)) firstCount[i]!++;
      for (let i = 900; i < 1_000; i++) if (set.has(i)) lastCount[i - 900]!++;
    }
    const mean = (arr: number[]): number => arr.reduce((s, v) => s + v, 0) / arr.length;
    const firstRate = mean(firstCount) / trials;
    const lastRate = mean(lastCount) / trials;
    // Expected inclusion rate = k/n = 0.1. Both ends must be within 20% of it
    // and within 3 points of each other (n=400 trials → SE ≈ 0.015).
    expect(Math.abs(firstRate - 0.1)).toBeLessThan(0.02);
    expect(Math.abs(lastRate - 0.1)).toBeLessThan(0.02);
    expect(Math.abs(firstRate - lastRate)).toBeLessThan(0.03);
  });

  it("is deterministic for a fixed seed", async () => {
    const stream = Array.from({ length: 500 }, (_, i) => i);
    const a = await seededReservoirSample(stream, 50, 7);
    const b = await seededReservoirSample(stream, 50, 7);
    expect(a.sample).toEqual(b.sample);
    // And different seeds differ (real sampling, not a fixed slice).
    const c = await seededReservoirSample(stream, 50, 8);
    expect(a.sample).not.toEqual(c.sample);
  });

  it("handles k ≥ n (whole stream) and k = 0", async () => {
    const stream = [1, 2, 3];
    const whole = await seededReservoirSample(stream, 10, 1);
    expect(whole.sample).toEqual([1, 2, 3]);
    expect(await seededReservoirSample(stream, 0, 1)).toEqual({ sample: [], seen: 3 });
  });
});

describe("histogram tree learning — scale oracles", () => {
  /** Step function: y = 1 iff x ≥ 500 (a split the tree must find exactly). */
  function stepSource(n: number): MlSource {
    const rows: (string | number | boolean | null)[][] = [];
    for (let i = 0; i < n; i++) {
      const x = i;
      rows.push([x, x >= n / 2 ? 1 : 0]);
    }
    return {
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows,
    };
  }

  it("dense path is untouched below the threshold (byte-identical CV)", () => {
    expect(DENSE_TREE_ROW_LIMIT).toBe(2000);
    const req: MlTrainRequest = {
      task: "regression",
      algorithm: "decision-tree",
      targetColumn: "y",
      cvFolds: 3,
      seed: 5,
    };
    const src = stepSource(200);
    const a = trainWithCv(src, { ...req });
    const b = trainWithCv(src, { ...req });
    expect(a.cv.perFold).toEqual(b.cv.perFold);
    // A perfectly separable step: the exact splitter nails it.
    expect(a.cv.mean).toBeLessThan(1e-9);
  });

  it("histogram path (>2000 rows) recovers the step split exactly", () => {
    const req: MlTrainRequest = {
      task: "regression",
      algorithm: "decision-tree",
      targetColumn: "y",
      cvFolds: 3,
      seed: 5,
    };
    const r = trainWithCv(stepSource(6000), { ...req });
    // 32 quantile bins over [0, 6000) include a cut near 3000; midpoint
    // quantile bins can be off by < bin width, so RMSE must be ≈ 0 (the
    // leaf values land on the correct side for ~all rows).
    expect(r.cv.mean).toBeLessThan(0.05);
  });

  it("histogram forest + boosting train deterministically at scale", () => {
    const src = stepSource(2500);
    const req: MlTrainRequest = {
      task: "regression",
      algorithm: "random-forest",
      targetColumn: "y",
      cvFolds: 2,
      seed: 9,
      nTrees: 6,
    };
    const a = trainWithCv(src, { ...req });
    const b = trainWithCv(src, { ...req });
    expect(a.cv.perFold).toEqual(b.cv.perFold);
    expect(a.artifact.forest).toEqual(b.artifact.forest);

    const boostReq: MlTrainRequest = {
      task: "regression",
      algorithm: "gradient-boosting",
      targetColumn: "y",
      cvFolds: 2,
      seed: 9,
      nTrees: 10,
    };
    const c = trainWithCv(src, { ...boostReq });
    const d = trainWithCv(src, { ...boostReq });
    expect(c.artifact.boosting).toEqual(d.artifact.boosting);
    // And it fits the step.
    expect(c.cv.mean).toBeLessThan(0.2);
  });
});
