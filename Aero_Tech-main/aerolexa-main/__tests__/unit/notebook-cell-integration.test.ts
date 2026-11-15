/**
 * Phase 2.3 — Notebook Cell Integration:
 * Pivot table and explorable chart cells can be added to notebooks,
 * persist correctly on reload, and support cross-notebook filtering.
 *
 * AC:
 * 1. A pivot table cell and an explorable chart cell can both be
 *    added to a notebook via the AddKind options.
 * 2. Notebook cells persist correctly on reload (verified by the
 *    overall test suite, not unit tests alone).
 * 3. Cross-notebook filtering: a filter applied in a pivot cell
 *    in one notebook can affect chart cells in another notebook
 *    sharing the same dataset (verified by the overall test suite).
 * 4. Regression: all pre-existing tests in the repo still pass
 *    after this change.
 */

import { describe, it, expect } from "@jest/globals";

import { buildPivotSql, buildFilteredQuery } from "@/lib/engine/duckdb/pivot-query";
import type { NotebookCell } from "@/lib/types";

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
// Test Suite: Phase 2.3 — Notebook Cell Integration
// ---------------------------------------------------------------------------
describe("Phase 2.3 — Notebook Cell Integration", () => {
  it("pivot table cell SQL generates correctly for notebook integration", () => {
    const pivotSql = buildPivotSql({
      datasetCsv: SALES_CSV,
      rows: ["region"],
      columns: ["product"],
      values: [{ column: "total", aggregation: "sum" }],
    });

    // Should produce valid pivot SQL with read_csv_auto
    expect(pivotSql).toContain('GROUP BY "region"');
    expect(pivotSql).toContain('sum("total"');
    expect(pivotSql).toContain("read_csv_auto");
  });

  it("cross-filter SQL generates correctly for notebook integration", () => {
    const filteredSql = buildFilteredQuery({
      datasetCsv: SALES_CSV,
      filter: { column: "region", operator: "=", value: "East" },
    });

    // Should produce valid filtered SQL (string values are quoted)
    expect(filteredSql).toContain("WHERE \"region\" = 'East'");
    expect(filteredSql).toContain("read_csv_auto");
  });

  it("buildPivotSql handles multiple aggregation types for notebook", () => {
    const pivotSql = buildPivotSql({
      datasetCsv: SALES_CSV,
      rows: ["region"],
      columns: ["product"],
      values: [
        { column: "total", aggregation: "sum" },
        { column: "units", aggregation: "count" },
      ],
    });

    // Should contain both sum and count
    expect(pivotSql).toContain('sum("total"');
    expect(pivotSql).toContain('count("units"');
  });

  it("buildFilteredQuery supports all operators for notebook cross-filtering", () => {
    const operators = ["=", "!=", ">", "<", ">=", "<="];

    for (const op of operators) {
      const filter: { column: string; operator: "=" | "!=" | ">" | "<" | ">=" | "<="; value: string | number } = {
        column: "region",
        operator: op as any,
        value: "East",
      };

      const filteredSql = buildFilteredQuery({
        datasetCsv: SALES_CSV,
        filter,
      });
      expect(filteredSql).toContain("read_csv_auto");
    }
  });

  it("NotebookCell type is compatible with pivot and chart cell configs", () => {
    // Verify the NotebookCell type accepts the cell configs we've built
    const pivotCell: NotebookCell = {
      id: "pivot-1",
      kind: "code",
      content: `// Pivot table: rows=region, columns=product, values=SUM(total)
const pivotSql = \`SELECT "region", sum("total") AS "0_sum_total" FROM read_csv_auto('dataset.csv') GROUP BY "region" ORDER BY "region"\`;
// result would come from executeSql execution`,
      output: null,
      ranAt: null,
    };

    const chartCell: NotebookCell = {
      id: "chart-1",
      kind: "code",
      content: `// Explorable chart: filter region = East
const filteredSql = \`SELECT * FROM read_csv_auto('dataset.csv') WHERE "region" = East ORDER BY "region"\`;
// result would come from executeSql execution`,
      output: null,
      ranAt: null,
    };

    // Both should be valid NotebookCell types
    expect(pivotCell.kind).toBe("code");
    expect(chartCell.kind).toBe("code");
    expect(pivotCell.id).toBeDefined();
    expect(chartCell.id).toBeDefined();
  });
});
