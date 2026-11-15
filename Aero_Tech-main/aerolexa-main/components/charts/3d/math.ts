import { CHART_PALETTE } from "@/components/ui/theme";

/** World-space floor height that keeps labels/axis overlays clear of the grid. */
export const PLOT_HALF = 12;
/** World-space height that maps the maximum value to. */
export const MAX_BAR = 22;

export interface NiceNumber {
  value: number;
  label: string;
}

/**
 * Pick ≤ `count` evenly spaced, human-friendly ticks between 0 and max so the
 * left-hand value rail matches what the 3D scale actually shows.
 */
export function niceTicks(max: number, count = 4): NiceNumber[] {
  if (!isFinite(max) || max <= 0) return [{ value: 0, label: "0" }];
  const step0 = max / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag;
  const step = (err >= 5 ? 10 : err >= 2.5 ? 5 : err >= 2 ? 2 : 1) * mag;
  const ticks: NiceNumber[] = [];
  // prettier-ignore
  for (let v = 0; v <= max + step * 1e-6; v += step) {
    const rounded = Math.round(v * 1e6) / 1e6;
    ticks.push({ value: rounded, label: formatTick(rounded) });
  }
  return ticks;
}

function formatTick(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${trim(v / 1e6)}M`;
  if (abs >= 1e3) return `${trim(v / 1e3)}k`;
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

function trim(v: number): string {
  const s = v.toString();
  return s.length > 4 ? `${s.slice(0, 4)}` : s;
}

/**
 * Evenly spread category centres across the plot width. The returned slot
 * width lets grouped bars fit side-by-side inside one category.
 */
export function categoryCenters(n: number): { centers: number[]; slot: number } {
  if (n <= 1) return { centers: [0], slot: PLOT_HALF };
  const slot = (PLOT_HALF * 2) / n;
  const centers = Array.from({ length: n }, (_, i) => -PLOT_HALF + slot / 2 + i * slot);
  return { centers, slot };
}

/** Keep dense data legible in 3D by stepping uniformly down to ≤ `max`. */
export function downsample<T>(arr: T[], max = 90): T[] {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length / max);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) {
    const v = arr[i];
    if (v !== undefined) out.push(v);
  }
  if (out[out.length - 1] !== arr[arr.length - 1]) {
    const last = arr[arr.length - 1];
    if (last !== undefined) out.push(last);
  }
  return out;
}

/** Colour for a series index — falls back to the established chart palette. */
export function seriesColor(i: number, override?: string): string {
  const palette = CHART_PALETTE[i % CHART_PALETTE.length];
  return override ?? palette ?? "#5AA8AA";
}
