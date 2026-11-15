/**
 * Oracle tests for report pages, bookmarks and themes
 * (lib/engine/report-pages.ts). Every expectation is hand-computed.
 */

import {
  addPage,
  applyThemeToPages,
  captureBookmark,
  DEFAULT_THEME,
  ensurePages,
  movePage,
  parseTheme,
  removePage,
  renamePage,
  sortBookmarks,
} from "@/lib/engine/report-pages";
import type { DashboardWidget, ReportPage } from "@/lib/types";

const widget = (id: string, title = "T"): DashboardWidget => ({
  id,
  type: "text",
  title,
  w: 6,
  h: 4,
  content: "x",
});

const page = (id: string, name: string, widgetIds: string[]): ReportPage => ({
  id,
  name,
  widgets: widgetIds.map((w) => widget(w)),
});

describe("ensurePages", () => {
  it("wraps a legacy widget array as page 1", () => {
    const pages = ensurePages({ title: "Sales", widgets: [widget("a"), widget("b")] });
    expect(pages).toEqual([{ id: "page-1", name: "Sales", widgets: [widget("a"), widget("b")] }]);
  });

  it("returns existing pages untouched", () => {
    const existing = [page("p1", "Overview", ["a"]), page("p2", "Detail", [])];
    expect(ensurePages({ title: "T", widgets: [], pages: existing })).toEqual(existing);
  });
});

describe("addPage / renamePage / removePage / movePage", () => {
  const base = [page("page-1", "Overview", ["a"])];

  it("adds a page with a unique id and name", () => {
    const next = addPage(base, "Detail");
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ id: "page-2", name: "Detail", widgets: [] });
  });

  it("rejects duplicate names (case-insensitive) and empty names", () => {
    expect(() => addPage(base, "overview")).toThrow(/already exists/);
    expect(() => addPage(base, "   ")).toThrow(/needs a name/);
  });

  it("renames a page and rejects clashing renames", () => {
    const two = addPage(base, "Detail");
    expect(renamePage(two, "page-2", "Deep dive")[1]!.name).toBe("Deep dive");
    expect(() => renamePage(two, "page-2", "Overview")).toThrow(/already exists/);
  });

  it("refuses to delete the last page", () => {
    expect(() => removePage(base, "page-1")).toThrow(/at least one page/);
  });

  it("removes a non-last page", () => {
    const two = addPage(base, "Detail");
    const next = removePage(two, "page-2");
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe("page-1");
  });

  it("moves pages", () => {
    const three = addPage(addPage(base, "B"), "C");
    const moved = movePage(three, 2, 0);
    expect(moved.map((p) => p.name)).toEqual(["C", "Overview", "B"]);
  });
});

describe("captureBookmark / sortBookmarks", () => {
  it("captures a named, serializable view state", () => {
    const bm = captureBookmark(
      "Q3 East view",
      [{ column: "Region", values: ["East"], sourceWidgetId: "w1", sourceWidgetTitle: "Sales" }],
      { pageId: "page-2" },
    );
    expect(bm.name).toBe("Q3 East view");
    expect(bm.pageId).toBe("page-2");
    expect(bm.filters).toEqual([
      { column: "Region", values: ["East"], sourceWidgetId: "w1", sourceWidgetTitle: "Sales" },
    ]);
    expect(typeof bm.capturedAt).toBe("string");
    expect(bm.id).toMatch(/^bm-/);
  });

  it("requires a name", () => {
    expect(() => captureBookmark("  ", [])).toThrow(/needs a name/);
  });

  it("sorts alphabetically without mutating the input", () => {
    const a = captureBookmark("b", []);
    const b = captureBookmark("a", []);
    const sorted = sortBookmarks([a, b]);
    expect(sorted.map((x) => x.name)).toEqual(["a", "b"]);
  });
});

describe("parseTheme", () => {
  it("parses a Power BI-style dataColors theme", () => {
    const theme = parseTheme('{"name":"Corp","dataColors":["#5AA8AA","#FFB400","#2E7D32"],"dataLabels":true}');
    expect(theme).toEqual({
      name: "Corp",
      background: DEFAULT_THEME.background,
      foreground: DEFAULT_THEME.foreground,
      palette: ["#5aa8aa", "#ffb400", "#2e7d32"],
      dataLabels: true,
    });
  });

  it("accepts the palette key and optional background/foreground", () => {
    const theme = parseTheme('{"palette":["#111111","#eeeeee"],"background":"#202020","foreground":"#f0f0f0"}');
    expect(theme.palette).toEqual(["#111111", "#eeeeee"]);
    expect(theme.background).toBe("#202020");
    expect(theme.foreground).toBe("#f0f0f0");
    expect(theme.dataLabels).toBe(false);
  });

  it("rejects invalid JSON, non-objects, missing/short/non-hex palettes", () => {
    expect(() => parseTheme("not json")).toThrow(/not valid JSON/);
    expect(() => parseTheme("[1,2]")).toThrow(/JSON object/);
    expect(() => parseTheme('{"name":"x"}')).toThrow(/palette/);
    expect(() => parseTheme('{"palette":["#111111"]}')).toThrow(/at least 2/);
    expect(() => parseTheme('{"palette":["red","#00ff00"]}')).toThrow(/#rrggbb/);
    expect(() => parseTheme('{"palette":["#111111","#222222","#333333"]}')).not.toThrow();
  });
});

describe("applyThemeToPages", () => {
  it("overrides palette + dataLabels on every widget (chart and pbi-visual)", () => {
    const theme = { ...DEFAULT_THEME, palette: ["#101010", "#202020"], dataLabels: true };
    const pages: ReportPage[] = [
      {
        id: "page-1",
        name: "P",
        widgets: [
          {
            ...widget("a"),
            type: "chart",
            chart: { kind: "bar", title: "c", categories: ["x"], series: [{ name: "s", data: [1] }] },
          },
          { ...widget("b"), type: "pbi-visual", pbiVisual: { kind: "pareto", categories: ["x"], values: [1] } },
        ],
      },
    ];
    const themed = applyThemeToPages(pages, theme);
    const w1 = themed[0]!.widgets[0]!;
    const w2 = themed[0]!.widgets[1]!;
    expect(w1.format?.palette).toEqual(["#101010", "#202020"]);
    expect(w1.format?.dataLabels).toBe(true);
    expect(w2.pbiVisual?.format?.palette).toEqual(["#101010", "#202020"]);
    expect(w2.pbiVisual?.format?.dataLabels).toBe(true);
  });
});
