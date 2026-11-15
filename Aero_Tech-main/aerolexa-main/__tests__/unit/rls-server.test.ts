import {
  applyRlsToRows,
  describeRestrictions,
  filtersForUser,
  filtersForUserByDataset,
  type StoredRlsRule,
} from "@/lib/server/rls";

/**
 * Oracle tests for the RLS server layer — hand-computed row outcomes.
 * The rule semantics: a user's filters for a dataset AND together; rows are
 * String()-coerced for comparison so numeric storage matches numeric rules.
 */

const rules: StoredRlsRule[] = [
  {
    id: "rls_VIEWER_ds1_Region",
    role: "VIEWER",
    datasetId: "ds1",
    datasetName: "Sales",
    column: "Region",
    values: ["East"],
  },
  {
    id: "rls_VIEWER_ds1_Amount",
    role: "VIEWER",
    datasetId: "ds1",
    datasetName: "Sales",
    column: "Amount",
    values: [100],
  },
  {
    id: "rls_EDITOR_ds2_Region",
    role: "EDITOR",
    datasetId: "ds2",
    datasetName: "Costs",
    column: "Region",
    values: ["West", "North"],
  },
];

const columns = [{ name: "Date" }, { name: "Region" }, { name: "Amount" }];
const rows: (string | number | boolean | null)[][] = [
  ["2024-01-05", "East", 100],
  ["2024-01-20", "East", 200],
  ["2024-02-15", "West", 300],
  ["2024-03-01", "West", 100],
];

describe("RLS — filtersForUser", () => {
  test("returns only the rules for the user's role + dataset", () => {
    expect(filtersForUser(rules, "VIEWER", "ds1")).toEqual([
      { column: "Region", values: ["East"] },
      { column: "Amount", values: [100] },
    ]);
  });

  test("unrestricted when no rule matches (OWNER or unknown dataset)", () => {
    expect(filtersForUser(rules, "OWNER", "ds1")).toEqual([]);
    expect(filtersForUser(rules, "VIEWER", "dsX")).toEqual([]);
  });

  test("filtersForUserByDataset groups by dataset", () => {
    const map = filtersForUserByDataset(rules, "EDITOR");
    expect(map.get("ds2")).toEqual([{ column: "Region", values: ["West", "North"] }]);
    expect(map.get("ds1")).toBeUndefined();
  });
});

describe("RLS — applyRlsToRows (hand-computed outcomes)", () => {
  test("single filter keeps only matching rows", () => {
    const out = applyRlsToRows(rows, columns, [{ column: "Region", values: ["East"] }]);
    expect(out.rows).toEqual([
      ["2024-01-05", "East", 100],
      ["2024-01-20", "East", 200],
    ]);
    expect(out.applied).toBe(true);
    expect(out.note).toContain("2 of 4");
  });

  test("multiple filters on different columns AND together", () => {
    // East AND Amount=100 → only the first row.
    const out = applyRlsToRows(rows, columns, [
      { column: "Region", values: ["East"] },
      { column: "Amount", values: [100] },
    ]);
    expect(out.rows).toEqual([["2024-01-05", "East", 100]]);
  });

  test("numeric coercion: stored numbers match rule numbers", () => {
    const out = applyRlsToRows(rows, columns, [{ column: "Amount", values: ["100"] }]);
    expect(out.rows).toHaveLength(2); // rows 1 and 4 (100 each)
  });

  test("empty filter list is a no-op (unrestricted)", () => {
    const out = applyRlsToRows(rows, columns, []);
    expect(out.rows).toBe(rows);
    expect(out.applied).toBe(false);
    expect(out.note).toBe("");
  });

  test("fail-closed: a rule column missing from the dataset yields 0 rows", () => {
    const out = applyRlsToRows(rows, columns, [{ column: "Ghost", values: ["x"] }]);
    expect(out.rows).toEqual([]);
    expect(out.applied).toBe(true);
    expect(out.note.toLowerCase()).toContain("no longer exist");
  });

  test("note reports unrestricted-matching case honestly", () => {
    const out = applyRlsToRows(rows, columns, [{ column: "Region", values: ["East", "West"] }]);
    expect(out.rows).toHaveLength(4);
    expect(out.note).toContain("all 4 rows match");
  });
});

describe("RLS — describeRestrictions", () => {
  test("human-readable restriction summary for the UI banner", () => {
    expect(describeRestrictions(rules, "VIEWER")).toEqual(["Sales[Region] ∈ { East }", "Sales[Amount] ∈ { 100 }"]);
    expect(describeRestrictions(rules, "OWNER")).toEqual([]);
  });
});
