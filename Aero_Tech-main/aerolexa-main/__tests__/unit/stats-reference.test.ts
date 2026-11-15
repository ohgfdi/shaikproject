/**
 * SciPy / NumPy reference (oracle) validation.
 *
 * This is the file the README cites for the "Calculated" labelling claim:
 * the engine's statistics must match the scientific-Python implementations
 * on the SAME dirty data (missing values, mismatched missing patterns per
 * column, ties) before any analysis output may be presented as validated.
 *
 * Honesty rules enforced here:
 * - The oracles are real SciPy/NumPy computations run through the shared
 *   interpreter resolver (explicit override → project `.venv` → PATH
 *   `python3`, probed for numpy/scipy/pandas) — not re-implemented formulas,
 *   not hand-computed constants.
 * - When no qualifying interpreter exists, the suite SKIPS with the reason
 *   printed, exactly like python-export.test.ts. It never silently downgrades
 *   to weaker assertions.
 * - Where the engine rounds values for display (r to 3 decimals, p to 4),
 *   the comparison applies the same rounding — never a looser tolerance
 *   disguised as equality.
 */
import { execFileSync } from "node:child_process";

import { runAnalysis } from "@/lib/engine/analyses";
import type { Cell } from "@/lib/engine/dataset";
import { mean, normalCdf, pearson, quantile, spearman, stddev, studentTPValue, variance } from "@/lib/engine/stats";

import { resolveTestPythonOrAnnounce } from "../helpers/python";

// Shared resolver: an incidental `python3` with the scientific stack is just as
// valid an oracle as the project `.venv`, so both are accepted.
const oracle = resolveTestPythonOrAnnounce("stats-reference");
const d = oracle ? describe : describe.skip;

/** Run a python snippet, feed `input` as JSON on stdin, parse stdout as JSON. */
function py<T>(code: string, input: unknown): T {
  const stdout = execFileSync(oracle!.bin, ["-c", code], {
    input: JSON.stringify(input),
    timeout: 60000,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

// ---------------------------------------------------------------------------
// Shared deterministic dirty data (seeded LCG → identical on every run/machine)
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const rnd = lcg(20260915);
const N = 37;
const A: (number | null)[] = [];
const B: (number | null)[] = [];
for (let i = 0; i < N; i++) {
  const a = Math.round((rnd() * 100 - 20) * 100) / 100;
  const noise = (rnd() - 0.5) * 18;
  // B is correlated with A plus noise, and misses DIFFERENT rows than A —
  // this is what breaks naive "drop nulls per column then pair by position".
  A.push(i % 9 === 4 ? null : a);
  B.push(i % 7 === 3 ? null : Math.round((2 * a + 30 + noise) * 100) / 100);
}
// C: rank/tie data for Spearman (several tied values, monotone-ish vs A).
const C: (number | null)[] = A.map((v, i) =>
  i % 5 === 2 ? null : v === null ? Math.round(rnd() * 3) : Math.round((v ?? 0) / 40),
);

/** Pairwise-complete pairs (the engine's convention) for primitive calls. */
function pairwise(x: (number | null)[], y: (number | null)[]): { x: number[]; y: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] != null && y[i] != null) {
      xs.push(x[i] as number);
      ys.push(y[i] as number);
    }
  }
  return { x: xs, y: ys };
}

const cleanA = A.filter((v): v is number => v != null);

// ---------------------------------------------------------------------------
// 1) Primitives vs NumPy / SciPy
// ---------------------------------------------------------------------------

d("stats primitives vs NumPy/SciPy oracles", () => {
  it("quantiles match np.nanquantile exactly (R type-7 interpolation)", () => {
    const qs = [0, 0.13, 0.25, 0.5, 0.75, 0.87, 1];
    const ref = py<{ qs: number[] }>(
      `
import sys, json
import numpy as np
data = json.load(sys.stdin)
arr = np.array([float("nan") if v is None else v for v in data["a"]])
print(json.dumps({"qs": [float(np.nanquantile(arr, q)) for q in data["qs"]]}))
`,
      { a: A, qs },
    );
    qs.forEach((q, i) => {
      expect(quantile(cleanA, q)).toBeCloseTo(ref.qs[i] as number, 10);
    });
  });

  it("mean / sample variance / sample stddev match NumPy (ddof=1)", () => {
    const ref = py<{ mean: number; var: number; std: number }>(
      `
import sys, json
import numpy as np
data = json.load(sys.stdin)
arr = np.array([v for v in data["a"] if v is not None], dtype=float)
print(json.dumps({"mean": float(np.mean(arr)), "var": float(np.var(arr, ddof=1)), "std": float(np.std(arr, ddof=1))}))
`,
      { a: cleanA },
    );
    expect(mean(cleanA)).toBeCloseTo(ref.mean, 10);
    expect(variance(cleanA)).toBeCloseTo(ref.var, 9);
    expect(stddev(cleanA)).toBeCloseTo(ref.std, 9);
  });

  it("Pearson r and p match scipy.stats.pearsonr on pairwise-complete rows", () => {
    const pairs = pairwise(A, B);
    const engine = pearson(pairs.x, pairs.y);
    const ref = py<{ r: number; p: number }>(
      `
import sys, json
from scipy import stats
data = json.load(sys.stdin)
r, p = stats.pearsonr(data["x"], data["y"])
print(json.dumps({"r": float(r), "p": float(p)}))
`,
      pairs,
    );
    expect(engine.r).toBeCloseTo(ref.r, 9);
    expect(engine.p).toBeCloseTo(ref.p, 9);
    expect(engine.n).toBe(pairs.x.length);
  });

  it("Spearman rho and p match scipy.stats.spearmanr on tied data (average ranks)", () => {
    const pairs = pairwise(A, C);
    const engine = spearman(pairs.x, pairs.y);
    const ref = py<{ rho: number; p: number }>(
      `
import sys, json
from scipy import stats
data = json.load(sys.stdin)
res = stats.spearmanr(data["x"], data["y"])
print(json.dumps({"rho": float(res.statistic), "p": float(res.pvalue)}))
`,
      pairs,
    );
    expect(engine.rho).toBeCloseTo(ref.rho, 9);
    expect(engine.p).toBeCloseTo(ref.p, 9);
  });

  it("Student-t two-sided p-values match 2 * scipy.stats.t.sf across df", () => {
    const cases = [
      { t: 1.5, df: 10 },
      { t: 2.9, df: 3 },
      { t: 0.2, df: 1 },
      { t: 4.0, df: 120 },
      { t: -2.1, df: 27 },
    ];
    const ref = py<{ ps: number[] }>(
      `
import sys, json
from scipy import stats
data = json.load(sys.stdin)
print(json.dumps({"ps": [float(2 * stats.t.sf(abs(c["t"]), c["df"])) for c in data["cases"]]}))
`,
      { cases },
    );
    cases.forEach((c, i) => {
      expect(studentTPValue(c.t, c.df)).toBeCloseTo(ref.ps[i] as number, 9);
    });
  });

  it("normal CDF matches scipy.stats.norm.cdf within the documented 1.5e-7 bound", () => {
    const xs = [-2.7, -0.5, 0, 0.3, 1.9, 3.1];
    const ref = py<{ cdfs: number[] }>(
      `
import sys, json
from scipy import stats
data = json.load(sys.stdin)
print(json.dumps({"cdfs": [float(stats.norm.cdf(x)) for x in data["xs"]]}))
`,
      { xs },
    );
    xs.forEach((x, i) => {
      expect(normalCdf(x)).toBeCloseTo(ref.cdfs[i] as number, 6);
    });
  });
});

// ---------------------------------------------------------------------------
// 2) Analysis pipeline vs SciPy / pandas on the same data
// ---------------------------------------------------------------------------

const columns = [
  { name: "a", type: "number" as const },
  { name: "b", type: "number" as const },
  { name: "c", type: "number" as const },
];
const rows: Cell[][] = A.map((a, i) => [a, B[i] ?? null, C[i] ?? null]);
const input = {
  datasetId: "ds-oracle",
  datasetName: "Oracle reference data",
  totalRows: N,
  columns,
  rows: rows as Cell[][],
};

d("analysis pipeline vs SciPy/pandas oracles", () => {
  it("correlation output equals scipy pairwise r/rho/p and pandas pairwise counts", () => {
    const result = runAnalysis(input, { kind: "correlation", columns: ["a", "b", "c"] });
    const table = result.tables?.[0];
    expect(table).toBeDefined();
    const rowFor = (a: string, b: string) =>
      (table?.rows ?? []).find((r) => (r[0] === a && r[1] === b) || (r[0] === b && r[1] === a));

    const ref = py<Record<string, { r: number; rho: number; p: number; rhoP: number; n: number }>>(
      `
import sys, json
import pandas as pd
from scipy import stats
data = json.load(sys.stdin)
df = pd.DataFrame(data["rows"], columns=data["cols"])
out = {}
for a, b in [("a", "b"), ("a", "c"), ("b", "c")]:
    pair = df[[a, b]].dropna()
    pr, pp = stats.pearsonr(pair[a], pair[b])
    sr, sp = stats.spearmanr(pair[a], pair[b])
    out[f"{a}-{b}"] = {"r": float(pr), "p": float(pp), "rho": float(sr), "rhoP": float(sp), "n": int(len(pair))}
print(json.dumps(out))
`,
      { cols: ["a", "b", "c"], rows: rows.map((r) => r.map((v) => (typeof v === "number" ? v : null))) },
    );

    for (const [a, b] of [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ] as const) {
      const row = rowFor(a, b);
      const oracle = ref[`${a}-${b}`];
      expect(row).toBeDefined();
      expect(oracle).toBeDefined();
      // Engine displays r/rho rounded to 3 decimals and p to 4 — compare with
      // the same rounding applied to the oracle (never a looser tolerance).
      expect(row?.[2]).toBe(Math.round(oracle!.r * 1000) / 1000);
      expect(row?.[3]).toBe(Math.round(oracle!.rho * 1000) / 1000);
      expect(row?.[4]).toBe(Math.round(oracle!.p * 1e4) / 1e4);
      expect(row?.[5]).toBe(oracle!.n);
    }
  });

  it("distribution output equals NumPy box-plot summary and conserves histogram mass", () => {
    const result = runAnalysis(input, { kind: "distribution", column: "a", bins: 10 });

    const ref = py<{ box: number[]; count: number; missing: number }>(
      `
import sys, json
import numpy as np
data = json.load(sys.stdin)
arr = np.array([float("nan") if v is None else v for v in data["a"]])
print(json.dumps({
    "box": [float(np.nanmin(arr)), float(np.nanquantile(arr, 0.25)), float(np.nanmedian(arr)),
            float(np.nanquantile(arr, 0.75)), float(np.nanmax(arr))],
    "count": int(np.sum(~np.isnan(arr))), "missing": int(np.isnan(arr).sum()),
}))
`,
      { a: A },
    );

    // Box chart carries the five-number summary [min, q1, median, q3, max].
    const boxChart = result.charts?.find((c) => c.kind === "box");
    expect(boxChart).toBeDefined();
    const box = (boxChart?.series?.[0] as unknown as { box?: number[] }).box;
    expect(box).toHaveLength(5);
    box?.forEach((v, i) => expect(v).toBeCloseTo(ref.box[i] as number, 9));

    // Histogram conserves mass: bin counts must sum to the observed rows.
    const hist = result.charts?.find((c) => c.kind === "histogram");
    const counts = (hist?.series?.[0]?.data ?? []) as number[];
    expect(counts.reduce((s, v) => s + v, 0)).toBe(ref.count);

    // The methodology states the excluded-cell count — it must be truthful.
    const missingLine = result.methodology.steps.find((s) => s.includes("Missing or non-numeric cells"));
    expect(missingLine).toContain(`(${ref.missing})`);
  });

  it("trend output equals pandas monthly sums and NumPy OLS slope/R²", () => {
    // 90 deterministic daily observations across 3 calendar months.
    const days = 90;
    const v: (number | null)[] = [];
    const d2 = lcg(7);
    for (let i = 0; i < days; i++)
      v.push(i % 11 === 5 ? null : Math.round((500 + i * 3 + (d2() - 0.5) * 40) * 100) / 100);
    const dates: string[] = [];
    const start = Date.UTC(2024, 0, 1);
    for (let i = 0; i < days; i++) dates.push(new Date(start + i * 86400000).toISOString().slice(0, 10));

    const trendInput = {
      datasetId: "ds-oracle-trend",
      datasetName: "Oracle trend data",
      totalRows: days,
      columns: [
        { name: "d", type: "date" as const },
        { name: "v", type: "number" as const },
      ],
      rows: dates.map((date, i) => [date, v[i] ?? null] as Cell[]),
    };
    const result = runAnalysis(trendInput, { kind: "trend", dateCol: "d", metric: "v", granularity: "month" });
    const table = result.tables?.[0];
    expect(table).toBeDefined();

    const ref = py<{ sums: number[]; r2: number; counts: number[] }>(
      `
import sys, json
import numpy as np
import pandas as pd
data = json.load(sys.stdin)
df = pd.DataFrame({"d": pd.to_datetime(data["dates"]), "v": data["v"]}).dropna()
monthly = df.resample("MS", on="d")["v"].sum()
x = np.arange(len(monthly))
coef = np.polyfit(x, monthly.values, 1)
fitted = np.polyval(coef, x)
ss_res = float(np.sum((monthly.values - fitted) ** 2))
ss_tot = float(np.sum((monthly.values - monthly.values.mean()) ** 2))
print(json.dumps({
    "sums": [float(s) for s in monthly.values],
    "counts": [int(c) for c in df.resample("MS", on="d")["v"].count()],
    "r2": 1 - ss_res / ss_tot,
}))
`,
      { dates, v },
    );

    const engineValues = (table?.rows ?? []).map((r) => r[1] as number);
    const engineCounts = (table?.rows ?? []).map((r) => r[2] as number);
    expect(engineValues).toHaveLength(ref.sums.length);
    engineValues.forEach((val, i) => expect(val).toBe(Math.round((ref.sums[i] as number) * 100) / 100));
    engineCounts.forEach((cnt, i) => expect(cnt).toBe(ref.counts[i]));

    // OLS R² is surfaced inside the methodology text (rounded to 2dp).
    const r2Line = result.methodology.steps.find((s) => s.includes("R²"));
    expect(r2Line).toBeDefined();
    const parsed = Number((r2Line?.match(/R² = (-?[\d.]+)/) ?? [])[1]);
    expect(parsed).toBeCloseTo(ref.r2, 2);
  });
});
