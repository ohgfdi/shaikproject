/**
 * Heatmap physicalization — from computed ChartSpec to scene layout.
 *
 * Pure + deterministic: no DOM, no WebGL, no randomness. Oracle-tested
 * against hand-computed expected values, exactly like every stats/DAX engine
 * in this repo. The React component (heatmap3d.tsx) renders this layout
 * verbatim; the split is what makes the "scene props = computed values"
 * contract testable.
 */

import type { ChartSpec } from "@/lib/types";

export interface HeatCell {
  /** Grid column (0-based, left → right). */
  col: number;
  /** Grid row (0-based, front → back). */
  row: number;
  /** World-space X of the cell centre. */
  x: number;
  /** World-space Z of the cell centre. */
  z: number;
  /** Normalized intensity in [0,1]: (value - min) / span. */
  t: number;
  /** The raw computed value this cell mirrors — never invented. */
  value: number;
}

export interface HeatmapLayout {
  cells: HeatCell[];
  /** Column maxima (per spec.categories) — the tallest column of each. */
  colMaxima: number[];
  /** Global max and min of all cell values. */
  maxValue: number;
  minValue: number;
  /** Number of quantitative values the layout encodes (oracle anchor). */
  cellCount: number;
}

/** Grid spacing in world units. */
export const CELL_SPACING = 1;

export function buildHeatmapLayout(spec: ChartSpec): HeatmapLayout {
  const series = spec.series;
  const cols = spec.categories ?? [];
  const colCount = Math.max(1, cols.length || series[0]?.data?.length || 1);
  const rows = series.length;

  // Column maxima are computed from the same data the 2D heatmap labels.
  const colMaxima: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let max = -Infinity;
    for (const s of series) {
      const v = s.data?.[c];
      if (typeof v === "number" && isFinite(v) && v > max) max = v;
    }
    colMaxima.push(max === -Infinity ? 0 : max);
  }

  const finite: number[] = [];
  for (const s of series) {
    for (const v of s.data ?? []) {
      if (typeof v === "number" && isFinite(v)) finite.push(v);
    }
  }
  const maxValue = finite.length ? Math.max(...finite) : 0;
  const minValue = finite.length ? Math.min(...finite) : 0;
  const span = maxValue - minValue || 1;

  const cells: HeatCell[] = [];
  for (let r = 0; r < rows; r++) {
    const s = series[r];
    if (!s) continue;
    const data = s.data ?? [];
    for (let c = 0; c < colCount; c++) {
      const v = data[c];
      if (typeof v !== "number" || !isFinite(v)) continue; // gaps stay gaps — no invented cells
      cells.push({
        col: c,
        row: r,
        x: (c - (colCount - 1) / 2) * CELL_SPACING,
        z: (r - (rows - 1) / 2) * CELL_SPACING,
        t: (v - minValue) / span,
        value: v,
      });
    }
  }

  return { cells, colMaxima, maxValue, minValue, cellCount: cells.length };
}

/**
 * Color ramp for the ramp material channel: cold (min) → accent (max).
 * Interpolates in sRGB between the palette ends used by the 2D heatmap, so
 * 2D and 3D reads agree on what "hot" looks like.
 */
export function heatColor(t: number): string {
  const cold = { r: 0x14, g: 0x3a, b: 0x4a };
  const hot = { r: 0xff, g: 0xb4, b: 0x00 };
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round(cold.r + (hot.r - cold.r) * k);
  const g = Math.round(cold.g + (hot.g - cold.g) * k);
  const b = Math.round(cold.b + (hot.b - cold.b) * k);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
