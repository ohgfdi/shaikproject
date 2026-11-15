/**
 * Scene render tier — the honest, measured decision about how much WebGL
 * realism a client can run.
 *
 * Three tiers:
 *  - "studio": full physical scene (postprocessing, shadows, dense objects)
 *  - "depth":  mid-range (no postprocessing, fewer objects, cheaper lighting)
 *  - "flat":   no WebGL at all (2D DOM only — reduced motion, no GPU, SSR, or
 *              an explicit call to opt out)
 *
 * Everything is measured, never guessed: the same WebGL probe the 3D charts
 * already use, plus device capabilities. A client that cannot run the
 * realism system still gets the identical 2D UI — nothing is hidden behind
 * hardware the user does not have.
 */

import { BRAND_STORAGE_KEYS, readBrandLocalStorage } from "@/lib/brand";
import { supportsWebGL } from "@/lib/scene/webgl-support";

export type SceneTier = "studio" | "depth" | "flat";

export interface SceneCapability {
  tier: SceneTier;
  webgl: boolean;
  /** How many BackingStore pixels a pixel of CSS should sample (1–2). */
  dpr: number;
  /** Fraction of scene detail vs a top-tier machine (0 < ratio <= 1). */
  detail: number;
  /** True when postprocessing passes (bloom, DOF, vignette) can run. */
  effects: boolean;
  /** True when real-time shadows are cheap enough to enable. */
  shadows: boolean;
  /** Why we landed here (labelling, debuggable). */
  reason: string;
}

export interface SceneInputs {
  prefersReducedMotion?: boolean;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  dpr?: number;
  forceTier?: SceneTier;
}

const EFFECTS_MIN_DPR = 1.5;
const SHADOWS_MIN_DPR = 2;

/**
 * Compute the render tier from measured inputs. Pure + deterministic so it can
 * be unit-tested and reused between the client probe and the components that
 * consume the tier.
 */
export function computeSceneTier(inputs: SceneInputs): SceneCapability {
  const webgl = supportsWebGL();

  if (!webgl || inputs.prefersReducedMotion) {
    return {
      tier: "flat",
      webgl: webgl && !inputs.prefersReducedMotion,
      dpr: 1,
      detail: 1,
      effects: false,
      shadows: false,
      reason: inputs.prefersReducedMotion ? "prefers-reduced-motion" : "no-webgl",
    };
  }

  if (inputs.forceTier === "flat") {
    return {
      tier: "flat",
      webgl,
      dpr: 1,
      detail: 1,
      effects: false,
      shadows: false,
      reason: "forced-flat",
    };
  }

  if (inputs.forceTier === "studio" || inputs.forceTier === "depth") {
    return tierFor(inputs.forceTier, inputs.dpr ?? 1, inputs.hardwareConcurrency ?? 4, inputs.deviceMemory ?? 4);
  }

  // Measured heuristics, intentionally conservative. All reads are guarded so
  // the function stays pure + node-testable; callers (or the browser probe
  // below) supply the real values, anything omitted falls back to a safe read.
  const dpr = Math.min(inputs.dpr ?? readDevicePixelRatio(), 2);
  const cores = inputs.hardwareConcurrency ?? readHardwareConcurrency();
  const mem = inputs.deviceMemory ?? 4;

  if (dpr >= EFFECTS_MIN_DPR && cores >= 8 && mem >= 8) {
    return tierFor("studio", dpr, cores, mem);
  }
  if (cores >= 2 || dpr >= 1.25) {
    return tierFor("depth", dpr, cores, mem);
  }
  return tierFor("flat", dpr, cores, mem);
}

function readDevicePixelRatio(): number {
  return typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
}

function readHardwareConcurrency(): number {
  return typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
}

function tierFor(tier: SceneTier, dpr: number, cores: number, mem: number): SceneCapability {
  if (tier === "flat") {
    return {
      tier: "flat",
      webgl: true,
      dpr: 1,
      detail: 1,
      effects: false,
      shadows: false,
      reason: "flat-by-policy",
    };
  }
  const studio = tier === "studio";
  return {
    tier,
    webgl: true,
    dpr: studio ? Math.min(dpr, 2) : Math.min(dpr, 1.5),
    detail: studio ? 1 : 0.6,
    effects: studio,
    shadows: studio && dpr >= SHADOWS_MIN_DPR,
    reason: studio ? `studio (dpr ${dpr.toFixed(2)}, ${cores} cores, ${mem} gb)` : `depth (${cores} cores)`,
  };
}

/**
 * The measured tier for the current page load. Cheap (a single WebGL probe +
 * capability reads) and cached for the lifetime of the tab.
 *
 * Override contract (scene inspector / e2e specs): `localStorage
 * ["ledgerly.tier"]` set to "studio" | "depth" | "flat" forces the tier for
 * this tab. The `?scene-tier=` URL query param wins over localStorage — it
 * composes with other tools that own localStorage (Lighthouse, page.loadURL),
 * and makes shareable one-off demos like `/?scene-tier=flat` possible.
 * The override is read once per load and never re-measured — an explicit
 * user choice wins over any heuristic.
 */
let cached: SceneCapability | null = null;

export function sceneTier(): SceneCapability {
  if (cached) return cached;
  const forced = readForcedTier();
  cached = computeSceneTier({
    prefersReducedMotion:
      typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    forceTier: forced,
  });
  return cached;
}

const VALID_TIERS: readonly SceneTier[] = ["studio", "depth", "flat"];

function isValidTier(value: unknown): value is SceneTier {
  return typeof value === "string" && (VALID_TIERS as readonly string[]).includes(value);
}

/**
 * The active tier override, if any: the `?scene-tier=` URL param wins over
 * the persisted `localStorage["ledgerly.tier"]` value. Browser-only; fails
 * closed to undefined. Reads the pre-rename `aerolexa:tier` key as a fallback.
 */
export function readForcedTier(): SceneTier | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const param = new URLSearchParams(window.location.search).get("scene-tier");
    if (isValidTier(param)) return param;
  } catch {
    // A malformed URL must never break the page — fall through to storage.
  }
  try {
    const value = readBrandLocalStorage(BRAND_STORAGE_KEYS.tier);
    if (isValidTier(value)) return value;
  } catch {
    // Private mode / storage disabled: no override, measure as usual.
  }
  return undefined;
}

/** Test hook — clears the cached tier so a fresh measurement can run. */
export function resetSceneTierCache(): void {
  cached = null;
}
