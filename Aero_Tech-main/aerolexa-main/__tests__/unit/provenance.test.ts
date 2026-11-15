/**
 * Figure→row provenance tests — hand-computed oracles (the repo's rule).
 * Every expected value below is computed by hand from the fixture rows.
 */

import { aggregationFor, figureProvenance, verifyFigureValue } from "@/lib/provenance";
import type { ChartSpec, ColumnDef } from "@/lib/types";

// Fixture: a sales dataset with a region dimension and a revenue measure.
const COLUMNS: Pick<ColumnDef, "name" | "type">[] = [
  { name: "region", type: "string" },
  { name: "revenue", type: "number" },
  { name: "units", type: "number" },
];

const ROWS: Record<string, string | number | null>[] = [
  { region: "East", revenue: 100, units: 2 },
  { region: "East", revenue: 50, units: 1 },
  { region: "West", revenue: 200, units: 4 },
  { region: "North", revenue: null, units: 3 }, // null revenue must not break sums
  { region: "West", revenue: 25, units: 1 },
];

const BAR_SPEC: ChartSpec = {
  kind: "bar",
  title: "Revenue by region",
  xLabel: "region",
  yLabel: "revenue",
  series: [{ name: "revenue", data: [150, 225, 0] }],
  categories: ["East", "West", "North"],
};

describe("figure→row provenance (hand-computed)", () => {
  it("detects the aggregation from the spec (SUM of the measure)", () => {
    const agg = aggregationFor(BAR_SPEC);
    expect(agg.fn).toBe("sum");
    expect(agg.column).toBe("revenue");
  });

  it("selects exactly the rows behind the East bar (100 + 50 = 150)", () => {
    const prov = figureProvenance(BAR_SPEC, "revenue", "East", COLUMNS, ROWS);
    expect(prov.filter.groupColumn).toBe("region");
    expect(prov.filter.groupValue).toBe("East");
    expect(prov.rows).toHaveLength(2);
    expect(prov.rowCount).toBe(2);
    // Verify the rendered 150 reproduces from the source rows:
    expect(verifyFigureValue(prov, 150)).toBe(true);
    // …and a wrong value does not:
    expect(verifyFigureValue(prov, 151)).toBe(false);
  });

  it("handles West with two contributing rows (200 + 25 = 225)", () => {
    const prov = figureProvenance(BAR_SPEC, "revenue", "West", COLUMNS, ROWS);
    expect(prov.rows).toHaveLength(2);
    expect(verifyFigureValue(prov, 225)).toBe(true);
  });

  it("sums non-numeric (null) contributions as missing, not zero-poisoned (North → 0 from 0 numeric rows)", () => {
    const prov = figureProvenance(BAR_SPEC, "revenue", "North", COLUMNS, ROWS);
    expect(prov.rows).toHaveLength(1); // the row matched on region
    // The single matched row has a null revenue, so no numeric values feed the
    // sum; the recomputed total is 0, which matches the engine's 0.
    expect(verifyFigureValue(prov, 0)).toBe(true);
  });

  it("reports honestly when the row store is unavailable (no invented counts)", () => {
    const prov = figureProvenance(BAR_SPEC, "revenue", "East", COLUMNS, null);
    expect(prov.rows).toBeNull();
    expect(prov.rowCount).toBe(0); // never a fabricated count
    expect(verifyFigureValue(prov, 150)).toBeNull(); // verdict: cannot verify
    expect(prov.summary).toMatch(/unavailable/);
  });

  it("falls back to the first string column when xLabel is not a dataset column", () => {
    const spec: ChartSpec = { ...BAR_SPEC, xLabel: "not-a-column" };
    const prov = figureProvenance(spec, "revenue", "East", COLUMNS, ROWS);
    expect(prov.filter.groupColumn).toBe("region");
    expect(prov.rows).toHaveLength(2);
  });

  it("supports count aggregation verification (KPI count)", () => {
    const spec: ChartSpec = {
      kind: "kpi",
      title: "Transactions",
      series: [],
      kpis: [{ label: "Rows", value: "5", kind: "count" }],
    };
    const agg = aggregationFor(spec);
    expect(agg.fn).toBe("count");
    const prov = figureProvenance(spec, "count", "all", COLUMNS, ROWS);
    expect(prov.rowCount).toBe(5);
    expect(verifyFigureValue(prov, 5)).toBe(true);
  });
});
