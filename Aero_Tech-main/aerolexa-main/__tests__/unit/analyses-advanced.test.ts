/**
 * Advanced analysis kinds — wiring contract + statistical correctness.
 *
 * These four kinds exist because the engines behind them were already
 * oracle-tested in isolation but unreachable from the UI. This suite pins two
 * distinct things:
 *
 *  1. WIRING — every kind resolves through runAnalysis, returns a result with
 *     charts and stats, and rejects malformed input with an AnalysisInputError
 *     rather than a raw engine exception or a silently wrong answer.
 *  2. CORRECTNESS — where a hand-computed fixture is possible, the surfaced
 *     numbers are pinned against it. Hand-computation is used wherever the math
 *     is exact arithmetic (rates, differences, group means, t-statistics).
 *
 * The distinction matters: an unwired engine is invisible, but a WRONGLY wired
 * one is worse than absent — it produces confident numbers a CA firm would put
 * in front of a client. So the negative tests below are as load-bearing as the
 * positive ones.
 */

import { AnalysisInputError, runAnalysis } from "@/lib/engine/analyses";
import type { Cell } from "@/lib/engine/dataset";
import type { AnalysisConfig, ColumnDef } from "@/lib/types";

function input(columns: ColumnDef[], rows: Cell[][], name = "advanced fixture") {
  return { datasetId: "ds-advanced", datasetName: name, totalRows: rows.length, columns, rows };
}

/** Assert a kind runs and returns a well-formed, non-empty result. */
function expectWellFormed(result: {
  kind: string;
  charts: unknown[];
  stats?: unknown[];
  quickFindings?: string[];
}): void {
  expect(result.charts.length).toBeGreaterThan(0);
  expect(result.stats?.length ?? 0).toBeGreaterThan(0);
  expect(result.quickFindings?.length ?? 0).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Group comparison (regression) — hand-computed Welch / Mann–Whitney
// ---------------------------------------------------------------------------

describe("regression: group comparison", () => {
  // Two hand-built groups with a KNOWN mean difference of exactly +10.
  // Values are symmetric around each group's mean (8..12 and 18..22), so the
  // means are exactly 10 and 20 and the difference is exactly +10. They must
  // NOT be constant: a t-test is undefined when both groups have zero variance.
  const columns: ColumnDef[] = [
    { name: "arm", type: "string" },
    { name: "value", type: "number" },
  ];
  const controlVals = [8, 9, 10, 11, 12, 8, 9, 10, 11, 12];
  const treatmentVals = [18, 19, 20, 21, 22, 18, 19, 20, 21, 22];
  const rows: Cell[][] = [
    ...controlVals.map((v) => ["control", v] as Cell[]),
    ...treatmentVals.map((v) => ["treatment", v] as Cell[]),
  ];

  it("computes the exact mean difference for Welch's t-test", () => {
    const res = runAnalysis(input(columns, rows), {
      kind: "regression",
      groupCol: "arm",
      valueCol: "value",
      test: "welch",
      adjust: false,
      alpha: 0.05,
    } as AnalysisConfig);
    expectWellFormed(res);
    // The Difference stat is exactly +10 — no floating-point tolerance needed
    // because both groups are constant.
    const diff = res.stats?.find((s) => s.label === "Difference");
    expect(diff?.value).toBe("+10.000");
    expect(res.stats?.find((s) => s.label === "Significant")?.value).toBe("Yes");
  });

  it("reports NOT significant for two identical groups — guards a false positive", () => {
    // Realistic near-identical samples: the same 10 values in both arms. Note
    // these are NOT constant — a t-test is undefined when both groups have
    // zero variance, which is asserted separately below.
    const vals = [48, 52, 50, 47, 53, 49, 51, 50, 46, 54];
    const same: Cell[][] = [
      ...vals.map((v) => ["control", v] as Cell[]),
      ...vals.map((v) => ["treatment", v] as Cell[]),
    ];
    const res = runAnalysis(input(columns, same), {
      kind: "regression",
      groupCol: "arm",
      valueCol: "value",
      test: "welch",
      adjust: false,
      alpha: 0.05,
    } as AnalysisConfig);
    expect(res.stats?.find((s) => s.label === "Significant")?.value).toBe("No");
    // An identical pair must produce a difference of exactly 0, not float noise.
    expect(res.stats?.find((s) => s.label === "Difference")?.value).toBe("+0.000");
    const d = res.stats?.find((s) => s.label === "Cohen's d")?.value ?? "";
    expect(d).not.toContain("NaN");
    expect(d).not.toContain("Infinity");
  });

  it("rejects two constant groups — a t-test is undefined with zero variance", () => {
    const flat: Cell[][] = [
      ...Array.from({ length: 10 }, () => ["control", 5] as Cell[]),
      ...Array.from({ length: 10 }, () => ["treatment", 5] as Cell[]),
    ];
    expect(() =>
      runAnalysis(input(columns, flat), {
        kind: "regression",
        groupCol: "arm",
        valueCol: "value",
        test: "welch",
        adjust: false,
        alpha: 0.05,
      } as AnalysisConfig),
    ).toThrow(/zero variance/);
  });

  it("uses the rank test when asked, and still produces a p-value", () => {
    const res = runAnalysis(input(columns, rows), {
      kind: "regression",
      groupCol: "arm",
      valueCol: "value",
      test: "mann-whitney",
      adjust: false,
      alpha: 0.05,
    } as AnalysisConfig);
    expectWellFormed(res);
    expect(res.stats?.find((s) => s.label === "Significant")?.value).toBe("Yes");
  });

  it("rejects a group column with three distinct values — a two-sided test is not defined", () => {
    const three: Cell[][] = [
      ...Array.from({ length: 6 }, () => ["a", 1] as Cell[]),
      ...Array.from({ length: 6 }, () => ["b", 2] as Cell[]),
      ...Array.from({ length: 6 }, () => ["c", 3] as Cell[]),
    ];
    expect(() =>
      runAnalysis(input(columns, three), {
        kind: "regression",
        groupCol: "arm",
        valueCol: "value",
        test: "welch",
        adjust: false,
        alpha: 0.05,
      } as AnalysisConfig),
    ).toThrow(AnalysisInputError);
  });

  it("rejects groups too small to test", () => {
    const tiny: Cell[][] = [
      ["control", 1],
      ["treatment", 2],
    ];
    expect(() =>
      runAnalysis(input(columns, tiny), {
        kind: "regression",
        groupCol: "arm",
        valueCol: "value",
        test: "welch",
        adjust: false,
        alpha: 0.05,
      } as AnalysisConfig),
    ).toThrow(/at least 3 numeric values/);
  });
});

// ---------------------------------------------------------------------------
// A/B test — hand-computed rates
// ---------------------------------------------------------------------------

describe("abtest: two-proportion test", () => {
  // One row per arm. Conversions and trials are exact integers, so the
  // conversion rates are hand-checkable: 100/1000 = 10%, 150/1000 = 15%.
  const columns: ColumnDef[] = [
    { name: "arm", type: "string" },
    { name: "conversions", type: "number" },
    { name: "trials", type: "number" },
  ];
  const rows: Cell[][] = [
    ["control", 100, 1000],
    ["treatment", 150, 1000],
  ];
  const cfg: AnalysisConfig = {
    kind: "abtest",
    successesCol: "conversions",
    trialsCol: "trials",
    armCol: "arm",
    valueCol: null,
    alpha: 0.05,
    power: 0.8,
  } as AnalysisConfig;

  it("sums per-arm counts and computes the relative lift", () => {
    const res = runAnalysis(input(columns, rows), cfg);
    expectWellFormed(res);
    // (0.15 - 0.10) / 0.10 = +50% relative lift.
    const lift = res.stats?.find((s) => s.label === "Relative lift")?.value;
    expect(lift).toBe("+50.00%");
  });

  it("aggregates multi-row arms before testing", () => {
    // Same totals, split across two rows per arm — must be identical output.
    const split: Cell[][] = [
      ["control", 60, 600],
      ["control", 40, 400],
      ["treatment", 90, 600],
      ["treatment", 60, 400],
    ];
    const res = runAnalysis(input(columns, split), cfg);
    expect(res.stats?.find((s) => s.label === "Relative lift")?.value).toBe("+50.00%");
  });

  it("rejects conversions exceeding trials — an impossible rate", () => {
    const bad: Cell[][] = [
      ["control", 1200, 1000],
      ["treatment", 150, 1000],
    ];
    expect(() => runAnalysis(input(columns, bad), cfg)).toThrow(/cannot exceed trials/);
  });

  it("rejects a non-numeric conversions column instead of coercing it to NaN", () => {
    const bad: Cell[][] = [
      ["control", "n/a", 1000],
      ["treatment", 150, 1000],
    ];
    expect(() => runAnalysis(input(columns, bad), cfg)).toThrow(AnalysisInputError);
  });
});

// ---------------------------------------------------------------------------
// AutoML — leaderboard contract
// ---------------------------------------------------------------------------

describe("automl: model search", () => {
  // 40 rows of a clean linear signal plus noise — a leaderboard must appear and
  // some candidate must be scored on every row of the table.
  const n = 40;
  const rows: Cell[][] = Array.from({ length: n }, (_, i) => [i, 2 * i + 1, i % 2 === 0 ? "a" : "b"]);
  const columns: ColumnDef[] = [
    { name: "x", type: "number" },
    { name: "y", type: "number" },
    { name: "label", type: "string" },
  ];

  it("returns a leaderboard with the winner ranked first", () => {
    const res = runAnalysis(input(columns, rows), {
      kind: "automl",
      targetColumn: "y",
      featureColumns: ["x", "label"],
      task: "regression",
      cvFolds: 3,
      maxCandidates: 6,
    } as AnalysisConfig);
    expectWellFormed(res);
    const board = res.tables?.find((t) => t.title.startsWith("Leaderboard"));
    expect(board).toBeDefined();
    expect(board?.rows.length ?? 0).toBeGreaterThan(1);
    // Deterministic ordering: ascending score (lower is better for rmse).
    const scores = (board?.rows ?? []).map((r) => Number(r[2]));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i] ?? 0).toBeGreaterThanOrEqual(scores[i - 1] ?? 0);
    }
    expect(res.stats?.find((s) => s.label === "Winning model")?.value).toBeTruthy();
  });

  it("is deterministic — identical input yields an identical leaderboard", () => {
    const cfg: AnalysisConfig = {
      kind: "automl",
      targetColumn: "y",
      featureColumns: ["x", "label"],
      task: "regression",
      cvFolds: 3,
      maxCandidates: 6,
    } as AnalysisConfig;
    const a = runAnalysis(input(columns, rows), cfg);
    const b = runAnalysis(input(columns, rows), cfg);
    expect(JSON.stringify(a.tables)).toBe(JSON.stringify(b.tables));
  });

  it("rejects too few rows rather than training on a meaningless sample", () => {
    expect(() =>
      runAnalysis(input(columns, rows.slice(0, 6)), {
        kind: "automl",
        targetColumn: "y",
        featureColumns: ["x"],
        task: "regression",
        cvFolds: 3,
        maxCandidates: 6,
      } as AnalysisConfig),
    ).toThrow(/at least 12 complete rows/);
  });

  it("rejects a target with no feature columns", () => {
    expect(() =>
      runAnalysis(input(columns, rows), {
        kind: "automl",
        targetColumn: "y",
        featureColumns: [],
        task: "regression",
        cvFolds: 3,
        maxCandidates: 6,
      } as AnalysisConfig),
    ).toThrow(/at least one feature column/);
  });
});

// ---------------------------------------------------------------------------
// ARIMAX — dynamic regression
// ---------------------------------------------------------------------------

describe("arimax: forecast with drivers", () => {
  // 24 consecutive months of y = 10 + 2*driver + small noise, so the fitted
  // coefficient on the driver should be close to 2 and R² close to 1.
  // Dates must span 24 DISTINCT months — wrapping within one year would collapse
  // 24 rows into 12 period buckets and destroy the signal.
  const monthIso = (i: number) => {
    const year = 2023 + Math.floor(i / 12);
    const month = String((i % 12) + 1).padStart(2, "0");
    return `${year}-${month}-01`;
  };
  const rows: Cell[][] = Array.from({ length: 24 }, (_, i) => {
    const driver = i;
    // Deterministic pseudo-noise, aperiodic on purpose: a repeating pattern
    // would be strongly autocorrelated, so the AR(1) error model would absorb
    // it as signal and depress the honest in-sample R². That is a real
    // modelling effect, not something this fixture should be testing.
    const noise = ((i * 7919) % 11) / 11 - 0.5;
    const y = 10 + 2 * driver + noise;
    return [monthIso(i), y, driver] as Cell[];
  });
  const columns: ColumnDef[] = [
    { name: "month", type: "date" },
    { name: "sales", type: "number" },
    { name: "spend", type: "number" },
  ];
  const cfg: AnalysisConfig = {
    kind: "arimax",
    dateCol: "month",
    metric: "sales",
    granularity: "month",
    horizon: 3,
    regressors: ["spend"],
    level: 0.95,
  } as AnalysisConfig;

  it("recovers a known linear driver relationship", () => {
    const res = runAnalysis(input(columns, rows), cfg);
    expectWellFormed(res);
    const r2 = Number(res.stats?.find((s) => s.label === "R²")?.value ?? "0");
    expect(r2).toBeGreaterThan(0.9);

    const coefTable = res.tables?.find((t) => t.title.startsWith("Driver coefficients"));
    const spendRow = coefTable?.rows.find((r) => r[0] === "spend");
    // Coefficient ~2 with a little noise. Wide band keeps this from being brittle.
    expect(Number(spendRow?.[1])).toBeGreaterThan(1.5);
    expect(Number(spendRow?.[1])).toBeLessThan(2.5);
  });

  it("publishes the driver path it assumed — the forecast is only as good as this", () => {
    const res = runAnalysis(input(columns, rows), cfg);
    const proj = res.tables?.find((t) => t.title.startsWith("Projected driver paths"));
    expect(proj?.rows.length).toBe(3);
  });

  it("rejects too few periods to fit a dynamic regression", () => {
    expect(() => runAnalysis(input(columns, rows.slice(0, 5)), cfg)).toThrow(/at least 10/);
  });

  it("rejects a run with no exogenous regressor", () => {
    expect(() =>
      runAnalysis(input(columns, rows), {
        ...cfg,
        regressors: [],
      } as AnalysisConfig),
    ).toThrow(/at least one exogenous driver/);
  });
});
