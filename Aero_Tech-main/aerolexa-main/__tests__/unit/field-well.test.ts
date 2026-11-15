/**
 * Oracle tests for the field-well + drill-hierarchy engine
 * (lib/server/field-well.ts). Every number is hand-computed from the fixture
 * frame below.
 *
 * Fixture (a small geography → sales fact):
 *   Country  City         Category     Sales
 *   UK       London       A            100
 *   UK       London       B             50
 *   UK       Manchester   A             30
 *   France   Paris        A             80
 *   France   Paris        B             20
 *   France   Lyon         B             10
 */

import {
  aggregateBy,
  buildFieldWellSpec,
  distinctColumnValues,
  drillLevelSpec,
  rowsForDrillPath,
  validateFieldWell,
  validateHierarchy,
} from "@/lib/server/field-well";

const frame = {
  columns: [
    { name: "Country", type: "string" },
    { name: "City", type: "string" },
    { name: "Category", type: "string" },
    { name: "Sales", type: "number" },
  ],
  rows: [
    ["UK", "London", "A", 100],
    ["UK", "London", "B", 50],
    ["UK", "Manchester", "A", 30],
    ["France", "Paris", "A", 80],
    ["France", "Paris", "B", 20],
    ["France", "Lyon", "B", 10],
  ] as (string | number | null)[][],
};

describe("distinctColumnValues", () => {
  it("returns distinct values in first-seen order", () => {
    expect(distinctColumnValues(frame, "Country")).toEqual(["UK", "France"]);
    expect(distinctColumnValues(frame, "Category")).toEqual(["A", "B"]);
  });

  it("throws for a column not in the dataset", () => {
    expect(() => distinctColumnValues(frame, "Continent")).toThrow(/Continent/);
  });
});

describe("aggregateBy", () => {
  it("sums Sales per Country (hand-computed)", () => {
    // UK: 100+50+30 = 180; France: 80+20+10 = 110
    expect(aggregateBy(frame, ["Country"], "Sales", "sum")).toEqual({
      categories: ["UK", "France"],
      values: [180, 110],
    });
  });

  it("aggregates by two levels with a ' › ' joined key", () => {
    // UK › London: 100+50 = 150; UK › Manchester: 30; France › Paris: 100; France › Lyon: 10
    expect(aggregateBy(frame, ["Country", "City"], "Sales", "sum")).toEqual({
      categories: ["UK › London", "UK › Manchester", "France › Paris", "France › Lyon"],
      values: [150, 30, 100, 10],
    });
  });

  it("computes avg, min, max and count per group", () => {
    // France › Paris rows: Sales 80, 20 → avg 50, min 20, max 80, count 2
    const g = ["France", "Paris"] as const;
    const key = `${g[0]} › ${g[1]}`;
    expect(aggregateBy(frame, ["Country", "City"], "Sales", "avg").values[2]).toBe(50);
    expect(aggregateBy(frame, ["Country", "City"], "Sales", "min").values[2]).toBe(20);
    expect(aggregateBy(frame, ["Country", "City"], "Sales", "max").values[2]).toBe(80);
    expect(aggregateBy(frame, ["Country", "City"], "Sales", "count").values[2]).toBe(2);
    void key;
  });

  it("treats blank group cells as '(blank)'", () => {
    const f = {
      columns: [
        { name: "R", type: "string" },
        { name: "V", type: "number" },
      ],
      rows: [
        ["X", 5],
        [null, 7],
        ["", 9],
      ] as (string | number | null)[][],
    };
    // null and "" both map to "(blank)"; X row stays X → sum X=5, (blank)=16
    expect(aggregateBy(f, ["R"], "V", "sum")).toEqual({
      categories: ["X", "(blank)"],
      values: [5, 16],
    });
  });
});

describe("buildFieldWellSpec", () => {
  it("builds a real bar spec from axis + value columns", () => {
    const spec = buildFieldWellSpec(frame, { axis: ["Country"], values: ["Sales"] }, { agg: "sum" });
    expect(spec.kind).toBe("bar");
    expect(spec.categories).toEqual(["UK", "France"]);
    expect(spec.series[0]!.data).toEqual([180, 110]);
    expect(spec.title).toBe("sum of Sales by Country");
  });

  it("counts rows when no value column is bound", () => {
    const spec = buildFieldWellSpec(frame, { axis: ["Country"] }, { agg: "count" });
    expect(spec.series[0]!.data).toEqual([3, 3]);
    expect(spec.title).toBe("Count of rows by Country");
  });

  it("splits series per legend value with aligned categories", () => {
    const spec = buildFieldWellSpec(
      frame,
      { axis: ["Country"], values: ["Sales"], legend: "Category" },
      { agg: "sum" },
    );
    // UK: A=100+30=130, B=50; France: A=80, B=20+10=30
    expect(spec.categories).toEqual(["UK", "France"]);
    const a = spec.series.find((s) => s.name === "A")!;
    const b = spec.series.find((s) => s.name === "B")!;
    expect(a.data).toEqual([130, 80]);
    expect(b.data).toEqual([50, 30]);
  });

  it("throws when the axis well is empty or a column is unknown", () => {
    expect(() => buildFieldWellSpec(frame, { axis: [] })).toThrow(/axis/i);
    expect(validateFieldWell(frame, { axis: ["Country"], values: ["Profit"] })).toEqual([
      "Value column “[Profit]” is not in this dataset.",
    ]);
  });
});

describe("drill hierarchies", () => {
  const hierarchy = { name: "Geo", levels: ["Country", "City"] };

  it("validates: ≥2 levels, all levels real columns", () => {
    expect(validateHierarchy(frame, hierarchy)).toEqual([]);
    expect(validateHierarchy(frame, { name: "x", levels: ["Country"] })).toEqual([
      "A hierarchy needs at least two levels to drill through.",
    ]);
    expect(validateHierarchy(frame, { name: "x", levels: ["Country", "Continent"] })).toEqual([
      "Hierarchy level “[Continent]” is not in this dataset.",
    ]);
  });

  it("level 0 aggregates by the top level", () => {
    const { spec, level, parent } = drillLevelSpec(frame, hierarchy, [], { measure: "Sales", agg: "sum" });
    expect(level).toBe("Country");
    expect(parent).toBeNull();
    expect(spec.series[0]!.data).toEqual([180, 110]);
  });

  it("level 1 drills through a path and aggregates within it", () => {
    const { spec, level, parent } = drillLevelSpec(frame, hierarchy, ["UK"], { measure: "Sales", agg: "sum" });
    expect(level).toBe("City");
    expect(parent).toBe("UK");
    // UK rows only: London 150, Manchester 30
    expect(spec.categories).toEqual(["London", "Manchester"]);
    expect(spec.series[0]!.data).toEqual([150, 30]);
  });

  it("deeper drill path composes: France → Paris counts 2 rows", () => {
    const { spec } = drillLevelSpec(
      frame,
      { name: "Geo", levels: ["Country", "City", "Category"] },
      ["France", "Paris"],
      {
        agg: "count",
      },
    );
    expect(spec.categories).toEqual(["A", "B"]);
    expect(spec.series[0]!.data).toEqual([1, 1]);
  });

  it("rejects a stale path value instead of showing an empty branch", () => {
    expect(() => rowsForDrillPath(frame, hierarchy, ["Atlantis"])).toThrow(/Atlantis/);
    expect(() => drillLevelSpec(frame, hierarchy, ["Atlantis"])).toThrow(/Atlantis/);
  });

  it("refuses to drill past the deepest level", () => {
    expect(() => drillLevelSpec(frame, hierarchy, ["UK", "London"])).toThrow(/deepest/);
  });
});
