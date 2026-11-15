/**
 * Notebook SQL→Python handoff — the pure bridge (ROADMAP 4.1).
 * Known-answer tests: name sanitization, sql-result → DataFrame extra,
 * last-write-wins collection and the row cap.
 */

import {
  HANDOFF_ROW_CAP,
  collectExtras,
  describeExtras,
  handoffName,
  isTabularOutput,
  reactiveRerunPlan,
  sqlOutputToExtra,
} from "@/lib/engine/notebook-handoff";
import type { NotebookCell, NotebookCellOutput } from "@/lib/types";

function sqlResult(
  rows: (string | number | boolean | null)[][],
  columns = [
    { name: "region", type: "string" as const },
    { name: "amount", type: "number" as const },
  ],
): NotebookCellOutput {
  return {
    type: "sql-result",
    title: "SQL result",
    columns,
    rows,
    rowCount: rows.length,
    totalMatched: rows.length,
    truncated: false,
    engine: "notebook-sql",
    note: "",
    executionMs: 0,
  };
}

describe("handoff — handoffName", () => {
  it("keeps legal identifiers untouched", () => {
    expect(handoffName("sales_q1")).toBe("sales_q1");
    expect(handoffName("a1")).toBe("a1");
  });

  it("sanitizes illegal characters and leading digits", () => {
    expect(handoffName("sales-q1!")).toBe("sales_q1");
    expect(handoffName("1result")).toBe("v1result");
    expect(handoffName("my   result")).toBe("my_result");
  });

  it("returns null for empty or reserved names", () => {
    expect(handoffName(undefined)).toBeNull();
    expect(handoffName("")).toBeNull();
    expect(handoffName("df")).toBeNull();
    expect(handoffName("__")).toBeNull();
  });
});

describe("handoff — sqlOutputToExtra", () => {
  it("converts a sql-result into a typed Python extra", () => {
    const converted = sqlOutputToExtra(
      "sales",
      sqlResult([
        ["East", 100],
        ["West", 200],
      ]),
    );
    expect(converted).not.toBeNull();
    expect(converted!.extra).toEqual({
      name: "sales",
      columns: [
        { name: "region", type: "string" },
        { name: "amount", type: "number" },
      ],
      rows: [
        ["East", 100],
        ["West", 200],
      ],
    });
    expect(converted!.truncated).toBe(false);
  });

  it("converts plain table outputs too", () => {
    const table: NotebookCellOutput = {
      type: "table",
      title: "t",
      columns: [{ key: "name", label: "Name" }],
      rows: [["Ada"]],
    };
    const converted = sqlOutputToExtra("names", table);
    expect(converted!.extra.columns).toEqual([{ name: "name", type: "string" }]);
    expect(converted!.extra.rows).toEqual([["Ada"]]);
  });

  it("rejects non-tabular outputs and invalid names", () => {
    expect(sqlOutputToExtra("x", { type: "text", text: "hi" })).toBeNull();
    expect(sqlOutputToExtra("", sqlResult([]))).toBeNull();
    expect(sqlOutputToExtra("df", sqlResult([]))).toBeNull();
  });

  it("caps rows and reports truncation honestly", () => {
    const big = sqlResult(Array.from({ length: HANDOFF_ROW_CAP + 5 }, (_, i) => [String(i), i]));
    const converted = sqlOutputToExtra("big", big)!;
    expect(converted.extra.rows).toHaveLength(HANDOFF_ROW_CAP);
    expect(converted.truncated).toBe(true);
  });
});

describe("handoff — isTabularOutput", () => {
  it("accepts sql-result, table and conditional-table", () => {
    expect(isTabularOutput(sqlResult([]))).toBe(true);
    expect(isTabularOutput({ type: "table", title: "", columns: [], rows: [] })).toBe(true);
    expect(isTabularOutput({ type: "conditional-table", title: "", columns: [], rows: [], cellStyles: {} })).toBe(true);
    expect(isTabularOutput({ type: "text", text: "x" })).toBe(false);
    expect(isTabularOutput(null)).toBe(false);
  });
});

describe("handoff — collectExtras", () => {
  it("collects ran, named tabular cells in document order", () => {
    const cells: NotebookCell[] = [
      { id: "c1", kind: "sql", content: "SELECT 1", outputVariable: "sales", output: sqlResult([["East", 100]]) },
      { id: "c2", kind: "code", content: "x = 1" }, // no output → skipped
      { id: "c3", kind: "sql", content: "SELECT 2", outputVariable: "totals", output: sqlResult([["All", 300]]) },
      { id: "c4", kind: "sql", content: "SELECT 3" }, // ran but unnamed → skipped
    ] as NotebookCell[];
    const { extras, truncatedNames } = collectExtras(cells);
    expect(extras.map((e) => e.name)).toEqual(["sales", "totals"]);
    expect(truncatedNames).toEqual([]);
  });

  it("last write wins on duplicate output names", () => {
    const cells: NotebookCell[] = [
      { id: "c1", kind: "sql", content: "a", outputVariable: "sales", output: sqlResult([["old", 1]]) },
      { id: "c2", kind: "sql", content: "b", outputVariable: "sales", output: sqlResult([["new", 2]]) },
    ] as NotebookCell[];
    const { extras } = collectExtras(cells);
    expect(extras).toHaveLength(1);
    expect(extras[0]!.rows).toEqual([["new", 2]]);
  });

  it("returns [] when nothing is handable", () => {
    expect(collectExtras([{ id: "c", kind: "code", content: "x" } as NotebookCell]).extras).toEqual([]);
    expect(collectExtras([]).extras).toEqual([]);
  });
});

describe("handoff — describeExtras", () => {
  it("renders the df_<name> prompt hint with columns", () => {
    const { extras } = collectExtras([
      { id: "c1", kind: "sql", content: "s", outputVariable: "sales", output: sqlResult([["E", 1]]) },
    ] as NotebookCell[]);
    expect(describeExtras(extras)).toEqual(["df_sales (region, amount)"]);
  });
});

describe("handoff — reactiveRerunPlan (ROADMAP 4.3)", () => {
  const cells = [
    {
      id: "w1",
      kind: "widget",
      content: "",
      widget: { variable: "region", value: "East", label: "Region", kind: "dropdown", options: ["East", "West"] },
    },
    { id: "s1", kind: "sql", content: "SELECT * WHERE region = {{region}}", outputVariable: "sales" },
    { id: "p1", kind: "code", content: "x = $sales" },
    { id: "m1", kind: "markdown", content: "# static" },
  ] as unknown as NotebookCell[];

  it("plans downstream runnable cells in document order", () => {
    const plan = reactiveRerunPlan(cells, "w1");
    expect(plan).toContain("s1");
    expect(plan.indexOf("s1")).toBeLessThan(plan.indexOf("p1")); // document order
  });

  it("returns [] for non-widget or unknown cells", () => {
    expect(reactiveRerunPlan(cells, "s1")).toEqual([]);
    expect(reactiveRerunPlan(cells, "ghost")).toEqual([]);
  });

  it("excludes markdown (non-runnable) cells", () => {
    expect(reactiveRerunPlan(cells, "w1")).not.toContain("m1");
  });
});
