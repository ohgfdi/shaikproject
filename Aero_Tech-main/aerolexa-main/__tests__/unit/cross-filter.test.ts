import {
  applyCrossFilters,
  buildDrillThrough,
  filterChartSpec,
  filterPbiSpec,
  filterTableSpec,
  toggleSelection,
  widgetCategories,
} from "@/lib/engine/cross-filter";
import type { CrossFilterSelection } from "@/lib/engine/cross-filter";
import type { ChartSpec, DashboardWidget, TableSpec } from "@/lib/types";

/**
 * Hand-computed oracle tests for dashboard cross-filtering.
 * Every expected count/value follows from the tiny fixtures below.
 */

const chart: ChartSpec = {
  kind: "bar",
  title: "Sales by region",
  categories: ["East", "West", "North"],
  series: [{ name: "Amount", data: [500, 800, 0] }],
};

const table: TableSpec = {
  title: "Detail",
  columns: [
    { key: "region", label: "Region" },
    { key: "amount", label: "Amount", format: "number" },
  ],
  rows: [
    ["East", 100],
    ["West", 300],
    ["East", 50],
    ["North", 400],
  ],
};

const sel = (over: Partial<CrossFilterSelection> = {}): CrossFilterSelection => ({
  column: "Region",
  values: ["East"],
  sourceWidgetId: "w1",
  sourceWidgetTitle: "Sales by region",
  ...over,
});

const chartWidget: DashboardWidget = {
  id: "w1",
  type: "chart",
  title: "Sales by region",
  w: 6,
  h: 4,
  chart,
};
const tableWidget: DashboardWidget = {
  id: "w2",
  type: "table",
  title: "Detail",
  w: 6,
  h: 4,
  table,
};
const pbiWidget: DashboardWidget = {
  id: "w3",
  type: "pbi-visual",
  title: "Pareto regions",
  w: 6,
  h: 4,
  pbiVisual: {
    kind: "pareto",
    title: "Pareto regions",
    categories: ["East", "West", "North"],
    values: [500, 800, 0],
    series: [{ name: "cumulative", values: [500, 1300, 1300] }],
  },
};

describe("cross-filter — toggleSelection (Power BI click semantics)", () => {
  test("clicking a value selects it", () => {
    const s = toggleSelection([], sel());
    expect(s).toHaveLength(1);
    expect(s[0]!.values).toEqual(["East"]);
  });

  test("clicking the same value again clears it", () => {
    const s = toggleSelection([sel()], sel());
    expect(s).toHaveLength(0);
  });

  test("clicking another value in the same column adds it", () => {
    const s = toggleSelection([sel()], sel({ values: ["West"] }));
    expect(s[0]!.values).toEqual(["East", "West"]);
  });

  test("clicking a selected value removes just that value", () => {
    const s = toggleSelection([sel({ values: ["East", "West"] })], sel({ values: ["West"] }));
    expect(s[0]!.values).toEqual(["East"]);
  });

  test("selections from different sources coexist", () => {
    const s = toggleSelection([sel()], sel({ sourceWidgetId: "w9", column: "Product", values: ["A"] }));
    expect(s).toHaveLength(2);
  });
});

describe("cross-filter — chart filtering", () => {
  test("keeps only the selected categories and aligned values", () => {
    const out = filterChartSpec(chart, [sel()]);
    expect(out.categories).toEqual(["East"]);
    expect(out.series[0]!.data).toEqual([500]);
  });

  test("multiple selections act as a union on the same column", () => {
    const out = filterChartSpec(chart, [sel({ values: ["East", "North"] })]);
    expect(out.categories).toEqual(["East", "North"]);
    expect(out.series[0]!.data).toEqual([500, 0]);
  });

  test("empty selections return the spec untouched", () => {
    expect(filterChartSpec(chart, [])).toBe(chart);
  });

  test("original spec is never mutated", () => {
    filterChartSpec(chart, [sel()]);
    expect(chart.categories).toEqual(["East", "West", "North"]);
    expect(chart.series[0]!.data).toEqual([500, 800, 0]);
  });
});

describe("cross-filter — table filtering", () => {
  test("keeps only rows whose column value is selected", () => {
    const out = filterTableSpec(table, [sel()]);
    expect(out.rows).toEqual([
      ["East", 100],
      ["East", 50],
    ]);
  });

  test("a selection column absent from the table is ignored", () => {
    const out = filterTableSpec(table, [sel({ column: "Product", values: ["A"] })]);
    expect(out.rows).toEqual(table.rows);
  });

  test("selections on different columns AND together", () => {
    const withProduct: TableSpec = {
      ...table,
      columns: [...table.columns, { key: "product", label: "Product" }],
      rows: [
        ["East", 100, "A"],
        ["West", 300, "B"],
        ["East", 50, "B"],
        ["North", 400, "A"],
      ],
    };
    const out = filterTableSpec(withProduct, [sel(), sel({ column: "Product", values: ["B"] })]);
    expect(out.rows).toEqual([["East", 50, "B"]]);
  });
});

describe("cross-filter — PBI visual filtering", () => {
  test("filters categories, values AND aligned extra series", () => {
    const out = filterPbiSpec(pbiWidget.pbiVisual!, [sel()]);
    expect(out.categories).toEqual(["East"]);
    expect(out.values).toEqual([500]);
    expect(out.series![0]!.values).toEqual([500]);
  });

  test("boxplot groups filter by name", () => {
    const spec = {
      kind: "boxplot" as const,
      categories: [],
      values: [],
      boxGroups: [
        { name: "East", values: [1, 2] },
        { name: "West", values: [3] },
      ],
    };
    const out = filterPbiSpec(spec, [sel()]);
    expect(out.boxGroups).toHaveLength(1);
    expect(out.boxGroups![0]!.name).toBe("East");
  });
});

describe("cross-filter — applyCrossFilters across widgets", () => {
  test("filters every widget except the selection source", () => {
    const widgets = [chartWidget, tableWidget, pbiWidget];
    const out = applyCrossFilters(widgets, [sel({ sourceWidgetId: "w1" })]);
    // Source unchanged (its own click does not filter itself):
    expect(out[0]!.chart).toBe(chart);
    // Table widget filtered to East rows:
    expect(out[1]!.table!.rows).toEqual([
      ["East", 100],
      ["East", 50],
    ]);
    // PBI widget filtered:
    expect(out[2]!.pbiVisual!.categories).toEqual(["East"]);
  });

  test("no selections → identity", () => {
    const widgets = [chartWidget, tableWidget];
    expect(applyCrossFilters(widgets, [])).toBe(widgets);
  });
});

describe("cross-filter — widgetCategories extraction", () => {
  test("chart: xLabel preferred as the column", () => {
    const spec: ChartSpec = { ...chart, xLabel: "Region" };
    const w: DashboardWidget = { ...chartWidget, chart: spec };
    expect(widgetCategories(w)).toEqual({ column: "Region", values: ["East", "West", "North"] });
  });

  test("table: first column label + values", () => {
    expect(widgetCategories(tableWidget)).toEqual({ column: "Region", values: ["East", "West", "East", "North"] });
  });
});

describe("cross-filter — drill-through", () => {
  test("table widget: returns the matching detail rows", () => {
    const d = buildDrillThrough(tableWidget, "East", "Region");
    expect(d).not.toBeNull();
    expect(d!.rows).toEqual([
      ["East", 100],
      ["East", 50],
    ]);
    expect(d!.columns.map((c) => c.label)).toEqual(["Region", "Amount"]);
    expect(d!.totalRows).toBe(2);
  });

  test("chart widget: honest per-series detail for the clicked category", () => {
    const d = buildDrillThrough(chartWidget, "West");
    expect(d).not.toBeNull();
    expect(d!.rows).toEqual([["Amount", 800]]);
    expect(d!.title).toContain("West");
  });

  test("returns null for an unknown value", () => {
    expect(buildDrillThrough(chartWidget, "Southpole")).toBeNull();
  });

  test("pbi visual: value + extra series", () => {
    const d = buildDrillThrough(pbiWidget, "East");
    expect(d!.rows).toEqual([
      ["Value", 500],
      ["cumulative", 500],
    ]);
  });
});
