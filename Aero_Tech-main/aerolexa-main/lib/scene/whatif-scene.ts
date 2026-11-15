/**
 * What-if physicalization — from the computed WhatIfResult to scene layout.
 *
 * Pure + deterministic, oracle-tested (__tests__/unit/scene-whatif-scene.test.ts).
 * The React component (whatif.tsx) renders this layout verbatim; the split is
 * what makes "the 3D only mirrors the number" contract testable without
 * booting WebGL.
 *
 * Data-truth rules preserved: before/after slab heights are the engine's own
 * beforeValue/afterValue scaled against a shared max, the delta arrow span is
 * the computed delta, and the fallback flag demotes the scene to the honest
 * "hypothetical" tint. Nothing is invented.
 */

import type { WhatIfResult } from "@/lib/types";

/** Height (world units) of the taller of the two result slabs. */
export const RESULT_SLAB_MAX = 3;
/** Minimum slab height — even a zero baseline stays visible. */
export const RESULT_SLAB_MIN = 0.3;
/** Horizontal separation of the before/after slabs. */
export const SLAB_GAP = 2.4;

export interface WhatIfSceneLayout {
  before: { x: number; height: number; value: number };
  after: { x: number; height: number; value: number };
  /** The engine's own computed delta (afterValue − beforeValue as reported). */
  delta: number;
  /** Signed percentage the engine applied to the driver mean. */
  pctChange: number;
  /** Direction as computed by the engine. */
  direction: "increase" | "decrease";
  /** r² of the fitted model — drives the confidence tint. */
  rSquared: number;
  /** True when the engine flagged a hypothetical (fallback) projection. */
  fallback: boolean;
  /** Driver/outcome column names the engine ran on. */
  driverColumn: string;
  outcomeColumn: string;
}

export function buildWhatIfLayout(result: WhatIfResult): WhatIfSceneLayout {
  const max = Math.max(Math.abs(result.beforeValue), Math.abs(result.afterValue)) || 1;
  const scale = (v: number): number => RESULT_SLAB_MIN + (Math.abs(v) / max) * (RESULT_SLAB_MAX - RESULT_SLAB_MIN);

  return {
    before: { x: -SLAB_GAP / 2, height: scale(result.beforeValue), value: result.beforeValue },
    after: { x: SLAB_GAP / 2, height: scale(result.afterValue), value: result.afterValue },
    // The engine's reported delta verbatim — never recomputed here, so the
    // scene can never disagree with the result card it mirrors.
    delta: result.delta,
    pctChange: result.pctChange,
    direction: result.direction,
    rSquared: result.model.rSquared,
    fallback: result.fallback,
    driverColumn: result.driverColumn,
    outcomeColumn: result.outcomeColumn,
  };
}

/**
 * Delta arrow colour: success green for a gain, chart rose for a drop.
 * Reuses the fixed chart palette (components/ui/theme.ts) — never CSS vars,
 * which the canvas cannot read.
 */
export function deltaColor(delta: number): string {
  return delta >= 0 ? "#58B368" : "#E8637A";
}
