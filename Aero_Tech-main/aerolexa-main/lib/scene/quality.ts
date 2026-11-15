/**
 * Scene quality — the single source of scene-quality knobs, derived from the
 * measured render tier.
 *
 * The tier decides WHETHER a client renders WebGL at all (lib/scene/tier.ts).
 * This module decides HOW WELL: shadow map sizes, effect stack contents,
 * instance budgets, dpr clamps, environment resolution. No scene component
 * hardcodes counts or sizes — everything reads a SceneQuality, so one
 * codebase renders honestly on a workstation and a mid-range phone.
 *
 * Pure and deterministic: unit tests pin every knob per tier, and the runtime
 * downgrade path (recordDowngrade) is the telemetry that tells us what
 * devices actually experienced — never guessed.
 */

import type { SceneCapability, SceneTier } from "@/lib/scene/tier";

export type EffectKey = "bloom" | "dof" | "ao" | "vignette" | "grain" | "smaa";

export interface SceneQuality {
  tier: SceneTier;
  /** Resolution of the generated IBL environment (ktx2/HDR cubic). 0 = none. */
  envResolution: number;
  /** Real-time shadow map size in px (long edge). 0 = shadows off. */
  shadowMapSize: number;
  /** Post-processing passes enabled, in canonical stack order (see postfx.tsx). */
  effects: EffectKey[];
  /** Max instances per instanced scene (bars, points). */
  maxInstances: number;
  /** dpr clamp for the scene canvas ([min, max] passed to R3F). */
  dpr: [number, number];
  /** Detail ratio 0..1 — scene components scale counts by this. */
  detail: number;
  /** Frosted-glass transmission material allowed (expensive, studio only). */
  transmission: boolean;
  /** Camera parallax with the pointer allowed. */
  parallax: boolean;
}

const STUDIO: SceneQuality = {
  tier: "studio",
  envResolution: 256,
  shadowMapSize: 2048,
  effects: ["bloom", "smaa", "dof", "ao", "vignette", "grain"],
  maxInstances: 2048,
  dpr: [1, 2],
  detail: 1,
  transmission: true,
  parallax: true,
};

const DEPTH: SceneQuality = {
  tier: "depth",
  envResolution: 128,
  shadowMapSize: 0,
  effects: ["bloom", "vignette"],
  maxInstances: 512,
  dpr: [1, 1.5],
  detail: 0.6,
  transmission: false,
  parallax: true,
};

const FLAT: SceneQuality = {
  tier: "flat",
  envResolution: 0,
  shadowMapSize: 0,
  effects: [],
  maxInstances: 0,
  dpr: [1, 1],
  detail: 1,
  transmission: false,
  parallax: false,
};

const BY_TIER: Record<SceneTier, SceneQuality> = { studio: STUDIO, depth: DEPTH, flat: FLAT };

/**
 * The scene quality for a measured capability. `flat` yields the flat preset:
 * no environment, no effects — callers render their 2D fallback instead.
 */
export function sceneQuality(cap: SceneCapability): SceneQuality {
  return BY_TIER[cap.tier];
}

/**
 * The quality after a runtime downgrade. Downgrades are strictly downward
 * (studio → depth → flat) and monotonic: re-upgrading within a session is not
 * allowed, because flapping quality mid-session is worse than living one rung
 * lower. `reason` is recorded so the quality scoreboard can report what
 * devices actually experienced.
 */
const DOWNGRADE: Record<SceneTier, SceneTier> = { studio: "depth", depth: "flat", flat: "flat" };

export interface DowngradeRecord {
  from: SceneTier;
  to: SceneTier;
  /** Median fps that triggered the downgrade. */
  fps: number;
  at: number;
}

const downgradeLog: DowngradeRecord[] = [];

export function recordDowngrade(from: SceneTier, fps: number, at = Date.now()): SceneQuality {
  const to = DOWNGRADE[from];
  downgradeLog.push({ from, to, fps, at });
  // Keep the log bounded — it is telemetry, not an audit trail.
  if (downgradeLog.length > 50) downgradeLog.shift();
  return BY_TIER[to];
}

/** Telemetry reader for the quality scoreboard (docs/quality-baseline.md). */
export function downgradeLogSnapshot(): readonly DowngradeRecord[] {
  return downgradeLog;
}

/** Test hook — clears the downgrade log. */
export function resetDowngradeLog(): void {
  downgradeLog.length = 0;
}

/**
 * Scale a scene's object count to the tier's detail ratio. Always at least 1,
 * integer, and deterministic — the same inputs render the same scene twice,
 * which the screenshot-diff specs rely on.
 */
export function scaleCount(base: number, quality: SceneQuality): number {
  return Math.max(1, Math.round(base * quality.detail));
}

/** True when the tier can afford the frosted-glass transmission material. */
export function allowsTransmission(quality: SceneQuality): boolean {
  return quality.transmission;
}
