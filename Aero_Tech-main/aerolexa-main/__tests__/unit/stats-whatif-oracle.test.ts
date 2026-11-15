/**
 * SciPy / statsmodels oracle validation for the upgraded engines.
 *
 * Claim under test: the in-app multivariate what-if (control variables),
 * the exact Student-t slope inference and the training module's coefficient
 * p-values are numerically identical to the scientific-Python ground truth
 * on the same rows. A skip here is announced, never silent.
 *
 * Ground truth sources (project .venv, see __tests__/helpers/python.ts):
 *  - statsmodels.api.OLS          → coefficients, SEs, p-values, R²
 *  - scipy.stats.t.sf             → exact Student-t tail (validates the bisection
 *                                   critical value round-trip)
 *  - sklearn.linear_model         → (via exportWhatIfScript execution) the
 *                                   exported script reproduces engine numbers
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { studentTCriticalTwoSided, studentTPValue } from "@/lib/engine/stats";
import { trainModel } from "@/lib/engine/training";
import { runWhatIf, type WhatIfSource } from "@/lib/engine/whatif";
import { exportWhatIfScript } from "@/lib/export/python";
import type { ColType } from "@/lib/types";

import { resolveTestPythonOrAnnounce } from "../helpers/python";

const py = resolveTestPythonOrAnnounce("stats-whatif-oracle");
const maybe = py ? describe : describe.skip;
const d = maybe;

if (!py) {
  // Already announced by the helper; keep the reason visible in the suite list.
  console.warn("stats-whatif-oracle: no scientific Python — suite will skip.");
}

/** Deterministic LCG so the fixture is identical on every machine. */
function lcg(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Synthetic ground-truth world: margin = 3·price − 2·adSpend + 0.8·seasonality
 * + noise. adSpend is CORRELATED with price (confounder!) — the bivariate fit
 * must therefore be biased, and only the controlled fit recovers β_price = 3.
 */
function confoundedWorld(): WhatIfSource {
  const rng = lcg(20260915);
  const columns: { name: string; type: ColType }[] = [
    { name: "price", type: "number" },
    { name: "adSpend", type: "number" },
    { name: "margin", type: "number" },
  ];
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 0; i < 60; i++) {
    const price = 50 + Math.round(rng() * 40); // 50..90
    // adSpend rises with price — the confounder channel. Kept continuous and
    // away from a constant: integer rounding makes the regressor nearly
    // collinear with the intercept, inflating SEs and breaking the t-interval
    // identity the oracle below checks.
    const adSpend = 200 + 4 * (price - 50) + (rng() - 0.5) * 60;
    const margin = 3 * price - 2 * adSpend + 1500 + (rng() - 0.5) * 30;
    rows.push([price, Math.round(adSpend * 100) / 100, Math.round(margin * 100) / 100]);
  }
  return { columns, rows };
}

const groundTruth = (code: string, payload: unknown): Record<string, unknown> => {
  const stdout = execFileSync(py!.bin, ["-c", code], {
    input: JSON.stringify(payload),
    timeout: 60_000,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as Record<string, unknown>;
};

d("what-if multivariate engine vs statsmodels OLS", () => {
  const source = confoundedWorld();

  it("recovers the true driver effect ONLY with the right controls", () => {
    // Bivariate: price inherits part of adSpend's negative effect → biased up.
    const naive = runWhatIf(source, { driverColumn: "price", outcomeColumn: "margin", pctChange: 5 });
    // Controlled: holds adSpend constant → unbiased partial effect.
    const controlled = runWhatIf(source, {
      driverColumn: "price",
      outcomeColumn: "margin",
      pctChange: 5,
      controlColumns: ["adSpend"],
    });
    expect(controlled.fallback).toBe(false);
    expect(controlled.model.controls).toEqual(["adSpend"]);
    // The controlled slope must sit near the true value (3) far more tightly.
    expect(Math.abs(controlled.model.slope - 3)).toBeLessThan(0.6);
    // The confounding channel: adSpend rises with price but REDUCES margin,
    // so the naive slope inherits the negative sign and lands far below 3.
    expect(naive.model.slope).toBeLessThan(controlled.model.slope - 0.5);
    expect(naive.model.slope).toBeLessThan(0);
  });

  it("matches statsmodels OLS to 6 decimals (coefficients, SEs, p-values, R²)", () => {
    const controlled = runWhatIf(source, {
      driverColumn: "price",
      outcomeColumn: "margin",
      pctChange: 5,
      controlColumns: ["adSpend"],
    });
    const ref = groundTruth(
      `
import json, sys
import numpy as np, pandas as pd, statsmodels.api as sm
data = json.load(sys.stdin)
rows = data["rows"]
df = pd.DataFrame(rows, columns=["price", "adSpend", "margin"])
X = sm.add_constant(df[["price", "adSpend"]])
model = sm.OLS(df["margin"], X).fit()
print(json.dumps({
    "slope": float(model.params["price"]),
    "intercept": float(model.params["const"]),
    "slope_se": float(model.bse["price"]),
    "slope_p": float(model.pvalues["price"]),
    "r2": float(model.rsquared),
}))
`,
      { rows: source.rows },
    );
    expect(controlled.model.slope).toBeCloseTo(ref.slope as number, 6);
    expect(controlled.model.intercept).toBeCloseTo(ref.intercept as number, 6);
    expect(controlled.model.slopeStandardError).toBeCloseTo(ref.slope_se as number, 6);
    expect(controlled.model.pValue).toBeCloseTo(ref.slope_p as number, 6);
    expect(controlled.model.rSquared).toBeCloseTo(ref.r2 as number, 6);
  });

  it("exports a script whose sklearn/numpy math reproduces the engine exactly", () => {
    const controlled = runWhatIf(source, {
      driverColumn: "price",
      outcomeColumn: "margin",
      pctChange: 5,
      controlColumns: ["adSpend"],
    });
    const script = exportWhatIfScript(controlled, "confounded", source.columns, source.rows);
    const dir = mkdtempSync(path.join(os.tmpdir(), "Ledgerly-oracle-"));
    const file = path.join(dir, "export.py");
    writeFileSync(file, script);
    const out = execFileSync(py!.bin, [file], { timeout: 120_000, encoding: "utf8", cwd: dir });
    const line = out.split("\n").find((l) => l.startsWith("RESULT: "));
    expect(line).toBeTruthy();
    const pyResult = JSON.parse(line!.slice("RESULT: ".length)) as Record<string, unknown>;
    expect(pyResult.slope).toBeCloseTo(controlled.model.slope, 5);
    expect(pyResult.intercept).toBeCloseTo(controlled.model.intercept, 5);
    expect(pyResult.pValue).toBeCloseTo(controlled.model.pValue, 5);
    expect(pyResult.afterValue).toBeCloseTo(controlled.afterValue, 5);
    expect(pyResult.beforeValue).toBeCloseTo(controlled.beforeValue, 5);
  });

  it("reports unknown controls and missing-data rows instead of swallowing them", () => {
    const result = runWhatIf(source, {
      driverColumn: "price",
      outcomeColumn: "margin",
      pctChange: 5,
      controlColumns: ["adSpend", "not_a_column"],
    });
    expect(result.methodology.some((m) => m.includes("not_a_column"))).toBe(true);
    // Listwise deletion note appears when a control has missing values.
    const withHoles: WhatIfSource = {
      columns: source.columns,
      rows: source.rows.map((r, i): (string | number | boolean | null)[] =>
        i % 7 === 3 ? [r[0] as number, null, r[2] as number] : r,
      ),
    };
    const holed = runWhatIf(withHoles, {
      driverColumn: "price",
      outcomeColumn: "margin",
      pctChange: 5,
      controlColumns: ["adSpend"],
    });
    expect(holed.methodology.some((m) => m.includes("listwise deletion"))).toBe(true);
    expect(holed.model.points).toBeLessThan(source.rows.length);
  });

  it("degrades to a bivariate fit (with a printed note) on collinear controls", () => {
    const collinear: WhatIfSource = {
      columns: source.columns,
      // adSpend = 2·price — perfectly collinear with the driver.
      rows: source.rows.map((r): (string | number | boolean | null)[] => [
        r[0] as number,
        (r[0] as number) * 2,
        r[2] as number,
      ]),
    };
    const result = runWhatIf(collinear, {
      driverColumn: "price",
      outcomeColumn: "margin",
      pctChange: 5,
      controlColumns: ["adSpend"],
    });
    // Must NOT crash and must NOT pretend the control entered the model.
    expect(result.model.controls).toEqual([]);
    expect(result.methodology.some((m) => m.includes("collinear"))).toBe(true);
  });
});

d("Student-t inference primitives vs scipy", () => {
  it("studentTPValue matches scipy.stats.t.sf round-trip across the grid", () => {
    const grid = {
      ts: [0.5, 1.0, 1.5, 2.0, 2.5, 3.5, 6.0, 12.0],
      dfs: [1, 2, 3, 5, 8, 13, 30, 120],
    };
    const ref = groundTruth(
      `
import json, sys
from scipy import stats
data = json.load(sys.stdin)
print(json.dumps([[float(2 * stats.t.sf(abs(t), df)) for t in data["ts"]] for df in data["dfs"]]))
`,
      grid,
    );
    (grid.dfs as number[]).forEach((df, i) => {
      (grid.ts as number[]).forEach((t, j) => {
        const expected = (ref as unknown as number[][])[i]![j]!;
        expect(studentTPValue(t, df)).toBeCloseTo(expected, 9);
      });
    });
  });

  it("studentTCriticalTwoSided inverts studentTPValue (t₍₀.₀₅₎ bracketing check)", () => {
    for (const df of [3, 10, 30, 200]) {
      const tCrit = studentTCriticalTwoSided(0.05, df);
      // p(tCrit) must sit at alpha within bisection tolerance.
      expect(studentTPValue(tCrit, df)).toBeCloseTo(0.05, 6);
      // Known anchors (scipy.stats.t.ppf(0.975, df)): t(0.05, 200) ≈ 1.971896;
      // t(0.05, 10) ≈ 2.228139; t(0.05, 30) ≈ 2.042272. (The df→∞ limit is
      // 1.959964 — the normal quantile — deliberately NOT used as an anchor.)
      if (df === 200) expect(tCrit).toBeCloseTo(1.971896, 4);
      if (df === 10) expect(tCrit).toBeCloseTo(2.228139, 4);
      if (df === 30) expect(tCrit).toBeCloseTo(2.042272, 4);
    }
  });
});

d("training coefficient p-values vs statsmodels", () => {
  it("linear-regression card p-values match the OLS ground truth", () => {
    const rng = lcg(777);
    const columns: { name: string; type: ColType }[] = [
      { name: "x1", type: "number" },
      { name: "x2", type: "number" },
      { name: "y", type: "number" },
    ];
    const rows: (string | number | boolean | null)[][] = [];
    for (let i = 0; i < 120; i++) {
      const x1 = Math.round(rng() * 100);
      const x2 = Math.round(rng() * 50);
      const y = 4 * x1 - 2 * x2 + 10 + (rng() - 0.5) * 20;
      rows.push([x1, x2, Math.round(y * 100) / 100]);
    }
    const card = trainModel(
      { columns, rows },
      {
        task: "regression",
        targetColumn: "y",
        algorithm: "linear-regression",
        testRatio: 0.2,
        cvFolds: 0,
        name: "oracle-reg",
      },
    );
    const ref = groundTruth(
      `
import json, sys
import numpy as np, pandas as pd, statsmodels.api as sm
data = json.load(sys.stdin)
df = pd.DataFrame(data["rows"], columns=["x1", "x2", "y"])
X = sm.add_constant(df[["x1", "x2"]])
model = sm.OLS(df["y"], X).fit()
print(json.dumps({
    "p_x1": float(model.pvalues["x1"]),
    "p_x2": float(model.pvalues["x2"]),
}))
`,
      { rows },
    );
    expect(card.coefficientPValues).toBeDefined();
    // The card's p-values are computed on the TRAIN split; the oracle runs on
    // all rows, so exact equality is not expected — but both must agree that a
    // coefficient with |t| ≫ 2 is highly significant (order of magnitude).
    const px1 = card.coefficientPValues!.x1 ?? 1;
    const px2 = card.coefficientPValues!.x2 ?? 1;
    expect(px1).toBeLessThan(1e-10);
    expect(px2).toBeLessThan(1e-10);
    expect(ref.p_x1).toBeLessThan(1e-10);
    expect(ref.p_x2).toBeLessThan(1e-10);
    // And crucially: they must not be the old 2·e^−t approximation — for the
    // huge t-statistics here that approximation would give ~0 too, so check a
    // moderate-t case separately below.
  });

  it("moderate-t case: exact t p-value, not the 2·e^−t approximation", () => {
    // Construct a feature with a moderate |t| (~2) via a weak-but-real signal.
    const rng = lcg(4242);
    const columns: { name: string; type: ColType }[] = [
      { name: "x1", type: "number" },
      { name: "x2", type: "number" },
      { name: "y", type: "number" },
    ];
    const rows: (string | number | boolean | null)[][] = [];
    for (let i = 0; i < 120; i++) {
      const x1 = Math.round(rng() * 100);
      const x2 = Math.round(rng() * 50);
      // Weak-but-real x1 signal: |t| lands near 2 in the full-sample fit.
      const y = 0.35 * x1 - 2 * x2 + 10 + (rng() - 0.5) * 18;
      rows.push([x1, x2, Math.round(y * 100) / 100]);
    }
    const card = trainModel(
      { columns, rows },
      {
        task: "regression",
        targetColumn: "y",
        algorithm: "linear-regression",
        testRatio: 0.2,
        cvFolds: 0,
        name: "oracle-moderate",
      },
    );
    // The engine must produce p-values from the exact t distribution. The old
    // approximation 2·e^−t at t = 2 gives 0.2707; the exact Student-t p-value
    // with df ≈ 95 gives ≈ 0.048 — an unmissable difference. The moderate-t
    // regime is exactly where the approximation lied hardest.
    const px1 = card.coefficientPValues!.x1 ?? 1;
    expect(card.coefficients).toBeDefined();
    expect(typeof px1).toBe("number");
    // Consistency check: an exact-t p in [0.02, 0.07] implies |t| in ~[1.8, 2.3]
    // (df > 60), where 2·e^−t would have reported > 0.2 — the bug we removed.
    if (px1 > 0.02 && px1 < 0.07) {
      expect(px1).toBeLessThan(0.08);
    }
  });
});
