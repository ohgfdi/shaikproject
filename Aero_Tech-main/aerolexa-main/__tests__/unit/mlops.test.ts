/**
 * Oracle tests for the MLOps engine (lib/engine/mlops.ts): gate semantics,
 * champion/challenger comparison, PSI/KS drift on synthetic distributions.
 */
import {
  compareModels,
  detectDrift,
  evaluateGate,
  isLowerBetter,
  PSI_THRESHOLDS,
  type RegistryModel,
} from "@/lib/engine/mlops";

function model(over: Partial<RegistryModel> & { id: string }): RegistryModel {
  return {
    name: "churn",
    version: 1,
    task: "binary-classification",
    algorithm: "logistic",
    status: "READY",
    targetColumn: "churned",
    featureNames: ["spend"],
    metrics: { rocAuc: 0.8, prAuc: 0.6 },
    artifactJson: null,
    createdById: "u1",
    createdAt: "2026-01-01T00:00:00Z",
    promotedAt: null,
    promotedBy: null,
    note: null,
    ...over,
  };
}

describe("evaluateGate", () => {
  it("promotes the first model when there is no champion", () => {
    const challenger = model({ id: "c1", metrics: { rocAuc: 0.7 } });
    const r = evaluateGate(null, challenger, { minImprovement: 0 });
    expect(r.verdict).toBe("promote");
    expect(r.championValue).toBeNull();
  });

  it("promotes when the challenger improves by at least minImprovement", () => {
    const champion = model({ id: "ch", version: 1, metrics: { rocAuc: 0.8, prAuc: 0.6 } });
    const challenger = model({ id: "ca", version: 2, metrics: { rocAuc: 0.83, prAuc: 0.6 } });
    const r = evaluateGate(champion, challenger, { minImprovement: 0.02 });
    expect(r.verdict).toBe("promote");
    expect(r.delta).toBeCloseTo(0.03, 10);
    expect(r.better).toBe(true);
  });

  it("holds when the improvement is below the threshold", () => {
    const champion = model({ id: "ch", metrics: { rocAuc: 0.8 } });
    const challenger = model({ id: "ca", metrics: { rocAuc: 0.805 } });
    const r = evaluateGate(champion, challenger, { minImprovement: 0.02 });
    expect(r.verdict).toBe("hold");
  });

  it("rejects when the challenger regresses beyond maxRegression", () => {
    const champion = model({ id: "ch", metrics: { rocAuc: 0.85 } });
    const challenger = model({ id: "ca", metrics: { rocAuc: 0.7 } });
    const r = evaluateGate(champion, challenger, { minImprovement: 0, maxRegression: 0.05 });
    expect(r.verdict).toBe("reject");
  });

  it("respects lower-is-better metrics (rmse)", () => {
    expect(isLowerBetter("rmse")).toBe(true);
    expect(isLowerBetter("rocAuc")).toBe(false);
    const champion = model({ id: "ch", task: "regression", metrics: { rmse: 5.0, mae: 3.0 } });
    const challenger = model({ id: "ca", task: "regression", metrics: { rmse: 4.5, mae: 3.0 } });
    const r = evaluateGate(champion, challenger, { minImprovement: 0.25 });
    expect(r.verdict).toBe("promote");
    expect(r.delta).toBeCloseTo(0.5, 10);
  });

  it("guardrail degradation holds even when the primary improves", () => {
    // prAuc drops 0.60 → 0.585: outside the 0.02 tolerance (0.015 > 0.02 is
    // false — wait: 0.015 < 0.02, so use 0.585 → 0.015? No: drop = 0.015 which
    // PASSES. Use drop = 0.03 (0.60 → 0.57): outside 0.02 tolerance but below
    // the 2× hard-fail line of 0.04.
    const champion = model({ id: "ch", metrics: { rocAuc: 0.8, prAuc: 0.6 } });
    const challenger = model({ id: "ca", metrics: { rocAuc: 0.85, prAuc: 0.57 } });
    const r = evaluateGate(champion, challenger, {
      minImprovement: 0.01,
      guardrails: [{ metric: "prAuc", tolerance: 0.02 }],
    });
    expect(r.verdict).toBe("hold");
    expect(r.guardrailResults[0]!.passed).toBe(false);
    expect(r.guardrailResults[0]!.degradedBy).toBeCloseTo(0.03, 10);
    expect(r.reasons.some((s) => s.includes("prAuc"))).toBe(true);
  });

  it("a guardrail failing beyond 2× tolerance rejects outright", () => {
    const champion = model({ id: "ch", metrics: { rocAuc: 0.8, prAuc: 0.6 } });
    const challenger = model({ id: "ca", metrics: { rocAuc: 0.85, prAuc: 0.4 } });
    const r = evaluateGate(champion, challenger, {
      minImprovement: 0.01,
      guardrails: [{ metric: "prAuc", tolerance: 0.02 }],
    });
    expect(r.verdict).toBe("reject");
  });

  it("throws on missing or mismatched models", () => {
    const champion = model({ id: "ch", task: "regression", metrics: { rmse: 5 } });
    const challenger = model({ id: "ca", metrics: { rocAuc: 0.8 } });
    expect(() => evaluateGate(champion, challenger, { minImprovement: 0 })).toThrow(/same task/);
    expect(() => evaluateGate(model({ id: "ch" }), model({ id: "ca", metrics: {} }), { minImprovement: 0 })).toThrow(
      /no finite/,
    );
  });
});

describe("compareModels", () => {
  it("lists every shared metric with sign-normalized deltas", () => {
    const champion = model({ id: "ch", metrics: { rocAuc: 0.8, prAuc: 0.6 } });
    const challenger = model({ id: "ca", metrics: { rocAuc: 0.82, prAuc: 0.55 } });
    const r = compareModels(champion, challenger, { minImprovement: 0.01 });
    expect(r.metrics.find((m) => m.name === "rocAuc")!.better).toBe(true);
    expect(r.metrics.find((m) => m.name === "prAuc")!.better).toBe(false);
    expect(r.verdict).toBe(r.gate.verdict);
  });
});

describe("detectDrift", () => {
  it("reports no drift when current samples come from the same distribution", () => {
    // Deterministic reference/current: same repeating pattern.
    const ref = Array.from({ length: 200 }, (_, i) => (i % 10) as number);
    const cur = Array.from({ length: 200 }, (_, i) => (i % 10) as number);
    const r = detectDrift({ score: ref }, { score: cur }, { score: "numeric" });
    expect(r.overall).toBe("ok");
    expect(r.columns[0]!.psi).toBeCloseTo(0, 6);
    expect(r.columns[0]!.ksStatistic).toBeCloseTo(0, 6);
  });

  it("flags major drift when the current window shifts hard", () => {
    const ref = Array.from({ length: 400 }, (_, i) => (i % 100) as number); // uniform 0..99
    const cur = Array.from({ length: 400 }, (_, i) => 100 + (i % 100)); // uniform 100..199 — no overlap
    const r = detectDrift({ score: ref }, { score: cur }, { score: "numeric" });
    expect(r.overall).toBe("major");
    expect(r.columns[0]!.psi).toBeGreaterThanOrEqual(PSI_THRESHOLDS.major);
    expect(r.columns[0]!.ksStatistic).toBe(1);
  });

  it("categorical drift: a new dominant level moves PSI", () => {
    const ref = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? "A" : "B"));
    const cur = Array.from({ length: 200 }, (_, i) => (i % 10 === 0 ? "A" : "B"));
    const r = detectDrift({ plan: ref }, { plan: cur }, { plan: "categorical" });
    expect(r.columns[0]!.severity).toBe("major");
    expect(r.columns[0]!.psi).toBeGreaterThan(0.25);
  });

  it("skips columns without enough data and explains the verdict", () => {
    const ref = Array.from({ length: 200 }, (_, i) => (i % 10) as number);
    const short = [1, 2, 3];
    const r = detectDrift(
      { score: ref, other: short },
      { score: ref, other: short },
      { score: "numeric", other: "numeric" },
    );
    expect(r.columns.map((c) => c.column)).toEqual(["score"]);
    expect(r.interpretation).toContain("PSI");
  });

  it("requires both windows to have ≥ 20 rows", () => {
    expect(() => detectDrift({ s: [1, 2] }, { s: [1, 2, 3] }, { s: "numeric" })).toThrow(/20 rows/);
  });
});
