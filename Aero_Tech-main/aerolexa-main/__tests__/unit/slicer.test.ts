/**
 * Oracle tests for the dashboard slicer engine (lib/engine/slicer.ts).
 *
 * Every expectation is hand-computed: the slicer derives its values from REAL
 * widget snapshots, projects its selection into the cross-filter selection
 * set, and composes with applyCrossFilters exactly like a clicked tile.
 * Power BI semantics: single-select replaces, multi-select toggles, empty
 * selection filters nothing.
 */

import { applyCrossFilters, type CrossFilterSelection } from "@/lib/engine/cross-filter";
import {
  buildSlicer,
  distinctValuesForColumn,
  initialSlicerState,
  restoreSlicerSelection,
  slicerSelection,
  toggleSlicerValue,
} from "@/lib/engine/slicer";
import type { DashboardWidget } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fixtures — real widget snapshots (no fabrication)
// ---------------------------------------------------------------------------

const chartWidget: DashboardWidget = {
  id: "w-chart",
  type: "chart",
  title: "Sales by Region",
  w: 6,
  h: 4,
  chart: {
    kind: "bar",
    title: "Sales by Region",
    xLabel: "Region",
    categories: ["East", "West", "East", "South"],
    series: [{ name: "Sales", data: [100, 200, 50, 75] }],
  },
};

const tableWidget: DashboardWidget = {
  id: "w-table",
  type: "table",
  title: "Detail",
  w: 6,
  h: 4,
  table: {
    title: "Detail",
    columns: [
      { key: "region", label: "Region" },
      { key: "amount", label: "Amount" },
    ],
    rows: [
      ["East", 100],
      ["West", 200],
      ["South", 75],
      ["", 10], // empty cell is never offered as a slicer value
    ],
  },
};

const pbiWidget: DashboardWidget = {
  id: "w-pbi",
  type: "pbi-visual",
  title: "Sales by Region · treemap",
  w: 6,
  h: 4,
  pbiVisual: {
    kind: "treemap",
    title: "Sales by Region",
    categories: ["North"],
    values: [30],
  },
};

describe("distinctValuesForColumn", () => {
  it("collects distinct values in first-seen order across chart categories", () => {
    // chart carries East, West, East, South → East, West, South (dup dropped)
    expect(distinctValuesForColumn([chartWidget], "Region")).toEqual(["East", "West", "South"]);
  });

  it("matches by table column label and drops empty cells", () => {
    expect(distinctValuesForColumn([tableWidget], "Region")).toEqual(["East", "West", "South"]);
  });

  it("falls back to the widget title when no column metadata exists (pbi visual)", () => {
    expect(distinctValuesForColumn([pbiWidget], "Sales by Region · treemap")).toEqual(["North"]);
  });

  it("never sources values from another slicer", () => {
    const slicerWidget: DashboardWidget = {
      id: "w-slicer",
      type: "slicer",
      title: "Slicer · Region",
      w: 3,
      h: 4,
      slicer: { column: "Region", values: ["Phantom"] },
    };
    expect(distinctValuesForColumn([slicerWidget, chartWidget], "Region")).toEqual(["East", "West", "South"]);
  });

  it("returns [] when no widget carries the column", () => {
    expect(distinctValuesForColumn([chartWidget], "Product")).toEqual([]);
  });
});

describe("toggleSlicerValue", () => {
  it("single-select replaces and re-click clears", () => {
    expect(toggleSlicerValue([], "East", false)).toEqual(["East"]);
    expect(toggleSlicerValue(["East"], "West", false)).toEqual(["West"]);
    expect(toggleSlicerValue(["West"], "West", false)).toEqual([]);
  });

  it("multi-select toggles values in the set", () => {
    let s = toggleSlicerValue([], "East", true);
    expect(s).toEqual(["East"]);
    s = toggleSlicerValue(s, "West", true);
    expect(s).toEqual(["East", "West"]);
    s = toggleSlicerValue(s, "East", true);
    expect(s).toEqual(["West"]);
  });
});

describe("slicerSelection", () => {
  const base: CrossFilterSelection[] = [
    { column: "Region", values: ["East"], sourceWidgetId: "w-chart", sourceWidgetTitle: "Sales by Region" },
  ];

  it("projects the slicer's selection as a selection entry", () => {
    const out = slicerSelection({ slicerWidgetId: "w-slicer", column: "Region", selected: ["West"] }, base);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      column: "Region",
      values: ["West"],
      sourceWidgetId: "w-slicer",
      sourceWidgetTitle: "Slicer",
    });
  });

  it("replaces its own contribution idempotently (never duplicates)", () => {
    const first = slicerSelection({ slicerWidgetId: "w-slicer", column: "Region", selected: ["West"] }, base);
    const second = slicerSelection(
      { slicerWidgetId: "w-slicer", column: "Region", selected: ["West", "South"] },
      first,
    );
    const mine = second.filter((s) => s.sourceWidgetId === "w-slicer");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.values).toEqual(["West", "South"]);
  });

  it("empty selection filters nothing (removes its contribution)", () => {
    const withSlicer = slicerSelection({ slicerWidgetId: "w-slicer", column: "Region", selected: ["West"] }, base);
    const cleared = slicerSelection({ slicerWidgetId: "w-slicer", column: "Region", selected: [] }, withSlicer);
    expect(cleared).toEqual(base);
  });
});

describe("buildSlicer", () => {
  it("derives real values and honours the options", () => {
    const spec = buildSlicer("w-slicer", "Region", [chartWidget, tableWidget], {
      style: "dropdown",
      multiSelect: false,
    });
    expect(spec).toEqual({
      column: "Region",
      values: ["East", "West", "South"],
      style: "dropdown",
      multiSelect: false,
    });
  });

  it("throws with an actionable message when no source carries the column", () => {
    expect(() => buildSlicer("w-slicer", "Product", [chartWidget])).toThrow(/Product/);
  });
});

describe("initialSlicerState / restoreSlicerSelection", () => {
  const spec = buildSlicer("w-slicer", "Region", [chartWidget]);

  it("initial state selects nothing", () => {
    expect(initialSlicerState(spec, "w-slicer")).toEqual({
      slicerWidgetId: "w-slicer",
      column: "Region",
      selected: [],
    });
  });

  it("restores a saved selection from the dashboard JSON", () => {
    const saved = [{ column: "Region", values: ["East", "South"], sourceWidgetId: "w-slicer" }];
    expect(restoreSlicerSelection(spec, "w-slicer", saved).selected).toEqual(["East", "South"]);
  });

  it("drops stale values that no longer exist in the slicer list", () => {
    const saved = [{ column: "Region", values: ["East", "Atlantis"], sourceWidgetId: "w-slicer" }];
    expect(restoreSlicerSelection(spec, "w-slicer", saved).selected).toEqual(["East"]);
  });

  it("ignores other widgets' saved filters", () => {
    const saved = [{ column: "Region", values: ["East"], sourceWidgetId: "w-other" }];
    expect(restoreSlicerSelection(spec, "w-slicer", saved).selected).toEqual([]);
  });
});

describe("composition with applyCrossFilters (Power BI end-to-end)", () => {
  // Unique-category chart so the expected filtered shape is unambiguous.
  const uniqueChart: DashboardWidget = {
    id: "w-chart-u",
    type: "chart",
    title: "Sales by Region",
    w: 6,
    h: 4,
    chart: {
      kind: "bar",
      title: "Sales by Region",
      xLabel: "Region",
      categories: ["East", "West", "South"],
      series: [{ name: "Sales", data: [100, 200, 75] }],
    },
  };
  const widgets = [uniqueChart, tableWidget, pbiWidget];

  it("a slicer selection filters other tiles like a clicked tile", () => {
    const selections = slicerSelection({ slicerWidgetId: "w-slicer", column: "Region", selected: ["East"] }, []);
    const out = applyCrossFilters(widgets, selections);
    // Source slicer is not on the canvas list — all tiles filter:
    expect(out[0]!.chart!.categories).toEqual(["East"]);
    expect(out[0]!.chart!.series[0]!.data).toEqual([100]);
    expect(out[1]!.table!.rows).toEqual([["East", 100]]);
  });

  it("an empty slicer selection leaves every tile untouched", () => {
    const selections = slicerSelection({ slicerWidgetId: "w-slicer", column: "Region", selected: [] }, []);
    expect(applyCrossFilters(widgets, selections)).toEqual(widgets);
  });
});
