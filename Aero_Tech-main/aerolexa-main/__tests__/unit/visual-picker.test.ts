/**
 * Oracle tests for the dashboard visual picker.
 *
 * The PBI visual kinds (waterfall, funnel, sankey, treemap, sunburst, gauge,
 * heatmap, boxplot, ribbon, pareto) become dashboard tiles via pure spec
 * builders — hand-computed expectations on a fixed source chart, matching
 * what Power BI would derive for the same input.
 */
import {
  buildMapSpec,
  buildPbiSpec,
  detectMapScope,
  isPbiVisualKind,
  isVisualPickerKind,
  VISUAL_PICKER_OPTIONS,
} from "@/lib/engine/visual-picker";
import type { ChartSpec } from "@/lib/types";

const sourceChart: ChartSpec = {
  kind: "bar",
  title: "Revenue by region",
  xLabel: "region",
  yLabel: "revenue",
  categories: ["East", "West", "North", "South"],
  series: [{ name: "revenue", data: [120, 80, 60, 40], color: "#5AA8AA" }],
};

const source: { title: string; chart: ChartSpec } = { title: "Revenue by region", chart: sourceChart };

describe("visual picker — kinds and guards", () => {
  it("exposes the ten PBI visual kinds plus the Leaflet map in the picker", () => {
    expect(VISUAL_PICKER_OPTIONS).toHaveLength(11);
    expect(VISUAL_PICKER_OPTIONS.filter((o) => o.kind !== "map").every((o) => isPbiVisualKind(o.kind))).toBe(true);
    expect(VISUAL_PICKER_OPTIONS.every((o) => isVisualPickerKind(o.kind))).toBe(true);
    expect(VISUAL_PICKER_OPTIONS.find((o) => o.kind === "map")?.label).toBe("Filled map");
  });

  it("detectMapScope picks US-states only on a majority of state names", () => {
    expect(detectMapScope(["Texas", "California", "Ohio"])).toBe("us-states");
    expect(detectMapScope(["Texas", "France", "Ohio"])).toBe("countries");
    expect(detectMapScope(["India", "Brazil", "Kenya"])).toBe("countries");
  });

  it("buildMapSpec returns a map payload with the source values verbatim", () => {
    const spec = buildMapSpec(source);
    expect(spec.kind).toBe("map");
    expect(spec.categories).toEqual(["East", "West", "North", "South"]);
    expect(spec.values).toEqual([120, 80, 60, 40]);
  });

  it("rejects non-numeric series honestly", () => {
    const texty: ChartSpec = {
      ...sourceChart,
      series: [{ name: "region", data: ["a", "b", null, "d"] as unknown as (number | null)[], color: "#5AA8AA" }],
    };
    expect(() => buildPbiSpec("treemap", { title: "t", chart: texty })).toThrow(/Non-numeric value at position 1/);
  });

  it("throws when the source chart has no series", () => {
    expect(() => buildPbiSpec("treemap", { title: "t", chart: { ...sourceChart, series: [] } })).toThrow(
      /no data series/,
    );
  });
});

describe("visual picker — hand-computed specs", () => {
  it("waterfall: deltas between consecutive categories (120,80,60,40 → −40,−20,−20)", () => {
    const spec = buildPbiSpec("waterfall", source);
    expect(spec.values).toEqual([-40, -20, -20]);
    expect(spec.categories).toEqual(["West", "North", "South"]);
  });

  it("funnel: descending steps with categories reordered to match", () => {
    const spec = buildPbiSpec("funnel", source);
    expect(spec.values).toEqual([120, 80, 60, 40]);
    expect(spec.categories).toEqual(["East", "West", "North", "South"]);
  });

  it("pareto: descending bars + cumulative % line (120/300 = 40%, then 66.7%, 86.7%, 100%)", () => {
    const spec = buildPbiSpec("pareto", source);
    expect(spec.values).toEqual([120, 80, 60, 40]);
    expect(spec.series?.[0]?.name).toBe("Cumulative %");
    const cum = spec.series?.[0]?.values ?? [];
    expect(cum[0]).toBeCloseTo(40, 6);
    expect(cum[1]).toBeCloseTo(66.6667, 3);
    expect(cum[2]).toBeCloseTo(86.6667, 3);
    expect(cum[3]).toBeCloseTo(100, 6);
  });

  it("treemap/sunburst: categories + values verbatim (share of total)", () => {
    const tree = buildPbiSpec("treemap", source);
    expect(tree.values).toEqual([120, 80, 60, 40]);
    const sun = buildPbiSpec("sunburst", source);
    expect(sun.categories).toEqual(["East", "West", "North", "South"]);
  });

  it("gauge: value = last observation, max = series max, target = mean", () => {
    const spec = buildPbiSpec("gauge", source);
    expect(spec.gauge?.value).toBe(40);
    expect(spec.gauge?.max).toBe(120);
    expect(spec.gauge?.target).toBe(75); // (120+80+60+40)/4
  });

  it("ribbon: layers from every series of the source chart", () => {
    const two: ChartSpec = {
      ...sourceChart,
      series: [
        { name: "2025", data: [10, 20, 30], color: "#5AA8AA" },
        { name: "2026", data: [15, 25, 35], color: "#FFB400" },
      ],
    };
    const spec = buildPbiSpec("ribbon", { title: "t", chart: two });
    expect(spec.series).toHaveLength(1); // extra series beyond the primary
    expect(spec.series?.[0]?.name).toBe("2026");
    expect(spec.series?.[0]?.values).toEqual([15, 25, 35]);
  });

  it("sankey: flows from each category into the Total node", () => {
    const spec = buildPbiSpec("sankey", source);
    expect(spec.links).toHaveLength(4);
    expect(spec.links?.[0]).toEqual({ source: "East", target: "Total", value: 120 });
  });

  it("heatmap: needs two series and derives an x×y grid", () => {
    const two: ChartSpec = {
      ...sourceChart,
      categories: ["Q1", "Q2"],
      series: [
        { name: "2025", data: [10, 20], color: "#5AA8AA" },
        { name: "2026", data: [15, 25], color: "#FFB400" },
      ],
    };
    const spec = buildPbiSpec("heatmap", { title: "t", chart: two });
    expect(spec.heat?.yCategories).toEqual(["2026"]);
    expect(spec.heat?.cells).toEqual([
      [0, 0, 15],
      [1, 0, 25],
    ]);
    // One series only → honest error, not a wrong visual.
    expect(() => buildPbiSpec("heatmap", source)).toThrow(/needs two dimensions/);
  });

  it("boxplot: per-group raw values from multiple series", () => {
    const two: ChartSpec = {
      ...sourceChart,
      series: [
        { name: "control", data: [1, 2, 3, 4], color: "#5AA8AA" },
        { name: "treatment", data: [2, 3, 4, 9], color: "#FFB400" },
      ],
    };
    const spec = buildPbiSpec("boxplot", { title: "t", chart: two });
    expect(spec.boxGroups).toHaveLength(2);
    expect(spec.boxGroups?.[0]).toEqual({ name: "control", values: [1, 2, 3, 4] });
    expect(spec.boxGroups?.[1]?.values).toEqual([2, 3, 4, 9]);
    expect(() => buildPbiSpec("boxplot", source)).toThrow(/needs raw per-group values/);
  });
});
