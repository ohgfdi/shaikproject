import { isConditionalTableOutput, isTableOutput } from "@/lib/engine/notebook-output";
import type { NotebookCellOutput } from "@/lib/types";

const table: NotebookCellOutput = {
  type: "table",
  title: "Revenue by region",
  columns: [
    { key: "region", label: "Region" },
    { key: "revenue", label: "Revenue", format: "number" },
  ],
  rows: [
    ["North", 120],
    ["South", 80],
  ],
};

const conditionalTable: NotebookCellOutput = {
  type: "conditional-table",
  title: "Variance",
  columns: [{ key: "line", label: "Line" }],
  rows: [["Sales"]],
  cellStyles: { "0:0": { color: "red" } },
};

describe("notebook output guards", () => {
  it("accepts a table output and narrows to its columns/rows", () => {
    expect(isTableOutput(table)).toBe(true);
    expect(isTableOutput(table) && table.columns[0]?.label).toBe("Region");
  });

  it("rejects non-table outputs", () => {
    expect(isTableOutput(null)).toBe(false);
    expect(isTableOutput(undefined)).toBe(false);
    expect(isTableOutput(conditionalTable)).toBe(false);
    expect(isTableOutput({ type: "text", text: "hello" })).toBe(false);
    expect(isTableOutput({ type: "sql-result" } as NotebookCellOutput)).toBe(false);
  });

  it("rejects malformed table snapshots that are missing columns or rows", () => {
    expect(isTableOutput({ type: "table", title: "Broken" } as NotebookCellOutput)).toBe(false);
    expect(
      isTableOutput({ type: "table", title: "Broken", columns: [], rows: null } as unknown as NotebookCellOutput),
    ).toBe(false);
  });

  it("accepts only well-formed conditional tables", () => {
    expect(isConditionalTableOutput(conditionalTable)).toBe(true);
    expect(isConditionalTableOutput(table)).toBe(false);
    expect(isConditionalTableOutput(null)).toBe(false);
    expect(
      isConditionalTableOutput({
        type: "conditional-table",
        title: "Broken",
        columns: [],
      } as unknown as NotebookCellOutput),
    ).toBe(false);
  });
});
