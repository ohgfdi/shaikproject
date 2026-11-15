/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";

import { supports3D } from "@/components/charts/3d/chart3d";
import LiveChart3D from "@/components/charts/3d/live";
import type { ChartSpec } from "@/lib/types";

/**
 * Dispatcher contract (S5.1): every kind `supports3D` admits must have a
 * route in `LiveChart3D`, and the 3D heatmap — built and oracle-tested in
 * scene-heatmap.test.ts — must actually be reachable from ChartRenderer
 * paths, not just exist as a component.
 */

const spec = (kind: ChartSpec["kind"]): ChartSpec => ({ kind, title: `t-${kind}`, series: [] });

describe("supports3D — the kinds the 3D engine can render today", () => {
  it("admits the heatmap kind (S5.1)", () => {
    expect(supports3D(spec("heatmap"))).toBe(true);
  });

  it("admits the AI visual kinds (S5.2)", () => {
    expect(supports3D(spec("decomposition-tree"))).toBe(true);
    expect(supports3D(spec("key-influencers"))).toBe(true);
  });

  it("still admits every previously supported kind", () => {
    for (const kind of ["bar", "stacked-bar", "histogram", "line", "area", "scatter", "donut"] as const) {
      expect(supports3D(spec(kind))).toBe(true);
    }
  });

  it("rejects kinds with no 3D physicalization", () => {
    for (const kind of ["kpi", "box", "funnel", "waterfall", "pivot"] as const) {
      expect(supports3D(spec(kind))).toBe(false);
    }
  });
});

describe("LiveChart3D — heatmap routing", () => {
  it("routes heatmap specs to the 3D heatmap component", () => {
    // An empty layout returns the heatmap component's honest DOM fallback —
    // the only place this exact copy exists — proving the dispatcher reaches
    // HeatmapChart3D without booting WebGL.
    render(<LiveChart3D spec={{ kind: "heatmap", title: "Empty heat", series: [] }} height={300} />);
    expect(screen.getByText("No quantitative cells to chart")).toBeInTheDocument();
  });
});

describe("LiveChart3D — AI visuals routing (S5)", () => {
  it("renders nothing for AI kinds without engine data (no invented scenes)", () => {
    const { container: treeContainer } = render(
      <LiveChart3D spec={{ kind: "decomposition-tree", title: "t", series: [] }} height={300} />,
    );
    expect(treeContainer).toBeEmptyDOMElement();
    const { container: inflContainer } = render(
      <LiveChart3D spec={{ kind: "key-influencers", title: "t", series: [] }} height={300} />,
    );
    expect(inflContainer).toBeEmptyDOMElement();
  });
});
