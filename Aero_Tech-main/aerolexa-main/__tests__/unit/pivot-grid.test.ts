/**
 * Pivot grid engine — the upgraded pivot table's pure core:
 * field wells (drag-drop state), aggregation switching, drill-down paths.
 * These tests pin the state invariants the UI depends on.
 */

import {
  PIVOT_AGGREGATIONS,
  addField,
  aggregationMeta,
  canAggregate,
  drillDown,
  drillPathLabels,
  emptyFieldState,
  findFieldWell,
  isLeafLevel,
  moveField,
  pivotRequestBody,
  removeField,
  setValueAggregation,
  type PivotFieldState,
} from "@/lib/engine/pivot-grid";

const FIELDS: PivotFieldState = {
  rows: ["region"],
  columns: ["product"],
  values: [{ column: "total", aggregation: "sum" }],
};

describe("pivot grid — aggregation spec", () => {
  it("exposes the five supported aggregations", () => {
    expect(PIVOT_AGGREGATIONS.map((a) => a.id)).toEqual(["sum", "count", "avg", "min", "max"]);
  });

  it("marks numeric-only aggregations correctly", () => {
    expect(aggregationMeta("sum")?.numericOnly).toBe(true);
    expect(aggregationMeta("count")?.numericOnly).toBe(false);
    expect(aggregationMeta("avg")?.numericOnly).toBe(true);
    expect(aggregationMeta("nope")).toBeNull();
  });

  it("blocks numeric-only aggregations on non-numeric columns", () => {
    expect(canAggregate("sum", "number")).toBe(true);
    expect(canAggregate("sum", "string")).toBe(false);
    expect(canAggregate("count", "string")).toBe(true);
    expect(canAggregate("min", "date")).toBe(true);
    expect(canAggregate("nope", "number")).toBe(false);
  });
});

describe("pivot grid — field wells", () => {
  it("starts empty", () => {
    expect(emptyFieldState()).toEqual({ rows: [], columns: [], values: [] });
  });

  it("finds the well a field sits in", () => {
    expect(findFieldWell(FIELDS, "region")).toBe("rows");
    expect(findFieldWell(FIELDS, "product")).toBe("columns");
    expect(findFieldWell(FIELDS, "total")).toBe("values");
    expect(findFieldWell(FIELDS, "missing")).toBeNull();
  });

  it("adds fields to a well", () => {
    const next = addField(FIELDS, "rows", "rep");
    expect(next.rows).toEqual(["region", "rep"]);
    expect(next.columns).toEqual(["product"]);
  });

  it("defaults a numeric value field to sum and a string one to count", () => {
    const numeric = addField(emptyFieldState(), "values", "amount", "number");
    expect(numeric.values).toEqual([{ column: "amount", aggregation: "sum" }]);
    const text = addField(emptyFieldState(), "values", "name", "string");
    expect(text.values).toEqual([{ column: "name", aggregation: "count" }]);
  });

  it("moves a field between wells without duplication", () => {
    const moved = addField(FIELDS, "values", "region", "string");
    expect(moved.rows).toEqual([]);
    expect(moved.values.map((v) => v.column)).toEqual(["total", "region"]);
    // the invariant: the field exists in exactly one well
    expect([findFieldWell(moved, "region")]).not.toContain(null);
    expect(
      [moved.rows, moved.columns, moved.values.map((v) => v.column)].flat().filter((f) => f === "region"),
    ).toHaveLength(1);
  });

  it("removes a field from wherever it sits", () => {
    const next = removeField(FIELDS, "product");
    expect(next.columns).toEqual([]);
    expect(next.rows).toEqual(["region"]);
  });

  it("reorders within a row well", () => {
    const two = addField(FIELDS, "rows", "rep");
    const reordered = moveField(two, "rows", "rows", "region", 1);
    expect(reordered.rows).toEqual(["rep", "region"]);
  });

  it("no-ops reorder for the values well (spec order is managed explicitly)", () => {
    const reordered = moveField(FIELDS, "values", "values", "total", 0);
    expect(reordered.values).toEqual(FIELDS.values);
  });

  it("no-ops when the field is not in the source well", () => {
    expect(moveField(FIELDS, "rows", "columns", "not-there")).toBe(FIELDS);
  });

  it("switches the aggregation on a value spec", () => {
    const next = setValueAggregation(FIELDS, "total", "avg");
    expect(next.values[0]).toEqual({ column: "total", aggregation: "avg" });
    expect(setValueAggregation(FIELDS, "missing", "avg").values).toEqual(FIELDS.values);
  });
});

describe("pivot grid — drill-down", () => {
  const rows = ["region", "product", "rep"];

  it("expands a clicked group into the next level with filters", () => {
    const { filters, nextLevel } = drillDown(rows, [], ["East", "A", "Alice"]);
    expect(filters).toEqual([{ column: "region", value: "East" }]);
    expect(nextLevel).toBe("product");
  });

  it("extends an existing drill path one level deeper", () => {
    const level1 = drillDown(rows, [], ["East", "A", "Alice"]);
    const level2 = drillDown(rows, level1.filters, ["East", "A", "Alice"]);
    expect(level2.filters).toEqual([
      { column: "region", value: "East" },
      { column: "product", value: "A" },
    ]);
    expect(level2.nextLevel).toBe("rep");
  });

  it("returns null nextLevel at the leaf", () => {
    const leaf = drillDown(
      rows,
      [
        { column: "region", value: "East" },
        { column: "product", value: "A" },
        { column: "rep", value: "Alice" },
      ],
      [],
    );
    expect(leaf.nextLevel).toBeNull();
    expect(leaf.filters).toHaveLength(3);
    expect(isLeafLevel(rows, leaf.filters)).toBe(true);
  });

  it("labels the breadcrumb path", () => {
    expect(
      drillPathLabels([
        { column: "region", value: "East" },
        { column: "product", value: "A" },
      ]),
    ).toEqual(["region = East", "product = A"]);
  });

  it("tolerates missing clicked values", () => {
    const { filters } = drillDown(rows, [], []);
    expect(filters).toEqual([{ column: "region", value: "" }]);
  });
});

describe("pivot grid — request body", () => {
  it("shapes the API body from the field state", () => {
    const body = pivotRequestBody(FIELDS);
    expect(body).toMatchObject({ rows: ["region"], columns: ["product"], values: FIELDS.values });
  });

  it("front-loads drill-filtered row columns so the group-by respects the path", () => {
    const body = pivotRequestBody(FIELDS, [{ column: "region", value: "East" }]);
    expect(body.rows[0]).toBe("region");
  });

  it("rejects empty configurations with an honest error", () => {
    expect(pivotRequestBody(emptyFieldState()).error).toMatch(/row field/i);
    expect(pivotRequestBody({ rows: ["region"], columns: [], values: [] }).error).toMatch(/value field/i);
  });
});
