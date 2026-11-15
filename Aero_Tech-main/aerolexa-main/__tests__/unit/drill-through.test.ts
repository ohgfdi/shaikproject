/**
 * Drill-through engine (ROADMAP 3.5) — pure core.
 * Known-answer tests: filter derivation from widget clicks, binding
 * extraction from the real widget shapes, URL round-trip, sanity limits.
 */

import {
  derivePointFilters,
  drillRequestIsSane,
  drillThroughUrl,
  parseDrillFilters,
  widgetBinding,
  type DrillRequest,
} from "@/lib/engine/drill-through";
import type { DashboardWidget } from "@/lib/types";

function chartWidget(overrides: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    id: "w1",
    type: "chart",
    title: "Revenue by region",
    w: 6,
    h: 4,
    datasetId: "ds-1",
    chart: {
      kind: "bar",
      title: "Revenue by region",
      series: [{ name: "revenue", data: [100, 200] }],
      categories: ["East", "West"],
      xLabel: "region",
      yLabel: "revenue",
    },
    ...overrides,
  } as DashboardWidget;
}

describe("drill-through — widgetBinding", () => {
  it("reads the chart's x label as the category column", () => {
    const binding = widgetBinding(chartWidget());
    expect(binding.categoryColumn).toBe("region");
  });

  it("prefers the field well's axis, then pivot rows", () => {
    const withFields = widgetBinding(chartWidget({ fields: { axis: ["country", "state"], values: ["amount"] } }));
    expect(withFields.categoryColumn).toBe("country");
    const withPivot = widgetBinding(
      chartWidget({
        pivot: { rows: ["rep"], columns: ["product"], values: [{ column: "amount", aggregation: "sum" }] },
      }),
    );
    expect(withPivot.categoryColumn).toBe("rep");
    expect(withPivot.seriesColumns).toEqual(["product"]);
  });

  it("returns null category when nothing is bound", () => {
    const w = chartWidget();
    delete (w as { chart?: unknown }).chart;
    expect(widgetBinding(w).categoryColumn).toBeNull();
  });
});

describe("drill-through — derivePointFilters", () => {
  it("derives the clicked category as the primary filter", () => {
    const res = derivePointFilters(chartWidget(), "East", null, []);
    expect(res).toEqual({ ok: true, filters: [{ column: "region", value: "East" }] });
  });

  it("adds the series filter when the widget has a series/legend column", () => {
    const w = chartWidget({ fields: { axis: ["region"], legend: "product" } });
    const res = derivePointFilters(w, "East", "A", []);
    expect(res.ok && res.filters).toEqual([
      { column: "region", value: "East" },
      { column: "product", value: "A" },
    ]);
  });

  it("carries the applied cross-filter context through", () => {
    const res = derivePointFilters(chartWidget(), "East", null, [{ column: "year", values: ["2026"] }]);
    expect(res.ok && res.filters).toEqual([
      { column: "region", value: "East" },
      { column: "year", value: "2026" },
    ]);
  });

  it("deduplicates a cross-filter that matches the clicked slice", () => {
    const res = derivePointFilters(chartWidget(), "East", null, [{ column: "region", values: ["East"] }]);
    expect(res.ok && res.filters).toEqual([{ column: "region", value: "East" }]);
  });

  it("refuses an unbound widget honestly", () => {
    const w = chartWidget();
    delete (w as { chart?: unknown }).chart;
    const res = derivePointFilters(w, "East", null, []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no category column/i);
  });

  it("refuses a click on nothing", () => {
    const res = derivePointFilters(chartWidget(), null, null, []);
    expect(res.ok).toBe(false);
  });
});

describe("drill-through — URL round-trip", () => {
  const req: DrillRequest = {
    datasetId: "ds-1",
    filters: [
      { column: "region", value: "East" },
      { column: "product", value: "A" },
    ],
    sourceWidget: { id: "w1", title: "Revenue by region", kind: "chart" },
  };

  it("builds a shareable detail URL carrying the filters", () => {
    const url = drillThroughUrl(req);
    expect(url).toBe("/datasets/ds-1/detail?f=region%3DEast&f=product%3DA&from=Revenue+by+region");
  });

  it("parses back into the same filters", () => {
    const url = drillThroughUrl(req);
    const params = new URLSearchParams(url.split("?")[1]);
    const parsed = parseDrillFilters(params.getAll("f"));
    expect(parsed).toEqual(req.filters);
  });

  it("tolerates junk filter params", () => {
    expect(parseDrillFilters("noequalsign")).toEqual([]);
    expect(parseDrillFilters(["=empty-column"])).toEqual([]);
    expect(parseDrillFilters(undefined)).toEqual([]);
  });
});

describe("drill-through — sanity limits", () => {
  it("accepts a sane request and rejects degenerate ones", () => {
    const req: DrillRequest = {
      datasetId: "ds-1",
      filters: [{ column: "region", value: "East" }],
      sourceWidget: { id: "w", title: "t", kind: "chart" },
    };
    expect(drillRequestIsSane(req)).toBe(true);
    expect(drillRequestIsSane({ ...req, datasetId: "" })).toBe(false);
    expect(drillRequestIsSane({ ...req, filters: [] })).toBe(false);
    expect(
      drillRequestIsSane({
        ...req,
        filters: Array.from({ length: 9 }, (_, i) => ({ column: `c${i}`, value: "v" })),
      }),
    ).toBe(false);
    expect(drillRequestIsSane({ ...req, filters: [{ column: "", value: "v" }] })).toBe(false);
  });
});
