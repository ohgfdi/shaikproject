/**
 * Copilot pipeline (WS3) — gate + deterministic translator tests.
 *
 * The gate and translator are the safety/honesty core of the copilot: they
 * decide what code ever reaches the kernel. These tests exercise them directly
 * (no LLM, no kernel needed) and assert the exact guarantees:
 *  - dangerous Python never passes;
 *  - the translator only ever references REAL schema columns;
 *  - every generated cell passes the gate (generator/gate agreement).
 */

import { assertSafePythonCode } from "@/lib/engine/python/code-gate";
import { translateToPandas } from "@/lib/engine/python/nl-to-pandas";
import type { ColumnDef } from "@/lib/types";

const cols: ColumnDef[] = [
  { name: "date", type: "date" },
  { name: "region", type: "string" },
  { name: "product", type: "string" },
  { name: "units", type: "number" },
  { name: "revenue", type: "number" },
];

describe("Python safety gate", () => {
  it("passes real data-science code", () => {
    expect(
      assertSafePythonCode(
        `import numpy as np\nfrom scipy import stats\ndf["z"] = (df["revenue"] - df["revenue"].mean()) / df["revenue"].std()\ndf["z"].round(3)`,
      ).ok,
    ).toBe(true);
  });

  it("rejects filesystem access", () => {
    const v = assertSafePythonCode(`open("/etc/passwd").read()`);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("opens a file");
  });

  it("rejects subprocess and network access", () => {
    expect(assertSafePythonCode(`import subprocess\nsubprocess.run("ls")`).ok).toBe(false);
    expect(assertSafePythonCode(`import requests\nrequests.get("http://x")`).ok).toBe(false);
    expect(assertSafePythonCode(`import socket\nsocket.socket()`).ok).toBe(false);
  });

  it("rejects os module and dunder escapes", () => {
    expect(assertSafePythonCode(`import os\nos.listdir("/")`).ok).toBe(false);
    expect(assertSafePythonCode(`__import__("os").system("rm -rf /")`).ok).toBe(false);
    expect(assertSafePythonCode(`eval("1+1")`).ok).toBe(false);
    expect(assertSafePythonCode(`exec("x=1")`).ok).toBe(false);
    expect(assertSafePythonCode(`getattr(df, "__globals__")`).ok).toBe(false);
  });

  it("rejects non-allowlisted imports", () => {
    const v = assertSafePythonCode(`import folium\nfolium.Map()`);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("allow-list");
  });

  it("does not fire on strings or comments that merely mention blocked words", () => {
    expect(assertSafePythonCode(`# we could use open() here but do not\ndf.head(3)`).ok).toBe(true);
    expect(assertSafePythonCode(`df["note"] = "no os.system here"`).ok).toBe(true);
  });

  it("reports the offending line number", () => {
    const v = assertSafePythonCode(`df.head()\nimport shutil`);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("Line 2");
  });
});

describe("deterministic NL→pandas translator", () => {
  it("writes a grouped sum using only real columns", () => {
    const t = translateToPandas("total revenue by region", cols);
    expect(t.matched).toBe(true);
    expect(t.code).toContain('groupby("region")');
    expect(t.code).toContain('"revenue"');
    // Gate agreement: the translator's output always passes the gate.
    expect(assertSafePythonCode(t.code).ok).toBe(true);
  });

  it("writes a trend over the real date column", () => {
    const t = translateToPandas("trend of revenue over time", cols);
    expect(t.matched).toBe(true);
    expect(t.code).toContain('"date"');
    expect(t.code).toContain("to_period");
    expect(assertSafePythonCode(t.code).ok).toBe(true);
  });

  it("writes a mean and a count with scipy-free code", () => {
    const mean = translateToPandas("average units", cols);
    expect(mean.code).toContain('"units"');
    expect(mean.code).toContain(".mean()");
    const count = translateToPandas("count of rows", cols);
    expect(count.matched).toBe(true);
    expect(assertSafePythonCode(count.code).ok).toBe(true);
  });

  it("computes correlation with a p-value via scipy when two numerics are named", () => {
    const t = translateToPandas("correlation between revenue and units", cols);
    expect(t.code).toContain("pearsonr");
    expect(t.code).toContain('"revenue"');
    expect(t.code).toContain('"units"');
    expect(assertSafePythonCode(t.code).ok).toBe(true);
  });

  it("writes a missing-values report", () => {
    const t = translateToPandas("missing values", cols);
    expect(t.code).toContain("isna");
    expect(assertSafePythonCode(t.code).ok).toBe(true);
  });

  it("never invents columns: unknown names fall back to real schema columns", () => {
    const t = translateToPandas("sum of dragon_coins by realm", cols);
    expect(t.matched).toBe(true);
    // "dragon_coins"/"realm" must NOT appear; real columns must.
    expect(t.code).not.toContain("dragon_coins");
    expect(t.code).not.toContain("realm");
  });

  it("fails honestly with guidance when nothing matches", () => {
    const t = translateToPandas("tell me a joke", []);
    expect(t.matched).toBe(false);
    expect(t.help).toBeTruthy();
  });

  it("escapes column names safely (injection-proof strings)", () => {
    const weird: ColumnDef[] = [{ name: 'weird"col', type: "number" }];
    const t = translateToPandas('sum of weird"col', weird);
    expect(t.code).toContain('"weird\\"col"');
    expect(assertSafePythonCode(t.code).ok).toBe(true);
  });
});
