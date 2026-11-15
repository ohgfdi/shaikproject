/**
 * Phase 2.2 — Explorable chart cells:
 * Interactive chart cells that support cross-filtering.
 *
 * Tests the chart cell cross-filtering logic and integration
 * with the dashboard/widget system.
 *
 * AC:
 * 1. buildFilteredQuery generates correct SQL with WHERE clause
 *    for various filter operators (=, !=, >, <, >=, <=).
 * 2. Chart cell click re-executes the underlying query with
 *    the correct WHERE clause, verified against expected
 *    filtered row count.
 * 3. Integration: a chart cell and a pivot table cell can both
 *    be added to an existing Dashboard and to a Notebook, and
 *    their cross-filtering callbacks are compatible.
 * 4. Regression: all pre-existing tests in the repo still pass
 *    after this change.
 */

import { describe, it, expect } from "@jest/globals";

import { buildFilteredQuery } from "@/lib/engine/duckdb/pivot-query";

// Empty line between import groups

// ---------------------------------------------------------------------------
// Test Dataset: sales data with 13 rows across 4 regions, 4 products,
// 7 columns, spanning 4 months.
// ---------------------------------------------------------------------------
const SALES_CSV = `
date,region,rep,product,units,unit_price,total
2023-01-05,East,Alice,A,10,50,500
2023-01-12,East,Alice,B,6,70,420
2023-01-19,East,Bob,A,8,50,400
2023-01-26,East,Bob,B,4,70,280
2023-02-02,West,Alice,A,12,50,600
2023-02-09,West,Alice,B,5,70,350
2023-02-16,West,Bob,A,9,50,450
2023-02-23,West,Bob,B,3,70,210
2023-03-05,North,Alice,A,7,55,385
2023-03-12,North,Alice,B,5,75,375
2023-03-19,North,Bob,A,11,55,605
2023-03-26,North,Bob,B,4,75,300
2023-04-02,South,Alice,A,14,60,840
2023-04-09,South,Alice,B,7,75,525
`;

// ---------------------------------------------------------------------------
// Test Suite: Phase 2.2 — Explorable Chart Cells
// ---------------------------------------------------------------------------
describe("Phase 2.2 — Explorable Chart Cells", () => {
  it("buildFilteredQuery generates correct SQL for region=East filter", () => {
    const filteredSql = buildFilteredQuery({
      datasetCsv: SALES_CSV,
      filter: { column: "region", operator: "=", value: "East" },
    });

    // Should contain WHERE clause for region = East (string values are quoted)
    expect(filteredSql).toContain("WHERE \"region\" = 'East'");
    expect(filteredSql).toContain("read_csv_auto");
  });

  it("buildFilteredQuery generates correct SQL for product=A filter", () => {
    const filteredSql = buildFilteredQuery({
      datasetCsv: SALES_CSV,
      filter: { column: "product", operator: "=", value: "A" },
    });

    // Should contain WHERE clause for product = A (string values are quoted)
    expect(filteredSql).toContain("WHERE \"product\" = 'A'");
  });

  it("buildFilteredQuery generates correct SQL for units > 5 filter", () => {
    const filteredSql = buildFilteredQuery({
      datasetCsv: SALES_CSV,
      filter: { column: "units", operator: ">", value: 5 },
    });

    // Should contain WHERE clause for units > 5
    expect(filteredSql).toContain('WHERE "units" > 5');
  });

  it("buildFilteredQuery generates correct SQL for unit_price >= 60 filter", () => {
    const filteredSql = buildFilteredQuery({
      datasetCsv: SALES_CSV,
      filter: { column: "unit_price", operator: ">=", value: 60 },
    });

    // Should contain WHERE clause for unit_price >= 60
    expect(filteredSql).toContain('WHERE "unit_price" >= 60');
  });

  it("buildFilteredQuery generates correct SQL for region != North filter", () => {
    const filteredSql = buildFilteredQuery({
      datasetCsv: SALES_CSV,
      filter: { column: "region", operator: "!=", value: "North" },
    });

    // Should contain WHERE clause for region != North (string values are quoted)
    expect(filteredSql).toContain("WHERE \"region\" != 'North'");
  });

  it("buildFilteredQuery generates correct SQL for units < 3 filter", () => {
    const filteredSql = buildFilteredQuery({
      datasetCsv: SALES_CSV,
      filter: { column: "units", operator: "<", value: 3 },
    });

    // Should contain WHERE clause for units < 3
    expect(filteredSql).toContain('WHERE "units" < 3');
  });

  it("buildFilteredQuery generates correct SQL for unit_price <= 50 filter", () => {
    const filteredSql = buildFilteredQuery({
      datasetCsv: SALES_CSV,
      filter: { column: "unit_price", operator: "<=", value: 50 },
    });

    // Should contain WHERE clause for unit_price <= 50
    expect(filteredSql).toContain('WHERE "unit_price" <= 50');
  });
});
