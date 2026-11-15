import {
  buildMeasureLineage,
  columnsForTable,
  extractMeasureDependencies,
  measuresReading,
  DAX_FUNCTIONS,
} from "@/lib/engine/measure-lineage";

describe("measure lineage", () => {
  describe("extractMeasureDependencies", () => {
    it("parses a qualified column reference with its table", () => {
      const deps = extractMeasureDependencies("SUM('Sales'[Amount])");
      expect(deps.columns).toEqual([{ name: "Amount", table: "Sales" }]);
      expect(deps.measures).toEqual([]);
      expect(deps.tables).toEqual(["Sales"]);
    });

    it("parses plain column references with null table", () => {
      const deps = extractMeasureDependencies("SUM([Amount]) + [Tax]", {
        knownColumns: ["Amount", "Tax"],
      });
      expect(deps.columns).toEqual([
        { name: "Amount", table: null },
        { name: "Tax", table: null },
      ]);
    });

    it("never treats a DAX built-in call as a measure", () => {
      const deps = extractMeasureDependencies("CALCULATE(SUMX('Sales', [Amount] * [Price]))", {
        knownMeasures: ["Calculated"],
      });
      expect(deps.measures).toEqual([]);
      expect(deps.tables).toEqual(["Sales"]);
      expect(DAX_FUNCTIONS.has("CALCULATE")).toBe(true);
    });

    it("resolves [Name] to a measure when the name is known", () => {
      const deps = extractMeasureDependencies("[Gross Revenue] - [COGS]", {
        knownMeasures: ["Gross Revenue", "COGS"],
        knownColumns: ["Amount"],
      });
      expect(deps.measures).toEqual(["Gross Revenue", "COGS"]);
      expect(deps.columns).toEqual([]);
    });

    it("resolves bare MeasureName( calls when the name is known", () => {
      const deps = extractMeasureDependencies("DIVIDE([Revenue], PriorYearRevenue())", {
        knownMeasures: ["Revenue", "PriorYearRevenue"],
      });
      expect(deps.measures).toEqual(["Revenue", "PriorYearRevenue"]);
    });

    it("flags unqualified references that match no measure and no column as ambiguous", () => {
      const deps = extractMeasureDependencies("SUM([Mystery])", { knownColumns: ["Amount"] });
      expect(deps.columns).toEqual([{ name: "Mystery", table: null, ambiguous: true }]);
    });

    it("drops duplicate references but upgrades a later qualified form", () => {
      const deps = extractMeasureDependencies("SUM([Amount]) + RELATED('Dim'[Amount])", {
        knownColumns: ["Amount"],
      });
      expect(deps.columns).toEqual([{ name: "Amount", table: "Dim", ambiguous: undefined }]);
      expect(deps.measures).toEqual([]);
    });

    it("collects standalone table references from ALL/FILTER/VALUES contexts", () => {
      const deps = extractMeasureDependencies(
        "CALCULATE(COUNTROWS('Sales'), FILTER('Sales', [Product] <> BLANK()), ALL('DimDate'))",
      );
      expect(deps.tables.sort()).toEqual(["DimDate", "Sales"]);
      expect(deps.measures).toEqual([]);
    });

    it("handles RELATED and LOOKUPVALUE table-qualified columns", () => {
      const deps = extractMeasureDependencies(
        "COUNTROWS(FILTER('Fact', RELATED('DimCust'[Segment]) = \\\"VIP\\\" && LOOKUPVALUE('Dim'[Code], 'Dim'[key], 'Fact'[custKey]) = \\\"A\\\"))",
      );
      expect(deps.columns.map((c) => `${c.table}|${c.name}`).sort()).toEqual(
        ["Dim|Code", "Dim|key", "DimCust|Segment", "Fact|custKey"].sort(),
      );
      expect(deps.tables.sort()).toEqual(["Dim", "DimCust", "Fact"]);
    });
  });

  describe("buildMeasureLineage", () => {
    it("returns a per-measure dependency map keyed by name", () => {
      const lineage = buildMeasureLineage(
        [
          { name: "Revenue", expression: "SUM('Sales'[Amount])" },
          { name: "Net Profit", expression: "[Revenue] - [COGS]" },
          { name: "COGS", expression: "SUM('Sales'[Cost])" },
        ],
        ["Amount", "Cost"],
      );
      expect(lineage.get("Revenue")!.columns).toEqual([{ name: "Amount", table: "Sales" }]);
      expect(lineage.get("Net Profit")!.measures).toEqual(["Revenue", "COGS"]);
      expect(lineage.get("Net Profit")!.columns).toEqual([]);
      expect(lineage.get("COGS")!.columns).toEqual([{ name: "Cost", table: "Sales" }]);
    });
  });

  describe("measuresReading / reverse lineage", () => {
    const lineage = buildMeasureLineage(
      [
        { name: "Revenue", expression: "SUM('Sales'[Amount])" },
        { name: "Net Profit", expression: "[Revenue] - [COGS]" },
        { name: "COGS", expression: "SUM('Sales'[Cost])" },
        { name: "Round Net", expression: "ROUND([Net Profit], 2)" },
      ],
      ["Amount", "Cost"],
    );

    it("finds direct readers of a column", () => {
      expect(measuresReading(lineage, { name: "Amount", table: "Sales" })).toEqual(["Revenue"]);
      expect(measuresReading(lineage, { name: "Cost", table: "Sales" })).toEqual(["COGS"]);
    });

    it("finds transitive readers through measure->measure edges", () => {
      expect(measuresReading(lineage, { name: "Revenue" })).toEqual(["Net Profit", "Round Net"]);
    });

    it("matches by plain name when no table is supplied", () => {
      expect(measuresReading(lineage, { name: "Amount" })).toEqual(["Revenue"]);
    });

    it("returns nothing when nothing reads the target", () => {
      expect(measuresReading(lineage, { name: "Nobody" })).toEqual([]);
    });
  });

  describe("columnsForTable", () => {
    it("returns the columns a measure reads from one table (qualified or plain)", () => {
      const deps = extractMeasureDependencies("SUM('Sales'[Amount]) + RELATED('DimCust'[Segment]) + [Tax]");
      expect(columnsForTable(deps, "Sales")).toEqual(["Amount"]);
      expect(columnsForTable(deps, "DimCust")).toEqual(["Segment"]);
      // Plain (unqualified) references are considered a match for any table
      // because their table is unknown — honest, unspecific.
      expect(columnsForTable(deps, "Anything")).toEqual(["Tax"]);
    });
  });
});
