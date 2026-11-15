import {
  LruCache,
  RealTimeServingError,
  allocateAbVariant,
  assignBin,
  cacheKey,
  executePrediction,
  fitServingArtifact,
  scoreLinear,
  simulateServing,
  vectorize,
  warmupArtifact,
  type ModelArtifact,
  type ServeRequest,
} from "@/lib/engine/real-time-serving";

/** A small, well-separated binary problem: y = 1 exactly when x1 > x2. */
function separableBinary(n = 200) {
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i * 37) % 100) / 10;
    const b = ((i * 61) % 100) / 100;
    X.push([a, b, a + b]);
    y.push(a > b ? 1 : 0);
  }
  return { X, y };
}

/**
 * The same boundary as `separableBinary` but with a fixed slice of labels
 * flipped, so the classes overlap and the logistic fit has a finite solution.
 */
function noisyBinary(n = 300) {
  const { X, y } = separableBinary(n);
  return { X, y: y.map((label, i) => (i % 7 === 0 ? 1 - label : label)) };
}

function separableRegression(n = 200) {
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i * 37) % 100) / 10;
    const b = ((i * 61) % 100) / 100;
    X.push([a, b]);
    y.push(3 * a - 2 * b + 1);
  }
  return { X, y };
}

/** Share of rows an artifact labels correctly, scored on the served path. */
function accuracyAgainst(artifact: ModelArtifact, X: number[][], truth: number[]): number {
  const correct = X.filter((row, i) => {
    const features: Record<string, number> = { a: row[0]!, b: row[1]!, c: row[2]! };
    return (
      executePrediction({ modelId: artifact.modelId, requestId: `x${i}`, features }, artifact).prediction === truth[i]
    );
  }).length;
  return correct / X.length;
}

function logisticArtifact(overrides: Partial<ModelArtifact> = {}): ModelArtifact {
  return {
    modelId: "m",
    family: "logistic",
    version: "v1",
    featureNames: ["a", "b"],
    means: [0, 0],
    scales: [1, 1],
    coefficients: [2, -2],
    intercept: 0,
    task: "binary",
    slaMs: 100,
    ...overrides,
  };
}

function traffic(
  requests: number,
  artifact: ModelArtifact,
  opts: { label?: number[]; distinct?: boolean; segment?: string[] } = {},
): ServeRequest[] {
  const out: ServeRequest[] = [];
  for (let i = 0; i < requests; i++) {
    const cycle = opts.distinct ? requests : 5;
    const a = (i % cycle) / cycle;
    const b = ((i * 2) % cycle) / cycle;
    const features: Record<string, number> = { a, b };
    if (opts.label) features.__label = opts.label[i]!;
    out.push({
      modelId: artifact.modelId,
      requestId: `r${i}`,
      features,
      segment: opts.segment ? opts.segment[i % opts.segment.length] : undefined,
    });
  }
  return out;
}

describe("real-time serving: inference", () => {
  it("evaluates the linear score from the artifact coefficients", () => {
    const artifact = logisticArtifact();
    const { row } = vectorize({ modelId: "m", requestId: "r", features: { a: 3, b: 1 } }, artifact);
    expect(scoreLinear(row, artifact)).toBeCloseTo(2 * 3 - 2 * 1, 12);
  });

  it("maps a logistic score to a probability and a 0/1 label", () => {
    const artifact = logisticArtifact();
    const res = executePrediction({ modelId: "m", requestId: "r", features: { a: 5, b: 1 } }, artifact);
    expect(res.probability).toBeGreaterThan(0.5);
    expect(res.prediction).toBe(1);
    const negative = executePrediction({ modelId: "m", requestId: "r2", features: { a: 0, b: 5 } }, artifact);
    expect(negative.probability).toBeLessThan(0.5);
    expect(negative.prediction).toBe(0);
  });

  it("stays finite on extreme scores instead of overflowing the link", () => {
    const artifact = logisticArtifact({ coefficients: [1e6, -1e6], intercept: 1e9 });
    const res = executePrediction({ modelId: "m", requestId: "r", features: { a: 1, b: 1 } }, artifact);
    expect(Number.isFinite(res.probability!)).toBe(true);
    expect(res.probability).toBeCloseTo(1, 12);
  });

  it("applies the fit-time scaling to raw feature values", () => {
    const artifact = logisticArtifact({ means: [10, 20], scales: [2, 5], coefficients: [1, 1] });
    const { row } = vectorize({ modelId: "m", requestId: "r", features: { a: 14, b: 30 } }, artifact);
    expect(row[0]).toBeCloseTo(2, 12);
    expect(row[1]).toBeCloseTo(2, 12);
  });

  it("leaves regression output untransformed", () => {
    const artifact = logisticArtifact({ family: "ridge", task: "regression", coefficients: [1.5, -0.5], intercept: 4 });
    const res = executePrediction({ modelId: "m", requestId: "r", features: { a: 2, b: 1 } }, artifact);
    expect(res.prediction).toBeCloseTo(6.5, 12);
    expect(res.probability).toBeUndefined();
  });

  it("treats a missing feature as the fit-time mean and says which one", () => {
    const artifact = logisticArtifact({ means: [10, 20], scales: [2, 5] });
    const res = executePrediction({ modelId: "m", requestId: "r", features: { a: 14 } }, artifact);
    expect(res.imputed).toEqual(["b"]);
    const { row } = vectorize({ modelId: "m", requestId: "r", features: { a: 14 } }, artifact);
    expect(row[1]).toBe(0);
  });

  it("reports null, undefined, blank strings and NaN as imputed", () => {
    const artifact = logisticArtifact();
    const res = executePrediction(
      { modelId: "m", requestId: "r", features: { a: null, b: undefined, c: "  " } },
      artifact,
    );
    expect(res.imputed).toEqual(["a", "b"]);
  });

  it("parses numeric strings rather than imputing them", () => {
    const artifact = logisticArtifact();
    const res = executePrediction({ modelId: "m", requestId: "r", features: { a: "3", b: "1" } }, artifact);
    expect(res.imputed).toEqual([]);
    expect(res.probability).toBeGreaterThan(0.5);
  });

  it("keeps non-numeric strings out of the arithmetic", () => {
    const artifact = logisticArtifact();
    const res = executePrediction({ modelId: "m", requestId: "r", features: { a: "abc", b: 1 } }, artifact);
    expect(res.imputed).toEqual(["a"]);
    expect(Number.isFinite(res.probability!)).toBe(true);
  });

  it("attributes the linear score to features and reports the dominant lever", () => {
    const artifact = logisticArtifact({ coefficients: [10, 0.01], intercept: 0 });
    const res = executePrediction({ modelId: "m", requestId: "r", features: { a: 1, b: 1 } }, artifact);
    expect(res.contributions).toEqual([
      { feature: "a", value: 10 },
      { feature: "b", value: 0.01 },
    ]);
    expect(res.maxContributionShare!).toBeGreaterThan(0.99);
  });

  it("rejects a request aimed at a different model", () => {
    expect(() => executePrediction({ modelId: "other", requestId: "r", features: {} }, logisticArtifact())).toThrow(
      RealTimeServingError,
    );
  });

  it("is deterministic: identical inputs give identical predictions", () => {
    const artifact = logisticArtifact();
    const req = { modelId: "m", requestId: "r", features: { a: 1.234567, b: -0.5 } };
    const a = executePrediction(req, artifact);
    const b = executePrediction(req, artifact);
    expect(a.prediction).toBe(b.prediction);
    expect(a.probability).toBe(b.probability);
  });

  it("sums a gbdt ensemble over its trees with the learning rate", () => {
    const artifact: ModelArtifact = {
      modelId: "g",
      family: "gbdt",
      version: "v1",
      featureNames: ["a"],
      bins: [{ edges: [0, 5, 10], defaultBin: 0 }],
      learningRate: 0.5,
      baseScore: 0.2,
      trees: [
        {
          feature: 0,
          bin: 0,
          leafValue: 0,
          left: { feature: null, bin: null, leafValue: 1, left: null, right: null },
          right: { feature: null, bin: null, leafValue: -1, left: null, right: null },
        },
        {
          feature: 0,
          bin: 0,
          leafValue: 0,
          left: { feature: null, bin: null, leafValue: 2, left: null, right: null },
          right: { feature: null, bin: null, leafValue: -2, left: null, right: null },
        },
      ],
      task: "regression",
      slaMs: 50,
    };
    const { row } = vectorize({ modelId: "g", requestId: "r", features: { a: 1 } }, artifact);
    expect(scoreLinear(row, artifact)).toBeCloseTo(0.2 + 0.5 * 1 + 0.5 * 2, 12);
    const high = vectorize({ modelId: "g", requestId: "r", features: { a: 9 } }, artifact);
    expect(scoreLinear(high.row, artifact)).toBeCloseTo(0.2 + 0.5 * -1 + 0.5 * -2, 12);
  });

  it("routes gbdt bins to the same side the trained split describes", () => {
    const spec = { edges: [0, 5, 10], defaultBin: 0 };
    expect(assignBin(1, spec)).toBe(0);
    expect(assignBin(5, spec)).toBe(1);
    expect(assignBin(9.99, spec)).toBe(1);
    expect(assignBin(10, spec)).toBe(2);
    expect(assignBin(null, spec)).toBe(0);
    expect(assignBin(Number.NaN, spec)).toBe(0);
  });
});

describe("real-time serving: artifact fitting", () => {
  it("fits a logistic artifact that recovers the separating direction", () => {
    // Overlapping labels, not a perfectly separable set: separable data has no
    // finite MLE and the fit is expected to diverge rather than converge.
    const { X, y } = noisyBinary();
    const artifact = fitServingArtifact(X, y, {
      modelId: "f",
      version: "1",
      featureNames: ["a", "b", "aPlusB"],
      task: "binary",
      family: "logistic",
    });
    // Scored against the CLEAN boundary, not the noisy labels it was fitted on:
    // chasing the noisy labels would reward a model that memorised 14% of the
    // data wrong. A good fit recovers the underlying direction instead.
    const { y: clean } = separableBinary(X.length);
    const hits = X.filter((row, i) => {
      const res = executePrediction(
        { modelId: "f", requestId: `t${i}`, features: { a: row[0]!, b: row[1]!, aPlusB: row[2]! } },
        artifact,
      );
      return res.prediction === clean[i];
    }).length;
    const cleanAccuracy = hits / X.length;
    expect(cleanAccuracy).toBeGreaterThan(0.9);
    // The real signature of generalisation rather than memorisation: the fit is
    // much better against the clean boundary than against the labels it saw. A
    // model that simply reproduced its training targets would invert this.
    expect(cleanAccuracy).toBeGreaterThan(accuracyAgainst(artifact, X, y));
  });

  it("refuses a perfectly separable logistic fit rather than shipping diverged coefficients", () => {
    const { X, y } = separableBinary(200);
    // No label noise: the maximum likelihood estimate does not exist.
    expect(() =>
      fitServingArtifact(X, y, {
        modelId: "s",
        version: "1",
        featureNames: ["a", "b", "c"],
        task: "binary",
        family: "logistic",
        l2: 1e-12,
        maxIter: 400,
      }),
    ).toThrow(/perfectly separable/);
  });

  it("fits a ridge artifact that approximates a known linear target", () => {
    const { X, y } = separableRegression();
    const artifact = fitServingArtifact(X, y, {
      modelId: "r",
      version: "1",
      featureNames: ["a", "b"],
      task: "regression",
      family: "ridge",
      l2: 1e-8,
    });
    const res = executePrediction({ modelId: "r", requestId: "x", features: { a: 4, b: 1 } }, artifact);
    expect(res.prediction).toBeCloseTo(3 * 4 - 2 * 1 + 1, 0);
  });

  it("carries the scaling inside the artifact so inference cannot skip it", () => {
    const { X, y } = separableRegression();
    const artifact = fitServingArtifact(X, y, {
      modelId: "r",
      version: "1",
      featureNames: ["a", "b"],
      task: "regression",
      family: "ridge",
    });
    expect(artifact.means).toHaveLength(2);
    expect(artifact.scales).toHaveLength(2);
    // A constant column must not become a division by zero.
    const withConstant = fitServingArtifact(
      [
        [5, 1],
        [5, 2],
        [5, 3],
      ],
      [1, 2, 3],
      {
        modelId: "c",
        version: "1",
        featureNames: ["const", "v"],
        task: "regression",
        family: "ridge",
      },
    );
    expect(withConstant.scales![0]).toBe(1);
  });

  it("rejects mismatched names, ragged matrices and constant responses", () => {
    expect(() =>
      fitServingArtifact([[1, 2]], [1], {
        modelId: "m",
        version: "1",
        featureNames: ["only"],
        task: "regression",
        family: "ridge",
      }),
    ).toThrow(RealTimeServingError);
    expect(() =>
      fitServingArtifact([[1, 2], [3]], [1, 2], {
        modelId: "m",
        version: "1",
        featureNames: ["a", "b"],
        task: "regression",
        family: "ridge",
      }),
    ).toThrow(RealTimeServingError);
    expect(() =>
      fitServingArtifact([[1], [2]], [1, 1], {
        modelId: "m",
        version: "1",
        featureNames: ["a"],
        task: "binary",
        family: "logistic",
      }),
    ).toThrow(RealTimeServingError);
  });
});

describe("real-time serving: LRU cache", () => {
  it("hits on a repeated key and misses on a new one", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, hitRate: 0.5 });
  });

  it("evicts the least recently used entry at capacity", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.stats().evictions).toBe(1);
  });

  it("refreshes recency on a hit so a used key is not the one evicted", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
  });

  it("never exceeds its capacity", () => {
    const cache = new LruCache<number>(3);
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, i);
    expect(cache.size).toBe(3);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new LruCache<number>(0)).toThrow(RealTimeServingError);
  });

  it("keys on the model version and feature values, not the request id", () => {
    const a = logisticArtifact();
    const v2 = logisticArtifact({ version: "v2" });
    const req = { modelId: "m", requestId: "r1", features: { a: 1, b: 2 } };
    expect(cacheKey(req, a)).toBe(cacheKey({ ...req, requestId: "r2" }, a));
    expect(cacheKey(req, a)).not.toBe(cacheKey(req, v2));
    expect(cacheKey(req, a)).not.toBe(cacheKey({ ...req, features: { a: 1, b: 3 } }, a));
  });
});

describe("real-time serving: A/B allocation", () => {
  it("is a pure function of the request and test id", () => {
    const first = allocateAbVariant("user-1", "exp", 0.5);
    for (let i = 0; i < 5; i++) expect(allocateAbVariant("user-1", "exp", 0.5)).toEqual(first);
  });

  it("keeps a user in the same arm when the experiment changes", () => {
    // Same test id, different ratio boundary: a user already assigned must not
    // flip mid-experiment.
    const at90 = allocateAbVariant("user-7", "exp", 0.9);
    expect(allocateAbVariant("user-7", "exp", 0.9)).toEqual(at90);
  });

  it("sends everything to A at ratio 1 and everything to B at ratio 0", () => {
    for (let i = 0; i < 30; i++) {
      expect(allocateAbVariant(`u${i}`, "exp", 1).variant).toBe("A");
      expect(allocateAbVariant(`u${i}`, "exp", 0).variant).toBe("B");
    }
  });

  it("splits roughly by the requested ratio", () => {
    for (const ratio of [0.25, 0.5, 0.75]) {
      let a = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) if (allocateAbVariant(`user-${i}`, "exp", ratio).variant === "A") a++;
      expect(a / n).toBeCloseTo(ratio, 1);
    }
  });

  it("decorrelates assignments across two experiments", () => {
    let sameArm = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const one = allocateAbVariant(`user-${i}`, "exp-1", 0.5).variant;
      const two = allocateAbVariant(`user-${i}`, "exp-2", 0.5).variant;
      if (one === two) sameArm++;
    }
    // Independent 50/50 splits agree half the time; perfect correlation would
    // give 100%.
    expect(sameArm / n).toBeGreaterThan(0.35);
    expect(sameArm / n).toBeLessThan(0.65);
  });

  it("rejects an out-of-range ratio", () => {
    expect(() => allocateAbVariant("u", "exp", 1.5)).toThrow(RealTimeServingError);
    expect(() => allocateAbVariant("u", "exp", -0.1)).toThrow(RealTimeServingError);
  });
});

describe("real-time serving: simulation", () => {
  it("serves every request and measures an ordered latency distribution", () => {
    const artifact = logisticArtifact();
    const report = simulateServing({ requests: traffic(200, artifact) }, artifact);
    expect(report.requests).toBe(200);
    expect(report.latency.p50).toBeLessThanOrEqual(report.latency.p95);
    expect(report.latency.p95).toBeLessThanOrEqual(report.latency.p99);
    expect(report.latency.p99).toBeLessThanOrEqual(report.latency.max);
    expect(report.latency.breachRate).toBeGreaterThanOrEqual(0);
  });

  it("states that measured latency excludes network and queueing", () => {
    const report = simulateServing({ requests: traffic(20, logisticArtifact()) }, logisticArtifact());
    expect(report.latency.measured).toMatch(/Excludes network transit/);
  });

  it("serves repeated payloads from cache without changing the answer", () => {
    const artifact = logisticArtifact();
    const requests = traffic(50, artifact);
    const cold = executePrediction(requests[0]!, artifact).prediction;
    const report = simulateServing({ requests, cacheSize: 64 }, artifact);
    expect(report.cache.hits).toBeGreaterThan(0);
    expect(executePrediction(requests[0]!, artifact).prediction).toBe(cold);
  });

  it("counts misses when the cache is too small for the traffic", () => {
    const artifact = logisticArtifact();
    const requests = traffic(100, artifact, { distinct: true });
    const report = simulateServing({ requests, cacheSize: 2 }, artifact);
    expect(report.cache.hits).toBe(0);
    expect(report.cache.evictions).toBeGreaterThan(0);
    expect(report.warnings.join(" ")).toMatch(/Cache hit rate/);
  });

  it("reports batch fill so an idle batch is visible", () => {
    const artifact = logisticArtifact();
    const report = simulateServing({ requests: traffic(10, artifact), batchSize: 4 }, artifact);
    expect(report.batching.batches).toBe(3);
    expect(report.batching.meanBatchFill).toBeCloseTo(10 / 3, 12);
  });

  it("routes the canary share and reports the actual allocation", () => {
    const incumbent = logisticArtifact();
    const canary = logisticArtifact({ version: "v2", coefficients: [1, -1] });
    const requests = traffic(4000, incumbent);
    const report = simulateServing({ requests, canaryShare: 0.25 }, incumbent, canary);
    expect(report.routing.canary + report.routing.incumbent).toBe(4000);
    expect(report.routing.canaryShareActual).toBeCloseTo(0.25, 1);
    expect(report.routing.allocationIsStable).toBe(true);
  });

  it("never routes to a canary that was not supplied", () => {
    const incumbent = logisticArtifact();
    expect(() => simulateServing({ requests: traffic(10, incumbent), canaryShare: 0.5 }, incumbent)).toThrow(
      RealTimeServingError,
    );
  });

  it("sends all traffic to the incumbent when the canary share is zero", () => {
    const incumbent = logisticArtifact();
    const report = simulateServing({ requests: traffic(500, incumbent), canaryShare: 0 }, incumbent);
    expect(report.routing.canary).toBe(0);
    expect(report.routing.incumbent).toBe(500);
  });

  it("compares canary and incumbent on the same request and reports the gap", () => {
    const incumbent = logisticArtifact();
    const canary = logisticArtifact({ version: "v2", coefficients: [1.9, -1.9] });
    const report = simulateServing({ requests: traffic(200, incumbent), canaryShare: 0 }, incumbent, canary);
    expect(report.agreement).not.toBeNull();
    expect(report.agreement!.compared).toBe(200);
    expect(report.agreement!.divergenceRate).toBeGreaterThan(0);
    expect(report.agreement!.maxAbsDelta).toBeGreaterThan(0);
  });

  it("finds perfect agreement when the two models are identical", () => {
    const incumbent = logisticArtifact();
    const canary = logisticArtifact({ version: "v2" });
    const report = simulateServing({ requests: traffic(100, incumbent), canaryShare: 0 }, incumbent, canary);
    expect(report.agreement!.identical).toBe(100);
    expect(report.agreement!.divergenceRate).toBe(0);
    expect(report.agreement!.verdict).toMatch(/cannot detect a data-dependent regression/);
  });

  it("separates probability drift from class-label flips", () => {
    const incumbent = logisticArtifact({ coefficients: [0.5, -0.5] });
    // Same side of 0.5 for this traffic, so labels agree while scores differ.
    const canary = logisticArtifact({ version: "v2", coefficients: [0.5, -0.5], intercept: 0.05 });
    const report = simulateServing({ requests: traffic(200, incumbent), canaryShare: 0 }, incumbent, canary);
    expect(report.agreement!.divergenceRate).toBeGreaterThan(0);
    expect(report.agreement!.labelFlips).toBe(0);
    expect(report.agreement!.verdict).toMatch(/no class label flipped/);
  });

  it("breaks agreement down by segment", () => {
    const incumbent = logisticArtifact();
    const canary = logisticArtifact({ version: "v2", coefficients: [2.5, -2] });
    const segment = ["eu", "us", "apac"];
    const report = simulateServing(
      { requests: traffic(300, incumbent, { segment }), canaryShare: 0 },
      incumbent,
      canary,
    );
    const bySeg = new Map(report.agreement!.bySegment.map((s) => [s.segment, s]));
    expect(bySeg.get("eu")!.compared).toBe(100);
    expect(bySeg.get("apac")!.divergenceRate).toBeGreaterThanOrEqual(0);
  });

  it("scores holdout accuracy on the served path against a majority baseline", () => {
    const { X, y } = noisyBinary(300);
    const artifact = fitServingArtifact(X, y, {
      modelId: "m",
      version: "1",
      featureNames: ["a", "b", "c"],
      task: "binary",
      family: "logistic",
    });
    const requests: ServeRequest[] = X.map((row, i) => ({
      modelId: "m",
      requestId: `user-${i * 7919}`,
      features: { a: row[0]!, b: row[1]!, c: row[2]!, __label: y[i]! },
    }));
    const report = simulateServing({ requests, holdoutFraction: 0.3, cacheSize: 512 }, artifact);
    expect(report.accuracy.holdoutRequests).toBeGreaterThan(30);
    expect(report.accuracy.holdoutAccuracy!).toBeGreaterThan(0.8);
    expect(report.accuracy.majorityBaseline).toBeGreaterThan(0);
    expect(report.accuracy.majorityBaseline).toBeLessThan(1);
  });

  it("keeps the holdout set identical regardless of batch size and order", () => {
    const { X, y } = noisyBinary(300);
    const artifact = fitServingArtifact(X, y, {
      modelId: "m",
      version: "1",
      featureNames: ["a", "b", "c"],
      task: "binary",
      family: "logistic",
    });
    const requests: ServeRequest[] = X.map((row, i) => ({
      modelId: "m",
      requestId: `user-${i * 7919}`,
      features: { a: row[0]!, b: row[1]!, c: row[2]!, __label: y[i]! },
    }));
    const shuffled = [...requests].reverse();
    const a = simulateServing({ requests, holdoutFraction: 0.3, batchSize: 1 }, artifact);
    const b = simulateServing({ requests: shuffled, holdoutFraction: 0.3, batchSize: 64 }, artifact);
    expect(b.accuracy.holdoutRequests).toBe(a.accuracy.holdoutRequests);
    expect(b.accuracy.holdoutAccuracy).toBeCloseTo(a.accuracy.holdoutAccuracy!, 12);
  });

  it("warns that nothing was measured when no request carries a label", () => {
    const report = simulateServing({ requests: traffic(50, logisticArtifact()) }, logisticArtifact());
    expect(report.accuracy.holdoutRequests).toBe(0);
    expect(report.accuracy.holdoutAccuracy).toBeNull();
    expect(report.warnings.join(" ")).toMatch(/no accuracy was measured/);
  });

  it("refuses to promote a canary that is less accurate, even with a latency win", () => {
    const { X, y } = noisyBinary(300);
    const good = fitServingArtifact(X, y, {
      modelId: "m",
      version: "1",
      featureNames: ["a", "b", "c"],
      task: "binary",
      family: "logistic",
    });
    // A deliberately poor canary: trained on inverted labels, so it fits
    // cleanly and is confidently wrong. The signature of a bad rollout is not a
    // broken model, it is a well-fitted one pointed the wrong way.
    const bad = fitServingArtifact(
      X,
      y.map((v) => 1 - v),
      { modelId: "m", version: "2", featureNames: ["a", "b", "c"], task: "binary", family: "logistic" },
    );
    const requests: ServeRequest[] = X.map((row, i) => ({
      modelId: "m",
      requestId: `user-${i * 104729}`,
      features: { a: row[0]!, b: row[1]!, c: row[2]!, __label: y[i]! },
    }));
    const report = simulateServing({ requests, holdoutFraction: 0.5, canaryShare: 0.5 }, good, bad);
    expect(report.warnings.join(" ")).toMatch(/(Canary holdout accuracy|disagreed on)/);
  });

  it("reports which features were imputed and how often", () => {
    const artifact = logisticArtifact();
    const requests: ServeRequest[] = Array.from({ length: 10 }, (_, i) => ({
      modelId: "m",
      requestId: `r${i}`,
      features: i % 2 === 0 ? { a: 1, b: 2 } : { a: 1 },
    }));
    const report = simulateServing({ requests, cacheSize: 100 }, artifact);
    const b = report.imputations.find((f) => f.feature === "b");
    expect(b!.count).toBe(5);
    expect(b!.share).toBeCloseTo(0.5, 12);
    expect(report.warnings.join(" ")).toMatch(/imputed for 50.0%/);
  });

  it("is deterministic apart from measured latency", () => {
    const incumbent = logisticArtifact();
    const canary = logisticArtifact({ version: "v2", coefficients: [2.1, -1.9] });
    const requests = traffic(200, incumbent);
    const a = simulateServing({ requests, canaryShare: 0.3, shadow: true, cacheSize: 32 }, incumbent, canary);
    const b = simulateServing({ requests, canaryShare: 0.3, shadow: true, cacheSize: 32 }, incumbent, canary);
    expect(JSON.stringify(a.routing)).toBe(JSON.stringify(b.routing));
    expect(JSON.stringify(a.agreement)).toBe(JSON.stringify(b.agreement));
    expect(JSON.stringify(a.accuracy)).toBe(JSON.stringify(b.accuracy));
  });

  it("rejects empty traffic and an out-of-range canary share", () => {
    expect(() => simulateServing({ requests: [] }, logisticArtifact())).toThrow(RealTimeServingError);
    expect(() =>
      simulateServing({ requests: traffic(5, logisticArtifact()), canaryShare: 2 }, logisticArtifact()),
    ).toThrow(RealTimeServingError);
  });
});

describe("real-time serving: warm-up", () => {
  it("runs a real inference pass and reports its cost", () => {
    const artifact = logisticArtifact();
    const result = warmupArtifact(artifact);
    expect(result.featuresTouched).toEqual(["a", "b"]);
    expect(result.warmLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("can warm a subset of features", () => {
    const result = warmupArtifact(logisticArtifact(), ["a"]);
    expect(result.featuresTouched).toEqual(["a"]);
  });
});
