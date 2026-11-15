"use client";

import { useId, useMemo } from "react";

import type { ChartSpec } from "@/lib/types";

import { MAX_BAR, categoryCenters, downsample, seriesColor } from "./math";
import { GrowingBar } from "./scene";
import { ChartFrame, ChartLegend } from "./scene";

/** Grouped (`bar`, `histogram`) and stacked (`stacked-bar`) plots. */
export function BarChart3D({ spec, height }: { spec: ChartSpec; height: number }) {
  const id = useId();
  const model = useMemo(() => buildBars(spec), [spec]);

  const { centers, slot } = categoryCenters(model.categories.length);
  const { categories: cats, series, stacked, maxVal } = model;

  return (
    <div>
      <ChartFrame
        height={height}
        id={id}
        ariaLabel={chartSummary(spec, model)}
        maxValue={maxVal}
        unit={spec.unit}
        categories={cats}
      >
        {series.map((s, si) => {
          const barWidth = Math.min((slot * 0.78) / (stacked ? 1 : series.length), 2.6);
          const depth = Math.min(barWidth * 1.7, 4.6);
          let running = 0;
          return (
            <group key={`${id}-s${si}`}>
              {s.values.map((v, ci) => {
                if (!isFinite(v)) return null;
                const heightVal = (v / maxVal) * MAX_BAR;
                const cx = stacked
                  ? (centers[ci] ?? 0)
                  : (centers[ci] ?? 0) - ((series.length - 1) * barWidth) / 2 + si * barWidth;
                const base = stacked ? running : 0;
                running += stacked ? heightVal : 0;
                return (
                  <GrowingBar
                    key={`${id}-${si}-${ci}`}
                    x={cx}
                    z={0}
                    width={Math.max(0.3, barWidth * 0.82)}
                    depth={depth}
                    height={Math.max(0.4, heightVal)}
                    yBase={base}
                    color={s.color}
                    delay={ci * 0.02}
                  />
                );
              })}
            </group>
          );
        })}
      </ChartFrame>
      <ChartLegend items={series.map((s) => ({ name: s.name, color: s.color }))} id={id} />
    </div>
  );
}

interface BarModel {
  categories: string[];
  series: { name: string; color: string; values: number[] }[];
  stacked: boolean;
  maxVal: number;
}

function buildBars(spec: ChartSpec): BarModel {
  const cats = downsample(spec.categories ?? [], 24);
  const stacked = spec.kind === "stacked-bar";
  const series = spec.series.map((s, si) => ({
    name: s.name,
    color: seriesColor(si, s.color),
    values: downsample(
      (s.data ?? []).map((v) => (v === null || v === undefined ? 0 : v)),
      24,
    ),
  }));
  const maxVal = Math.max(1, ...series.flatMap((s) => s.values));
  return { categories: cats, series, stacked, maxVal };
}

function chartSummary(spec: ChartSpec, model: { categories: string[]; maxVal: number }): string {
  const parts = [spec.title];
  if (model.categories.length) parts.push(`${model.categories.length} categories, peak ${model.maxVal}.`);
  return parts.join(" ");
}
