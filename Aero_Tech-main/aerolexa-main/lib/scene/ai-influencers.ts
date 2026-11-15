/**
 * Key-influencers physicalization — from computed KeyInfluencersResult to
 * scene layout.
 *
 * Pure + deterministic, oracle-tested (__tests__/unit/scene-ai-visuals.test.ts).
 * The React component (key-influencers.tsx) renders this layout verbatim.
 *
 * Every value the scene shows is computed from the engine's result
 * (lib/engine/ai-visuals.ts): bar heights encode |lift − 1| scaled against
 * the strongest influencer, colours encode direction (raises vs lowers the
 * outcome likelihood), and the base-rate plane height is the engine's own
 * baseRate. Nothing is invented.
 */

import type { Influencer, KeyInfluencersResult } from "@/lib/engine/ai-visuals";

/** Row spacing in world units. */
export const BAR_SPACING = 1.2;
/** Max bar height in world units for the strongest influencer. */
export const MAX_BAR_HEIGHT = 2.5;
/** Minimum visible bar height — even lift ≈ 1 casts a slab. */
export const MIN_BAR_HEIGHT = 0.3;

/** Direction colours reuse the chart palette (theme.ts): teal raises, rose lowers. */
export const RAISES_COLOR = "#5AA8AA";
export const LOWERS_COLOR = "#E8637A";

export interface InfluencerBarLayout {
  influencer: Influencer;
  /** World-space X centre of the bar row. */
  x: number;
  /** Encoded bar height from |lift − 1| (0.3..2.5). */
  height: number;
  /** True when the influencer raises the outcome likelihood (lift > 1). */
  raises: boolean;
  /** Bar colour (palette, direction-encoded). */
  color: string;
}

export interface InfluencerSceneLayout {
  bars: InfluencerBarLayout[];
  /** The engine's base rate, in [0,1] — the reference plane mirrors it. */
  baseRate: number;
  /** Height of the base-rate reference plane in world units. */
  baseRateHeight: number;
  totalRows: number;
}

/**
 * Build the scene layout from the engine result. Deterministic: the same
 * result always produces the same layout (the oracle test pins exact numbers).
 */
export function buildInfluencersLayout(result: KeyInfluencersResult, maxBars = 8): InfluencerSceneLayout {
  const top = result.influencers.slice(0, maxBars);
  // The strongest |lift − 1| among the rendered bars scales the row; the
  // engine already sorts influencers by this, so bars decay left → right.
  const strongest = Math.max(0.1, ...top.map((i) => Math.abs(i.lift - 1)));

  const bars: InfluencerBarLayout[] = top.map((influencer, index) => {
    const magnitude = Math.abs(influencer.lift - 1) / strongest;
    const height = MIN_BAR_HEIGHT + magnitude * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT);
    const raises = influencer.lift > 1;
    return {
      influencer,
      x: (index - (top.length - 1) / 2) * BAR_SPACING,
      height,
      raises,
      color: raises ? RAISES_COLOR : LOWERS_COLOR,
    };
  });

  return {
    bars,
    baseRate: result.baseRate,
    // The reference plane sits at a fixed visual height; the LABEL carries
    // the real baseRate number (data-truth: the plane is a marker, not the
    // encoding — bar heights are).
    baseRateHeight: 0.1,
    totalRows: result.totalRows,
  };
}
