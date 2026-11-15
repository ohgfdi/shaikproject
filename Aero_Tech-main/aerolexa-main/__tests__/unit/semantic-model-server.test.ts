/**
 * Unit tests for the semantic-model server layer's pure logic.
 *
 * The DB-dependent paths (loadProjectModel, evaluateProjectMeasure CRUD) run
 * against real datasets in the gated suites; here we pin the pure helpers the
 * routes and panel rely on — expression parsing, star-schema validation over
 * realistic stored-row shapes, RELATED() filtering and RLS resolution — with
 * hand-computed fixtures.
 */
import {
  buildSemanticModel,
  calculateWithRelated,
  resolveRowFilters,
  type RlsRule,
  type SemanticTable,
} from "@/lib/engine/semantic-model";
import { parseSimpleAggregation } from "@/lib/server/semantic-model";

// ---------------------------------------------------------------------------
// Fixtures — hand-computed star schema
// ---------------------------------------------------------------------------

/** Fact table: Sales with Amount + customerKey. */
function salesTable(): SemanticTable {
  return {
    name: "Sales",
    role: "fact",
    model: {
      columns: ["Amount", "customerKey", "Region"],
      rows: [
        [100, "C1", "East"],
        [200, "C1", "East"],
        [50, "C2", "West"],
        [75, "C3", "East"],
      ],
    },
  };
}

/** Dimension: DimCustomer keyed by customerKey. */
function customersTable(): SemanticTable {
  return {
    name: "DimCustomer",
    role: "dimension",
    model: {
      columns: ["customerKey", "Segment"],
      rows: [
        ["C1", "VIP"],
        ["C2", "VIP"],
        ["C3", "Basic"],
      ],
    },
  };
}

const rel = {
  name: "Sales→DimCustomer",
  fromTable: "Sales",
  fromColumn: "customerKey",
  toTable: "DimCustomer",
  toColumn: "customerKey",
  cardinality: "many-to-one" as const,
};

describe("parseSimpleAggregation (server layer)", () => {
  it("parses the supported <AGG>([col]) forms, case-insensitively", () => {
    expect(parseSimpleAggregation("SUM([Amount])")).toEqual({ aggregation: "sum", column: "Amount" });
    expect(parseSimpleAggregation("avg( [Qty] )")).toEqual({ aggregation: "average", column: "Qty" });
    expect(parseSimpleAggregation("DistinctCount([customerKey])")).toEqual({
      aggregation: "distinctcount",
      column: "customerKey",
    });
  });

  it("tolerates a wrapping CALCULATE(...)", () => {
    expect(parseSimpleAggregation("CALCULATE(SUM([Amount]))")).toEqual({ aggregation: "sum", column: "Amount" });
  });

  it("rejects richer expressions (they belong in DAX studio)", () => {
    expect(parseSimpleAggregation("SUM([A]) + SUM([B])")).toBeNull();
    expect(parseSimpleAggregation("DIVIDE(SUM([A]), COUNTROWS(Sales))")).toBeNull();
    expect(parseSimpleAggregation("SUM(Sales[Amount])")).toBeNull();
    expect(parseSimpleAggregation("")).toBeNull();
  });
});

describe("validateRelationships logic (via buildSemanticModel)", () => {
  it("accepts a clean star-schema relationship", () => {
    const { issues } = buildSemanticModel([salesTable(), customersTable()], [rel]);
    expect(issues).toEqual([]);
  });

  it("errors when the one side has duplicate keys (ambiguous lookup)", () => {
    const dupCustomers = customersTable();
    dupCustomers.model.rows = [...dupCustomers.model.rows, ["C1", "VIP-DUP"]];
    const { issues } = buildSemanticModel([salesTable(), dupCustomers], [rel]);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("duplicate keys"))).toBe(true);
  });

  it("warns on orphan rows on the many side (RELATED → BLANK)", () => {
    const orphanSales = salesTable();
    orphanSales.model.rows = [...orphanSales.model.rows, [10, "GHOST", "East"]];
    const { issues } = buildSemanticModel([orphanSales, customersTable()], [rel]);
    const orphan = issues.find((i) => i.severity === "warning" && i.message.includes("no match"));
    expect(orphan).toBeTruthy();
    expect(orphan?.message).toContain("1 row(s)");
  });

  it("errors when a key column is missing from a table", () => {
    const noKey = customersTable();
    noKey.model.columns = ["id", "Segment"];
    const { issues } = buildSemanticModel([salesTable(), noKey], [rel]);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("Key column not found"))).toBe(true);
  });

  it("errors when a relationship references a table outside the model", () => {
    const { issues } = buildSemanticModel([salesTable()], [{ ...rel, toTable: "DimGhost" }]);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("not part of the model"))).toBe(true);
  });
});

describe("evaluateProjectMeasure math (via calculateWithRelated)", () => {
  it("SUM over the whole fact table", () => {
    const { model } = buildSemanticModel([salesTable(), customersTable()], [rel]);
    expect(calculateWithRelated(model, { factTable: "Sales", measureColumn: "Amount", aggregation: "sum" })).toBe(425);
  });

  it("RELATED() dimension filter — VIP = C1 + C2 rows = 350", () => {
    const { model } = buildSemanticModel([salesTable(), customersTable()], [rel]);
    const vip = calculateWithRelated(model, {
      factTable: "Sales",
      measureColumn: "Amount",
      aggregation: "sum",
      relatedFilter: { relationship: "Sales→DimCustomer", dimensionColumn: "Segment", values: ["VIP"] },
    });
    expect(vip).toBe(350); // 100 + 200 + 50
  });

  it("RLS row filter evaluated BEFORE the related filter — East VIP = 300", () => {
    const { model } = buildSemanticModel([salesTable(), customersTable()], [rel]);
    const eastVip = calculateWithRelated(model, {
      factTable: "Sales",
      measureColumn: "Amount",
      aggregation: "sum",
      relatedFilter: { relationship: "Sales→DimCustomer", dimensionColumn: "Segment", values: ["VIP"] },
      rowFilters: [{ column: "Region", values: ["East"] }],
    });
    expect(eastVip).toBe(300); // 100 + 200 (C3/75 is East but Basic)
  });

  it("RLS alone restricts rows — West sum = 50", () => {
    const { model } = buildSemanticModel([salesTable(), customersTable()], [rel]);
    expect(
      calculateWithRelated(model, {
        factTable: "Sales",
        measureColumn: "Amount",
        aggregation: "sum",
        rowFilters: [{ column: "Region", values: ["West"] }],
      }),
    ).toBe(50);
  });

  it("distinctcount and average aggregate correctly", () => {
    const { model } = buildSemanticModel([salesTable(), customersTable()], [rel]);
    expect(
      calculateWithRelated(model, { factTable: "Sales", measureColumn: "customerKey", aggregation: "distinctcount" }),
    ).toBe(3);
    expect(
      calculateWithRelated(model, { factTable: "Sales", measureColumn: "Amount", aggregation: "average" }),
    ).toBeCloseTo(106.25, 10); // 425 / 4
  });
});

describe("resolveRowFilters (RLS rule mapping)", () => {
  const rules: RlsRule[] = [
    { role: "VIEWER", table: "Sales", column: "Region", values: ["East"] },
    { role: "EDITOR", table: "Sales", column: "Region", values: ["East", "West"] },
    { role: "VIEWER", table: "DimCustomer", column: "Segment", values: ["VIP"] },
  ];

  it("returns only the rules for the role + table", () => {
    expect(resolveRowFilters(rules, "VIEWER", "Sales")).toEqual([{ column: "Region", values: ["East"] }]);
    expect(resolveRowFilters(rules, "EDITOR", "Sales")).toEqual([{ column: "Region", values: ["East", "West"] }]);
  });

  it("returns [] (full access) for roles/tables without rules", () => {
    expect(resolveRowFilters(rules, "ADMIN", "Sales")).toEqual([]);
    expect(resolveRowFilters(rules, "VIEWER", "DimGhost")).toEqual([]);
  });
});
