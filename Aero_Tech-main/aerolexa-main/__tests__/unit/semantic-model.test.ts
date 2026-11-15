/**
 * Oracle tests for the multi-table semantic layer.
 *
 * Every expectation is hand-computed on tiny star-schema fixtures — the same
 * numbers Power BI/Power Pivot would return for the same model:
 *
 *  Sales (fact):  Amount, customerKey          — 5 rows
 *  DimCustomer:   customerKey, Segment, Region
 *
 *  Fixture:
 *    DimCustomer:  C1 → VIP, East   C2 → VIP, West   C3 → Basic, East
 *    Sales:        (100, C1) (200, C1) (50, C2) (75, C3) (25, C9-orphan)
 */
import {
  buildDateDimension,
  buildSemanticModel,
  calculateWithRelated,
  relatedColumnValues,
  resolveRowFilters,
  type Relationship,
  type SemanticTable,
} from "@/lib/engine/semantic-model";

const dimCustomer: SemanticTable = {
  name: "DimCustomer",
  role: "dimension",
  model: {
    columns: ["customerKey", "Segment", "Region"],
    rows: [
      ["C1", "VIP", "East"],
      ["C2", "VIP", "West"],
      ["C3", "Basic", "East"],
    ],
  },
};

const sales: SemanticTable = {
  name: "Sales",
  role: "fact",
  model: {
    columns: ["Amount", "customerKey"],
    rows: [
      [100, "C1"],
      [200, "C1"],
      [50, "C2"],
      [75, "C3"],
      [25, "C9"], // orphan key on purpose
    ],
  },
};

const rel: Relationship = {
  name: "Sales→DimCustomer",
  fromTable: "Sales",
  fromColumn: "customerKey",
  toTable: "DimCustomer",
  toColumn: "customerKey",
  cardinality: "many-to-one",
};

function makeModel(extra: SemanticTable[] = [], rels: Relationship[] = [rel]) {
  return buildSemanticModel([sales, dimCustomer, ...extra], rels);
}

describe("star-schema validation", () => {
  it("accepts a clean relationship and flags the orphan rows as a warning", () => {
    const { issues } = makeModel();
    const orphan = issues.find((i) => i.message.includes("1 row(s)"));
    expect(orphan).toBeDefined();
    expect(orphan!.severity).toBe("warning");
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("errors when the one side has duplicate keys", () => {
    const badDim: SemanticTable = {
      name: "DimCustomer",
      role: "dimension",
      model: {
        columns: ["customerKey", "Segment"],
        rows: [
          ["C1", "VIP"],
          ["C1", "Basic"], // duplicate!
          ["C2", "VIP"],
        ],
      },
    };
    const { issues } = buildSemanticModel([sales, badDim], [rel]);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("duplicate keys"))).toBe(true);
  });

  it("errors on unknown tables or columns", () => {
    const badRel: Relationship = { ...rel, toColumn: "Nope" };
    const { issues } = buildSemanticModel([sales, dimCustomer], [badRel]);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("Key column"))).toBe(true);
  });
});

describe("RELATED() row propagation", () => {
  it("resolves dimension attributes onto fact rows (orphans → null)", () => {
    const { model } = makeModel();
    const segments = relatedColumnValues(model, rel.name, sales.model.rows, sales.model.columns, "Segment");
    expect(segments).toEqual(["VIP", "VIP", "VIP", "Basic", null]);
  });

  it("propagates region values for the same rows", () => {
    const { model } = makeModel();
    const regions = relatedColumnValues(model, rel.name, sales.model.rows, sales.model.columns, "Region");
    expect(regions).toEqual(["East", "East", "West", "East", null]);
  });

  it("throws an honest error for unknown relationships or columns", () => {
    const { model } = makeModel();
    expect(() => relatedColumnValues(model, "nope", sales.model.rows, sales.model.columns, "Segment")).toThrow(
      /not part of the model/,
    );
    expect(() => relatedColumnValues(model, rel.name, sales.model.rows, sales.model.columns, "Nope")).toThrow(
      /does not exist/,
    );
  });
});

describe("CALCULATE with RELATED() filters", () => {
  it('computes SUM of amounts where RELATED(DimCustomer[Segment]) = "VIP" → 350', () => {
    const { model } = makeModel();
    // Hand-computed: C1 rows 100 + 200, C2 row 50 → 350 (orphan C9 excluded).
    const value = calculateWithRelated(model, {
      factTable: "Sales",
      measureColumn: "Amount",
      aggregation: "sum",
      relatedFilter: { relationship: rel.name, dimensionColumn: "Segment", values: ["VIP"] },
    });
    expect(value).toBe(350);
  });

  it('computes SUM where Region = "East" → 375', () => {
    const { model } = makeModel();
    // C1 rows (300) + C3 row (75) = 375; C2 is West; orphan excluded.
    const value = calculateWithRelated(model, {
      factTable: "Sales",
      measureColumn: "Amount",
      aggregation: "sum",
      relatedFilter: { relationship: rel.name, dimensionColumn: "Region", values: ["East"] },
    });
    expect(value).toBe(375);
  });

  it("combines RELATED filter with RLS row filters (security precedes measure)", () => {
    const { model } = makeModel();
    // RLS restricts the fact table to customerKey C1/C2 rows only (amounts
    // 100, 200, 50); then RELATED Segment = VIP keeps 100+200+50 = 350.
    const value = calculateWithRelated(model, {
      factTable: "Sales",
      measureColumn: "Amount",
      aggregation: "sum",
      relatedFilter: { relationship: rel.name, dimensionColumn: "Segment", values: ["VIP"] },
      rowFilters: [{ column: "customerKey", values: ["C1", "C2"] }],
    });
    expect(value).toBe(350);
  });

  it("RLS alone restricts the measure (VIEWER scoped to C3 sees only 75)", () => {
    const { model } = makeModel();
    const value = calculateWithRelated(model, {
      factTable: "Sales",
      measureColumn: "Amount",
      aggregation: "sum",
      rowFilters: [{ column: "customerKey", values: ["C3"] }],
    });
    expect(value).toBe(75);
  });

  it("supports average / count / distinctcount aggregations", () => {
    const { model } = makeModel();
    const avg = calculateWithRelated(model, {
      factTable: "Sales",
      measureColumn: "Amount",
      aggregation: "average",
      rowFilters: [{ column: "customerKey", values: ["C1"] }],
    });
    expect(avg).toBe(150); // (100 + 200) / 2

    const count = calculateWithRelated(model, {
      factTable: "Sales",
      measureColumn: "Amount",
      aggregation: "count",
      relatedFilter: { relationship: rel.name, dimensionColumn: "Segment", values: ["VIP"] },
    });
    expect(count).toBe(3); // 100, 200, 50

    const distinct = calculateWithRelated(model, {
      factTable: "Sales",
      measureColumn: "customerKey",
      aggregation: "distinctcount",
    });
    expect(distinct).toBe(4); // C1, C2, C3, C9
  });
});

describe("date dimension", () => {
  it("generates contiguous days with correct calendar + ISO week attributes", () => {
    const dim = buildDateDimension({ start: "2026-01-01", end: "2026-01-07" });
    expect(dim.model.rows).toHaveLength(7);
    const head = dim.model.rows[0]!;
    // 2026-01-01 is a Thursday; ISO week 1; dateKey 20260101.
    expect(head[0]).toBe(20260101);
    expect(head[2]).toBe(2026);
    expect(head[3]).toBe(1);
    expect(head[6]).toBe(1); // weekOfYear
    // Thursday = dayOfWeek 4 (Sunday = 0).
    expect(head[7]).toBe(4);
  });

  it("shifts fiscal year/quarter by the fiscal start month", () => {
    // Indian fiscal year starts April (month 4). Years are labelled by their
    // fiscal START year: March 2026 closes FY2025 (Apr 2025–Mar 2026);
    // April 2026 opens FY2026 (Apr 2026–Mar 2027).
    const dim = buildDateDimension({ start: "2026-03-31", end: "2026-04-02", fiscalYearStartMonth: 4 });
    const mar = dim.model.rows[0]!;
    const apr = dim.model.rows[1]!;
    expect(mar[8]).toBe(2025);
    expect(apr[8]).toBe(2026); // April 2026 opens FY2026 (Apr 2026–Mar 2027)
    expect(apr[9]).toBe("FY-Q1");
    void mar;
  });

  it("date keys join to fact dateKeys (contiguity)", () => {
    const feb = buildDateDimension({ start: "2026-02-27", end: "2026-03-02" });
    const keys = feb.model.rows.map((r) => r[0] as number);
    // Crosses the month boundary.
    expect(keys).toEqual([20260227, 20260228, 20260301, 20260302]);
  });
});

describe("RLS rule resolution", () => {
  it("resolves rules per role and table; unrestricted roles get []", () => {
    const rules = [{ role: "VIEWER", table: "Sales", column: "Region", values: ["East"] }];
    expect(resolveRowFilters(rules, "VIEWER", "Sales")).toEqual([{ column: "Region", values: ["East"] }]);
    expect(resolveRowFilters(rules, "ADMIN", "Sales")).toEqual([]);
    expect(resolveRowFilters(rules, "VIEWER", "DimCustomer")).toEqual([]);
  });
});
