/**
 * Viewer-tier verification for shared apps (/apps/[shareToken]).
 *
 * Shared apps must honestly report the viewer's render capability and
 * degrade gracefully. The viewer may have a different tier than the
 * publisher (who might be on studio).
 */
import { sceneQuality, allowsTransmission } from "@/lib/scene/quality";
import { readForcedTier } from "@/lib/scene/tier";
import type { SceneCapability } from "@/lib/scene/tier";

export interface ViewerTierInfo {
  /** The viewer's measured tier */
  tier: "studio" | "depth" | "flat";
  /** Whether WebGL is available */
  webgl: boolean;
  /** Device memory in GB (if available) */
  deviceMemory?: number;
  /** Hardware concurrency (CPU cores) */
  cores?: number;
  /** Reduced motion preference */
  prefersReducedMotion: boolean;
  /** iOS Safari detection */
  isIOSSafari: boolean;
}

/**
 * Detect the viewer's capability for shared apps.
 * This runs client-side and mirrors the logic in lib/scene/tier.ts
 * but is adapted for the viewer context where we don't have server hints.
 */
export function detectViewerTier(): ViewerTierInfo {
  if (typeof window === "undefined") {
    return {
      tier: "flat",
      webgl: false,
      prefersReducedMotion: false,
      isIOSSafari: false,
    };
  }

  // Reduced motion check
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // WebGL check
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const webgl = !!gl;
  if (gl) {
    (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
  }

  // Device memory (Chrome/Edge only)
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

  // Hardware concurrency
  const cores = navigator.hardwareConcurrency;

  // iOS Safari detection (MSStream guards old IE/Edge UA interop)
  const isIOSSafari =
    /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as Window & { MSStream?: unknown }).MSStream;

  // Tier determination (simplified from lib/scene/tier.ts for viewer context).
  // The shared app must honour an explicit viewer override (?scene-tier= or
  // localStorage["aerolexa:tier"]) exactly like the product's own pages do —
  // the scene inspector contract applies to shared viewers too.
  const forced = readForcedTier();
  let tier: "studio" | "depth" | "flat" = "flat";

  if (forced === "flat" || prefersReducedMotion || !webgl) {
    tier = "flat";
  } else if (forced === "studio" || forced === "depth") {
    tier = forced;
  } else if (isIOSSafari) {
    // iOS Safari has texture limits, be conservative
    tier = deviceMemory && deviceMemory >= 4 ? "depth" : "flat";
  } else if (deviceMemory && deviceMemory >= 8 && cores && cores >= 4) {
    tier = "studio";
  } else if (deviceMemory && deviceMemory >= 4 && cores && cores >= 2) {
    tier = "depth";
  } else {
    tier = "depth"; // Default to depth for unknown but WebGL-capable devices
  }

  return {
    tier,
    webgl,
    deviceMemory,
    cores,
    prefersReducedMotion,
    isIOSSafari,
  };
}

/**
 * Get the appropriate quality settings for a viewer tier.
 * Re-uses the sceneQuality logic from lib/scene/quality.ts
 */
export function getViewerQuality(tierInfo: ViewerTierInfo) {
  const capability: SceneCapability = {
    tier: tierInfo.tier,
    webgl: tierInfo.webgl,
    dpr: tierInfo.tier === "studio" ? 2 : tierInfo.tier === "depth" ? 1.5 : 1,
    detail: tierInfo.tier === "studio" ? 1 : tierInfo.tier === "depth" ? 0.6 : 1,
    effects: tierInfo.tier !== "flat",
    shadows: tierInfo.tier === "studio",
    reason: `viewer-tier:${tierInfo.tier}`,
  };

  const quality = sceneQuality(capability);
  return {
    ...quality,
    transmission: allowsTransmission(quality) && !tierInfo.isIOSSafari,
    // iOS Safari gets conservative settings
    maxInstances: tierInfo.isIOSSafari ? Math.min(quality.maxInstances, 256) : quality.maxInstances,
  };
}

/**
 * Memory audit helper for shared apps.
 * Logs memory usage at key points for debugging.
 */
export function auditViewerMemory(label: string): number | null {
  if (typeof window === "undefined") return null;

  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  };

  if (perf.memory) {
    const usedMB = perf.memory.usedJSHeapSize / (1024 * 1024);
    const totalMB = perf.memory.totalJSHeapSize / (1024 * 1024);
    const limitMB = perf.memory.jsHeapSizeLimit / (1024 * 1024);
    console.log(
      `[viewer-mem] ${label}: used=${usedMB.toFixed(1)}MB total=${totalMB.toFixed(1)}MB limit=${limitMB.toFixed(1)}MB`,
    );
    return usedMB;
  }
  return null;
}

/**
 * RTL-safe scene overlay helpers.
 * Ensures 3D scenes work correctly in RTL languages.
 */
export function getRTLSceneTransform(rtl: boolean): { scaleX: number; cameraX: number } {
  return {
    scaleX: rtl ? -1 : 1,
    cameraX: rtl ? 1 : -1,
  };
}

/**
 * Viewer capability context for shared apps.
 * Provides the viewer's tier info to all scene components.
 */
export interface ViewerCapabilityContext {
  tierInfo: ViewerTierInfo;
  quality: ReturnType<typeof getViewerQuality>;
}
