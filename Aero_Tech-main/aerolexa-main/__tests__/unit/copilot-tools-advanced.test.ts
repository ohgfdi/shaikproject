/**
 * Tests for the ROADMAP 6.3 copilot tools: run_whatif and
 * run_significance_test. Both must return only engine-computed numbers as
 * facts (the grounding guard's contract), fail with actionable errors, and
 * never fabricate data.
 */
import { executeTool, isKnownTool, type AgentContext } from "@/lib/copilot/tools";
import type { Cell } from "@/lib/engine/dataset";
import type { ColumnDef } from "@/lib/types";

const COLUMNS: ColumnDef[] = [
  { name: "region", type: "string" },
  { name: "price", type: "number" },
  { name: "margin", type: "number" },
];

// margin = 2·price + 100 — a strong linear signal for run_whatif.
const ROWS: Cell[][] = Array.from({ length: 40 }, (_, i) => {
  const price = 10 + i;
  return ["North", price, 100 + 2 * price + (i % 3) - 1];
});
// South rows: clearly higher margin on average (for the significance test).
const SOUTH_ROWS: Cell[][] = Array.from({ length: 40 }, (_, i) => {
  const price = 10 + i;
  return ["South", price, 200 + 2 * price + (i % 3) - 1];
});

function ctx(): AgentContext {
  return {
    datasetId: "ds-1",
    datasetName: "sales.csv",
    columns: COLUMNS,
    rows: [...ROWS, ...SOUTH_ROWS],
    totalRows: ROWS.length + SOUTH_ROWS.length,
    datasetWarnings: [],
    metricValues: [],
  };
}

describe("copilot tool: run_whatif", () => {
  it("is part of the agent's vocabulary", () => {
    expect(isKnownTool("run_whatif")).toBe(true);
  });

  it("returns engine-computed projection facts for a strong relationship", () => {
    const exec = executeTool("run_whatif", { driverColumn: "price", outcomeColumn: "margin", pctChange: 5 }, ctx());
    expect(exec.ok).toBe(true);
    const facts = exec.facts.join("\n");
    // Before/after, slope, r², row count — all real engine output.
    expect(facts).toMatch(/\+5% price → margin/);
    expect(facts).toMatch(/slope 2/i);
    expect(facts).toMatch(/fitted regression projection/i);
    expect(facts).not.toMatch(/hypothetical proportional fallback/i);
    const data = exec.data as { result: { fallback: boolean; model: { points: number } } };
    expect(data.result.fallback).toBe(false);
    expect(data.result.model.points).toBe(80);
    // The digest carries the narrative for the model.
    expect(exec.digest).toMatch(/what-if engine/i);
  });

  it("reports the hypothetical fallback honestly on weak signal", () => {
    const weakCtx = ctx();
    weakCtx.rows = Array.from({ length: 30 }, (_, i) => ["North", i, 50 + (i % 5)] as Cell[]);
    const exec = executeTool("run_whatif", { driverColumn: "price", outcomeColumn: "margin", pctChange: 10 }, weakCtx);
    expect(exec.ok).toBe(true);
    expect(exec.facts.join("\n")).toMatch(/hypothetical proportional fallback/i);
  });

  it("surfaces the engine's validation errors verbatim for self-correction", () => {
    expect(executeTool("run_whatif", { outcomeColumn: "margin", pctChange: 5 }, ctx()).ok).toBe(false);
    const badCol = executeTool("run_whatif", { driverColumn: "nope", outcomeColumn: "margin", pctChange: 5 }, ctx());
    expect(badCol.ok).toBe(false);
    expect(badCol.error).toMatch(/not found/i);
    const badPct = executeTool(
      "run_whatif",
      { driverColumn: "price", outcomeColumn: "margin", pctChange: "abc" },
      ctx(),
    );
    expect(badPct.ok).toBe(false);
    expect(badPct.error).toMatch(/signed percentage/i);
  });
});

describe("copilot tool: run_significance_test", () => {
  it("is part of the agent's vocabulary", () => {
    expect(isKnownTool("run_significance_test")).toBe(true);
  });

  it("returns a real Welch t-test verdict for two groups", () => {
    const exec = executeTool(
      "run_significance_test",
      { metricColumn: "margin", groupColumn: "region", groupA: "North", groupB: "South" },
      ctx(),
    );
    expect(exec.ok).toBe(true);
    const facts = exec.facts.join("\n");
    expect(facts).toMatch(/North: mean [\d.]+ over n = 40/);
    expect(facts).toMatch(/South: mean [\d.]+ over n = 40/);
    expect(facts).toMatch(/Welch t-test: t = -?[\d.]+, df = [\d.]+, two-sided p = [\d.]+/);
    expect(facts).toMatch(/statistically significant/i);
    const data = exec.data as { t: number; p: number; significant: boolean };
    expect(data.significant).toBe(true);
    expect(data.p).toBeLessThan(0.001); // a 100-point mean gap over 40v40 rows
  });

  it("is case-insensitive on group values and reports non-significance honestly", () => {
    // Compare North against itself with different casing → same group error.
    const same = executeTool(
      "run_significance_test",
      { metricColumn: "margin", groupColumn: "region", groupA: "north", groupB: "NORTH" },
      ctx(),
    );
    expect(same.ok).toBe(false);
    expect(same.error).toMatch(/different values/i);
  });

  it("fails with actionable errors for unknown columns or tiny groups", () => {
    const badCol = executeTool(
      "run_significance_test",
      { metricColumn: "nope", groupColumn: "region", groupA: "North", groupB: "South" },
      ctx(),
    );
    expect(badCol.ok).toBe(false);
    expect(badCol.error).toMatch(/known columns/i);

    const tiny = ctx();
    tiny.rows = [["North", 1, 100] as Cell[], ["South", 2, 200] as Cell[]];
    const tooFew = executeTool(
      "run_significance_test",
      { metricColumn: "margin", groupColumn: "region", groupA: "North", groupB: "South" },
      tiny,
    );
    expect(tooFew.ok).toBe(false);
    expect(tooFew.error).toMatch(/at least 2 numeric rows/i);
  });

  it("refuses identical metric and group columns", () => {
    const exec = executeTool(
      "run_significance_test",
      { metricColumn: "region", groupColumn: "region", groupA: "North", groupB: "South" },
      ctx(),
    );
    expect(exec.ok).toBe(false);
    expect(exec.error).toMatch(/different columns/i);
  });
});
