/**
 * Regression gate for the headless-Chromium renderer.
 *
 * `lib/server/visual-render.ts` previously had NO test coverage at all, which
 * is how the following survived: an `escapeHtml` that replaced `&`/`<`/`>`
 * with themselves (making any dashboard title executable in the render
 * context), a `w.spec` read that never existed (tables 500'd, charts rendered
 * blank), a raw `ChartSpec` handed to `echarts.setOption`, and three widget
 * types that fell through to "not yet supported" — all returning HTTP 200.
 *
 * These tests exercise the pure adapter + mapper layer, so a payload mismatch
 * fails here instead of producing a plausible-looking empty PNG.
 */

import { chartSpecToECharts, isCanvasChartKind, isNonCanvasChartKind } from "@/lib/engine/chart-echarts";
import { PBI_CANVAS_KINDS, boxStats, pbiVisualToECharts } from "@/lib/engine/pbi-echarts";
import { dashboardLayout, widgetContainerSize, widgetToRenderPlan } from "@/lib/engine/widget-render-spec";
import { esc } from "@/lib/export/html";
import type { ChartSpec, DashboardWidget, PbiVisualSpec } from "@/lib/types";

/** Mirror of VisualRenderer.escapeHtml (which now delegates to `esc`). */
function escapeHtml(str: string): string {
  return esc(str).replace(/'/g, "&#039;");
}

describe("renderer escaping — the XSS gate", () => {
  it("escapes angle brackets so markup cannot execute in the render context", () => {
    const attack = "<img src=x onerror=alert(1)>";
    const out = escapeHtml(attack);
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
  });

  it("escapes script tags and quotes", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml('" onload="x')).not.toContain('"');
  });

  it("escapes ampersands before the other entities (no double-encoding)", () => {
    expect(esc("a & b")).toBe("a &amp; b");
    expect(esc("&lt;")).toBe("&amp;lt;");
  });

  it("never leaves a raw < or > from any interpolated user string", () => {
    const hostile = ["<b>x</b>", "</style><script>fetch('//evil')</script>", "<<>>", "a<b"];
    for (const raw of hostile) {
      expect(escapeHtml(raw)).not.toMatch(/[<>]/);
    }
  });
});

describe("chartSpecToECharts — chart/pivot must not render blank", () => {
  const bar: ChartSpec = {
    kind: "bar",
    title: "Revenue",
    categories: ["Q1", "Q2"],
    series: [{ name: "Rev", data: [10, 20] }],
  };

  it("produces axes AND a series type — the two things ECharts requires", () => {
    const option = chartSpecToECharts(bar)!;
    expect(option).not.toBeNull();
    expect(option.xAxis).toMatchObject({ type: "category" });
    expect(option.yAxis).toMatchObject({ type: "value" });
    const series = option.series as Array<{ type?: string; data: unknown[] }>;
    // The old code passed the raw ChartSpec: no `type` per series, no axes,
    // so ECharts drew an empty canvas.
    expect(series[0]!.type).toBe("bar");
    expect(series[0]!.data).toEqual([10, 20]);
  });

  it.each(["line", "area", "bar", "stacked-bar", "histogram"] as const)("maps %s", (kind) => {
    const option = chartSpecToECharts({ ...bar, kind } as ChartSpec);
    expect(option).not.toBeNull();
    expect((option!.series as unknown[]).length).toBeGreaterThan(0);
  });

  it("stacks stacked-bar series", () => {
    const option = chartSpecToECharts({
      ...bar,
      kind: "stacked-bar",
      series: [
        { name: "a", data: [1, 2] },
        { name: "b", data: [3, 4] },
      ],
    })!;
    const series = option.series as Array<{ stack?: string }>;
    expect(series.every((s) => s.stack === "total")).toBe(true);
  });

  it("renders donut as a pie ring aligned to categories", () => {
    const option = chartSpecToECharts({ ...bar, kind: "donut" })!;
    const series = option.series as Array<{ type: string; data: { name: string; value: unknown }[] }>;
    expect(series[0]!.type).toBe("pie");
    expect(series[0]!.data.map((d) => d.name)).toEqual(["Q1", "Q2"]);
  });

  it("renders pivot as a heatmap over rowLabels x categories", () => {
    const option = chartSpecToECharts({
      kind: "pivot",
      title: "Pivot",
      categories: ["c1", "c2"],
      rowLabels: ["r1", "r2"],
      series: [{ name: "v", data: [1, 2, 3, 4] }],
    })!;
    expect(option.visualMap).toBeDefined();
    const series = option.series as Array<{ type: string; data: unknown[][] }>;
    expect(series[0]!.type).toBe("heatmap");
    expect(series[0]!.data).toHaveLength(4);
  });

  it("shows a legend only for multi-series charts", () => {
    const one = chartSpecToECharts(bar)!;
    expect(one.legend).toBeUndefined();
    const two = chartSpecToECharts({
      ...bar,
      series: [
        { name: "a", data: [1, 2] },
        { name: "b", data: [3, 4] },
      ],
    })!;
    expect(two.legend).toBeDefined();
  });

  it("returns null for kinds with no canvas renderer, so the caller falls back", () => {
    for (const kind of ["kpi", "map", "decomposition-tree", "key-influencers"] as const) {
      expect(chartSpecToECharts({ ...bar, kind } as ChartSpec)).toBeNull();
      expect(isNonCanvasChartKind(kind)).toBe(true);
    }
  });

  it("returns null for a spec with no plottable data instead of an empty frame", () => {
    expect(chartSpecToECharts({ kind: "bar", title: "e", categories: [], series: [] })).toBeNull();
  });

  it("classifies canvas vs non-canvas kinds consistently", () => {
    expect(isCanvasChartKind("bar")).toBe(true);
    expect(isCanvasChartKind("kpi")).toBe(false);
    expect(isCanvasChartKind("nope")).toBe(false);
  });
});

describe("pbiVisualToECharts — all 10 kinds server-side", () => {
  const base: PbiVisualSpec = {
    kind: "funnel",
    categories: ["a", "b"],
    values: [3, 1],
  };

  it("builds an option for every declared canvas kind", () => {
    // Previously the server handled only boxplot + generic bar/line/area; the
    // other 8 produced an empty canvas at HTTP 200.
    for (const kind of PBI_CANVAS_KINDS) {
      const spec: PbiVisualSpec = {
        ...base,
        kind,
        ...(kind === "boxplot" ? { boxGroups: [{ name: "g", values: [1, 2, 3, 4] }] } : {}),
        ...(kind === "heatmap" ? { heat: { yCategories: ["r"], cells: [[0, 0, 5]] } } : {}),
        ...(kind === "sankey" ? { links: [{ source: "a", target: "b", value: 1 }] } : {}),
        ...(kind === "gauge" ? { gauge: { value: 5, max: 10 } } : {}),
      };
      const option = pbiVisualToECharts(spec);
      expect(option).not.toBeNull();
      expect((option!.series as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("computes pareto cumulative percentages on a second axis", () => {
    const option = pbiVisualToECharts({ ...base, kind: "pareto", values: [50, 30, 20] })!;
    const series = option.series as Array<{ yAxisIndex?: number; data: number[] }>;
    expect(series).toHaveLength(2);
    expect(series[1]!.yAxisIndex).toBe(1);
    // Cumulative shares of 50/30/20 => 50, 80, 100.
    expect(series[1]!.data).toEqual([50, 80, 100]);
  });

  it("returns null for an unknown kind", () => {
    expect(pbiVisualToECharts({ ...base, kind: "not-a-kind" as never })).toBeNull();
  });

  it("places waterfall bars on running totals via a transparent helper series", () => {
    const option = pbiVisualToECharts({ ...base, kind: "waterfall", values: [10, -4] })!;
    const series = option.series as Array<{ name: string; itemStyle?: { color?: string } }>;
    expect(series[0]!.name).toBe("base");
    expect(series[0]!.itemStyle?.color).toBe("transparent");
    expect(series[1]!.name).toBe("change");
  });

  it("computes Tukey five-number summaries for boxplot", () => {
    // n=5 => (n-1)*0.25 = 1.0 lands exactly on an element, so the quartiles are
    // the observed values (Tukey hinges).
    expect(boxStats([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]);
    // n=4 => position 2.25 interpolates: 4 + (8-4)*0.25 = 5.
    expect(boxStats([1, 2, 4, 8])).toEqual([1, 1.75, 3, 5, 8]);
    // Degenerate input must not produce NaN.
    expect(boxStats([])).toEqual([0, 0, 0, 0, 0]);
    expect(boxStats([5, 5, 5])).toEqual([5, 5, 5, 5, 5]);
    // Non-finite values are dropped rather than poisoning the sort.
    expect(boxStats([1, Number.NaN, 3])).toEqual([1, 1.5, 2, 2.5, 3]);
  });

  it("honours a reference line only on cartesian kinds", () => {
    const withLine = pbiVisualToECharts({
      ...base,
      kind: "boxplot",
      boxGroups: [{ name: "g", values: [1, 2] }],
      format: { referenceLine: { value: 10, label: "target" } },
    })!;
    const series = withLine.series as Array<{ markLine?: unknown }>;
    expect(series[0]!.markLine).toBeDefined();
  });
});

describe("widgetToRenderPlan — the missing adapter", () => {
  const widget = (over: Partial<DashboardWidget>): DashboardWidget =>
    ({ id: "w1", type: "text", title: "T", w: 6, h: 4, ...over }) as DashboardWidget;

  it("reads the chart payload from `chart`, not a non-existent `spec`", () => {
    const chart: ChartSpec = {
      kind: "bar",
      title: "R",
      categories: ["a"],
      series: [{ name: "s", data: [1] }],
    };
    const plan = widgetToRenderPlan(widget({ type: "chart", chart }));
    expect(plan.kind).toBe("chart");
    expect(plan.chart).toBe(chart);
  });

  it("reads the table payload so tables stop throwing on undefined", () => {
    const plan = widgetToRenderPlan(
      widget({ type: "table", table: { title: "T", columns: [{ key: "a", label: "A" }], rows: [[1]] } }),
    );
    expect(plan.kind).toBe("table");
    expect(plan.table?.rows).toEqual([[1]]);
  });

  it("reads the KpiCard shape (deltaPct), not the invented trend/prefix/suffix", () => {
    const plan = widgetToRenderPlan(
      widget({ type: "kpi", kpi: { label: "Revenue", value: "$1.2M", deltaPct: 4.5, spark: [1, 2, 3] } }),
    );
    expect(plan.kind).toBe("kpi");
    expect(plan.kpi?.deltaPct).toBe(4.5);
  });

  it("supports the three widget types that previously reported 'not yet supported'", () => {
    const payloads: Record<string, Partial<DashboardWidget>> = {
      insight: {
        insight: { title: "Spike", severity: "warning", evidence: ["n>2σ"], confidence: "calculated" },
      },
      recommendation: {
        recommendation: { text: "Fix it", nextSteps: ["Check ETL"], priority: "warning" },
      },
      slicer: { slicer: { column: "region", values: ["East", "West"] } },
    };

    for (const type of ["insight", "recommendation", "slicer"] as const) {
      const plan = widgetToRenderPlan(widget({ type, ...payloads[type]! }));
      // None of these may degrade to "unsupported".
      expect(plan.kind).toBe(type);
      expect(plan.kind).not.toBe("unsupported");
    }
  });

  it("treats the legacy `filter` alias as a slicer", () => {
    const plan = widgetToRenderPlan(
      widget({ type: "filter", slicer: { column: "region", values: ["East"] } } as Partial<DashboardWidget>),
    );
    expect(plan.kind).toBe("slicer");
    expect(plan.slicer?.column).toBe("region");
  });

  it("keeps the pivot field well and states that results need a live query", () => {
    const plan = widgetToRenderPlan(
      widget({
        type: "pivot",
        pivot: { rows: ["region"], columns: ["quarter"], values: [{ column: "revenue", aggregation: "sum" }] },
      }),
    );
    expect(plan.kind).toBe("pivot");
    expect(plan.pivot?.rows).toEqual(["region"]);
    expect(plan.note).toMatch(/not included in a static export/i);
  });

  it("degrades a chart with no snapshot to a stated reason, never a blank frame", () => {
    const plan = widgetToRenderPlan(widget({ type: "chart" }));
    expect(plan.chart).toBeUndefined();
    expect(plan.note).toMatch(/no saved snapshot/i);
  });

  it("degrades an unknown widget type honestly", () => {
    const plan = widgetToRenderPlan(widget({ type: "not-real" as never }));
    expect(plan.kind).toBe("unsupported");
    expect(plan.note).toMatch(/cannot be rendered/i);
  });

  it("never throws on malformed payloads", () => {
    const junk = [
      widget({ type: "chart", chart: null as never }),
      widget({ type: "table", table: { title: "x", columns: null } as never }),
      widget({ type: "slicer", slicer: {} as never }),
      widget({ type: "pivot", pivot: { rows: "nope", columns: null, values: undefined } as never }),
    ];
    for (const w of junk) expect(() => widgetToRenderPlan(w)).not.toThrow();
  });
});

describe("layout — the saved grid must be honoured", () => {
  it("extracts x/y/w/h from the widget JSON (previously hardcoded undefined)", () => {
    const layout = dashboardLayout([
      { id: "a", x: 0, y: 0, w: 6, h: 3 },
      { id: "b", x: 6, y: 0, w: 6, h: 4 },
    ]);
    expect(layout).toEqual([
      { widgetId: "a", x: 0, y: 0, w: 6, h: 3 },
      { widgetId: "b", x: 6, y: 0, w: 6, h: 4 },
    ]);
  });

  it("omits widgets with no position rather than emitting NaN style", () => {
    const layout = dashboardLayout([{ id: "a", w: 6, h: 3 }]);
    expect(layout).toEqual([]);
  });

  it("clamps spans to the 12-column grid", () => {
    const [entry] = dashboardLayout([{ id: "a", x: -3, y: -2, w: 99, h: 1 }]);
    expect(entry!.x).toBe(0);
    expect(entry!.y).toBe(0);
    expect(entry!.w).toBe(12);
  });

  it("derives a non-degenerate container size", () => {
    expect(widgetContainerSize(6, 3)).toEqual({ width: 912, height: 288 });
    // Missing spans must still yield a drawable box.
    const fallback = widgetContainerSize(undefined, undefined);
    expect(fallback.width).toBeGreaterThan(0);
    expect(fallback.height).toBeGreaterThan(0);
    // Extreme spans clamp rather than producing an unbounded capture.
    expect(widgetContainerSize(9999, 9999).width).toBeLessThanOrEqual(2400);
  });
});
