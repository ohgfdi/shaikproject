import type { MetricValue } from "@/lib/analytics/semantic-layer";
import { executeTool, isKnownTool, TOOL_SPECS, type AgentContext } from "@/lib/copilot/tools";
import type { Cell } from "@/lib/engine/dataset";
import type { ColumnDef } from "@/lib/types";

/**
 * The tools are the copilot's entire surface area for touching real data, so
 * these tests run them against a real (tiny) dataset and assert the honesty
 * guarantees: real numbers only, honest failures, and no silent fabrication.
 */

const COLUMNS: ColumnDef[] = [
  { name: "date", type: "date" },
  { name: "region", type: "string" },
  { name: "revenue", type: "number" },
  { name: "cost", type: "number" },
];

const ROWS: Cell[][] = [
  ["2024-01-05", "North", 100, 40],
  ["2024-02-05", "South", 200, 80],
  ["2024-03-05", "North", 300, 120],
  ["2024-04-05", "South", 400, 160],
];

const METRICS: MetricValue[] = [
  {
    metricId: "revenue_total",
    metricName: "Total Revenue",
    value: 1000,
    formattedValue: "$1,000.00",
    confidence: 1,
    computedAt: new Date(),
    sampleSize: 4,
    totalRows: 4,
    resolvedColumns: { value: "revenue" },
    formula: "Σ revenue",
  },
  {
    metricId: "profit_margin",
    metricName: "Profit Margin",
    value: 60,
    formattedValue: "60.00%",
    confidence: 1,
    computedAt: new Date(),
    sampleSize: 4,
    totalRows: 4,
    resolvedColumns: { revenue: "revenue", cost: "cost" },
    formula: "(Σ revenue − Σ cost) / Σ revenue × 100",
  },
];

function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    datasetId: "ds-1",
    datasetName: "sales.csv",
    columns: COLUMNS,
    rows: ROWS,
    totalRows: 4,
    datasetWarnings: [],
    metricValues: METRICS,
    ...overrides,
  };
}

describe("copilot tools — registry", () => {
  it("exposes exactly the documented tools", () => {
    expect(TOOL_SPECS.map((t) => t.name).sort()).toEqual(
      // A3: propose_measure is part of the agent's vocabulary (verified by the
      // engine before any measure is offered to the user).
      // ROADMAP 6.2 added the two grounded "why / where" tools.
      // ROADMAP 6.3 added run_whatif + run_significance_test (engine-backed).
      [
        "compute_metrics",
        "finish",
        "get_schema",
        "propose_measure",
        "run_analysis",
        "run_whatif",
        "run_significance_test",
        "explain_key_influencers",
        "build_decomposition_tree",
      ].sort(),
    );
    expect(isKnownTool("run_analysis")).toBe(true);
    expect(isKnownTool("drop_table")).toBe(false);
  });

  it("refuses an unknown tool with the allowed list", () => {
    const exec = executeTool("exfiltrate", {}, ctx());
    expect(exec.ok).toBe(false);
    expect(exec.error).toMatch(/Unknown tool/);
  });
});

describe("copilot tools — get_schema", () => {
  it("reports the real columns and row counts", () => {
    const exec = executeTool("get_schema", {}, ctx());
    expect(exec.ok).toBe(true);
    const data = exec.data as { columns: { name: string }[]; analyzedRows: number; totalRows: number };
    expect(data.columns.map((c) => c.name)).toEqual(["date", "region", "revenue", "cost"]);
    expect(data.analyzedRows).toBe(4);
    expect(data.totalRows).toBe(4);
    // Row counts are citable facts; column names are not numbers.
    expect(exec.facts).toContain("4 of 4 rows analysed");
  });
});

describe("copilot tools — compute_metrics", () => {
  it("returns the governed metric values with formula and coverage as facts", () => {
    const exec = executeTool("compute_metrics", {}, ctx());
    expect(exec.ok).toBe(true);
    expect(exec.facts.some((f) => f.includes("$1,000.00"))).toBe(true);
    expect(exec.facts.some((f) => f.includes("100% coverage"))).toBe(true);
  });

  it("filters by requested id and by metric name", () => {
    const exec = executeTool("compute_metrics", { ids: ["profit_margin"] }, ctx());
    const data = exec.data as { metrics: MetricValue[] };
    expect(data.metrics.map((m) => m.metricId)).toEqual(["profit_margin"]);
  });

  it("fails honestly when a requested metric does not exist, listing what does", () => {
    const exec = executeTool("compute_metrics", { ids: ["nonsense_metric"] }, ctx());
    expect(exec.ok).toBe(false);
    expect(exec.error).toMatch(/revenue_total/);
  });

  it("reports no metrics without inventing any", () => {
    const exec = executeTool("compute_metrics", {}, ctx({ metricValues: [] }));
    expect(exec.ok).toBe(true);
    expect(exec.facts).toEqual([]);
    expect(exec.digest).toMatch(/No governed metric/);
  });
});

describe("copilot tools — run_analysis", () => {
  it("runs the real trend engine and returns computed numbers", () => {
    const exec = executeTool(
      "run_analysis",
      { kind: "trend", metric: "revenue", dateCol: "date", granularity: "month" },
      ctx(),
    );
    expect(exec.ok).toBe(true);
    const data = exec.data as { result: { kind: string; scope: { rowsUsed: number } } };
    expect(data.result.kind).toBe("trend");
    expect(data.result.scope.rowsUsed).toBe(4);
    expect(exec.facts.length).toBeGreaterThan(0);
  });

  it("returns the exact executable config so the UI can save it", () => {
    const exec = executeTool("run_analysis", { kind: "kpi", metric: "revenue", dateCol: "date" }, ctx());
    const data = exec.data as { config: { kind: string; metric: string } };
    expect(data.config.kind).toBe("kpi");
    expect(data.config.metric).toBe("revenue");
  });

  it("rejects an unknown analysis kind", () => {
    const exec = executeTool("run_analysis", { kind: "telepathy" }, ctx());
    expect(exec.ok).toBe(false);
    expect(exec.error).toMatch(/Unknown analysis kind/);
  });

  it("surfaces the engine's own error for a column that cannot support the analysis", () => {
    const exec = executeTool("run_analysis", { kind: "trend", metric: "region", dateCol: "date" }, ctx());
    expect(exec.ok).toBe(false);
    expect(exec.error).toMatch(/region/);
  });

  it("fails honestly when a required column is missing", () => {
    const exec = executeTool("run_analysis", { kind: "distribution", column: "does_not_exist" }, ctx());
    expect(exec.ok).toBe(false);
    expect(exec.error).toMatch(/does_not_exist/);
  });
});
