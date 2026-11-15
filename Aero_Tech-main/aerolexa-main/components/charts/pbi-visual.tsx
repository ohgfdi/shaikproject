"use client";

/**
 * Power BI–style visual suite rendered with ECharts.
 * Covers visuals ApexCharts can't: waterfall, funnel, sankey, treemap,
 * sunburst, gauge, heatmap, boxplot, ribbon (stacked area), and a map shell
 * for leaflet-based filled maps.
 */
import * as echarts from "echarts";
import { useEffect, useMemo, useRef } from "react";

import { pbiVisualToECharts } from "@/lib/engine/pbi-echarts";

export type PbiVisualKind =
  "waterfall" | "funnel" | "sankey" | "treemap" | "sunburst" | "gauge" | "heatmap" | "boxplot" | "ribbon" | "pareto";

export interface PbiVisualSpec {
  kind: PbiVisualKind;
  title?: string;
  /** Category labels (x axis). */
  categories: string[];
  /** Primary series values aligned with categories. */
  values: number[];
  /** Optional second series (e.g. cumulative for pareto, ribbon layers). */
  series?: { name: string; values: number[] }[];
  /** Gauge/scorecard: [value, max] */
  gauge?: { value: number; max: number; target?: number };
  /** Heatmap: grid [xIndex, yIndex, value] */
  heat?: { yCategories: string[]; cells: [number, number, number][] };
  /** Sankey: edges source -> target with values. */
  links?: { source: string; target: string; value: number }[];
  /** Boxplot input: groups of raw numbers; quartiles computed here. */
  boxGroups?: { name: string; values: number[] }[];
  /** Report-grade formatting (ROADMAP 3.4) — data labels + reference lines. */
  format?: {
    dataLabels?: boolean;
    referenceLine?: { value: number; label?: string; color?: string };
    palette?: string[];
  };
}

/** Compute the five-number summary for boxplots (Tukey, exclusive median). */
export { boxStats } from "@/lib/engine/pbi-echarts";

export function PbiVisual({ spec, height = 360 }: { spec: PbiVisualSpec; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  // The option builder lives in `lib/engine/pbi-echarts` so the headless
  // report renderer draws the identical visual. Previously the server had its
  // own lossy copy that handled 2 of 10 kinds and emitted an empty canvas for
  // the rest, so exports silently lost their visuals.
  const option = useMemo(() => pbiVisualToECharts(spec), [spec]);

  useEffect(() => {
    if (!ref.current || !option) return;
    const chart = echarts.init(ref.current);
    chart.setOption(option as echarts.EChartsOption);
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [option]);

  if (!option) {
    return (
      <div
        style={{ width: "100%", height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}
        className="text-muted"
      >
        {`This visual type (${spec.kind}) cannot be drawn in this browser.`}
      </div>
    );
  }

  return <div ref={ref} style={{ width: "100%", height }} role="img" aria-label={spec.title ?? "chart"} />;
}
