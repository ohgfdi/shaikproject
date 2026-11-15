/**
 * Unit tests for the prototype notebook DSL kernel (lib/engine/notebook-dsl.ts).
 */
import { executeNotebookCell, looksLikePython, type DslContext } from "@/lib/engine/notebook-dsl";

const ctx: DslContext = {
  datasetName: "sales.csv",
  columns: [
    { name: "date", type: "date" },
    { name: "region", type: "string" },
    { name: "revenue", type: "number" },
  ],
  rows: [
    ["2024-01-05", "East", 1200],
    ["2024-01-12", "East", 980],
    ["2024-02-02", "West", 1350],
    ["2024-02-09", "West", 760],
    ["2024-03-01", "East", 1500],
    ["2024-03-08", "East", 1100],
  ],
  totalRows: 6,
  rowLimit: 5000,
};

describe("looksLikePython", () => {
  it("detects python imports", () => {
    expect(looksLikePython("import pandas as pd")).toBe(true);
    expect(looksLikePython("from sklearn.linear_model import LinearRegression")).toBe(true);
    expect(looksLikePython("%rows 10")).toBe(false);
  });
});

describe("executeNotebookCell", () => {
  it("reports an error for empty cells", () => {
    const out = executeNotebookCell("   ", ctx);
    expect(out.type).toBe("error");
  });

  it("explains the demo fallback for python code", () => {
    const out = executeNotebookCell("import numpy as np", ctx);
    expect(out.type).toBe("note");
    if (out.type === "note") expect(out.title).toContain("Pyodide");
  });

  it("runs %help", () => {
    const out = executeNotebookCell("%help", ctx);
    expect(out.type).toBe("text");
    if (out.type === "text") expect(out.text).toContain("%rows");
  });

  it("runs %rows with a cap and default", () => {
    const out = executeNotebookCell("%rows 3", ctx);
    expect(out.type).toBe("table");
    if (out.type === "table") {
      expect(out.rows).toHaveLength(3);
      expect(out.columns.map((c) => c.label)).toEqual(["date", "region", "revenue"]);
    }
  });

  it("runs %columns with the schema", () => {
    const out = executeNotebookCell("%columns", ctx);
    expect(out.type).toBe("table");
    if (out.type === "table") expect(out.rows).toHaveLength(3);
  });

  it("runs %describe with numeric stats", () => {
    const out = executeNotebookCell("%describe revenue", ctx);
    expect(out.type).toBe("stats");
    if (out.type === "stats") {
      expect(out.stats.find((s) => s.label === "Mean")?.value).toBe("1,148.33"); // 6890/6
    }
  });

  it("runs %kpi with totals", () => {
    const out = executeNotebookCell("%kpi revenue", ctx);
    expect(out.type).toBe("stats");
    if (out.type === "stats") {
      expect(out.stats.find((s) => s.label === "Sum")?.value).toBe("6,890");
    }
  });

  it("runs %trend bucketed by month", () => {
    const out = executeNotebookCell("%trend revenue by date", ctx);
    expect(out.type).toBe("chart");
    if (out.type === "chart") {
      expect(out.chart.kind).toBe("line");
      expect(out.chart.series[0]!.data?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("returns a helpful error for an unknown % command", () => {
    const out = executeNotebookCell("%bogus", ctx);
    expect(out.type).toBe("error");
    if (out.type === "error") expect(out.message).toContain("%help");
  });

  it("returns a note for arbitrary non-python text", () => {
    const out = executeNotebookCell("SELECT 1", ctx);
    expect(out.type).toBe("note");
  });

  it("errors on an unknown column", () => {
    const out = executeNotebookCell("%describe nope", ctx);
    expect(out.type).toBe("error");
  });
});
