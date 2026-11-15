/** @jest-environment jsdom */
/**
 * S10 — viewer quality derivation for shared apps (lib/scene/viewer-tier.ts).
 *
 * `detectViewerTier`'s override contract is gated in scene-tier-override.test.ts;
 * this suite pins the OTHER half of the S10 contract: `getViewerQuality` maps a
 * viewer tier onto the shared sceneQuality knobs with the iOS-Safari honesty
 * clamps (transmission off, instance budget capped), and `auditViewerMemory`
 * fails closed outside a real browser heap.
 */
import { auditViewerMemory, detectViewerTier, getViewerQuality } from "@/lib/scene/viewer-tier";

/** jsdom has no WebGL and no matchMedia; give it honest stand-ins. */
function stubBrowserCapabilities({ webgl }: { webgl: boolean }): void {
  jest
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(webgl ? ({ getExtension: () => null } as unknown as WebGLRenderingContext) : null);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn().mockReturnValue({ matches: false } as MediaQueryList),
  });
}

function tierInfoFor(tier: "studio" | "depth" | "flat", isIOSSafari = false) {
  return {
    tier,
    webgl: tier !== "flat",
    deviceMemory: tier === "studio" ? 8 : 4,
    cores: tier === "studio" ? 8 : 4,
    prefersReducedMotion: false,
    isIOSSafari,
  };
}

describe("getViewerQuality — tier → quality knobs", () => {
  it("studio viewer gets the full stack: effects, shadows, transmission, parallax", () => {
    const q = getViewerQuality(tierInfoFor("studio"));
    expect(q.tier).toBe("studio");
    expect(q.effects).toEqual(["bloom", "smaa", "dof", "ao", "vignette", "grain"]);
    expect(q.shadowMapSize).toBe(2048);
    expect(q.transmission).toBe(true);
    expect(q.parallax).toBe(true);
    expect(q.dpr).toEqual([1, 2]);
  });

  it("depth viewer loses the post stack beyond bloom+vignette and transmission", () => {
    const q = getViewerQuality(tierInfoFor("depth"));
    expect(q.tier).toBe("depth");
    expect(q.effects).toEqual(["bloom", "vignette"]);
    expect(q.shadowMapSize).toBe(0);
    expect(q.transmission).toBe(false);
  });

  it("flat viewer gets the flat preset — nothing to render with", () => {
    const q = getViewerQuality(tierInfoFor("flat"));
    expect(q.tier).toBe("flat");
    expect(q.effects).toEqual([]);
    expect(q.maxInstances).toBe(0);
    expect(q.transmission).toBe(false);
    expect(q.parallax).toBe(false);
  });
});

describe("getViewerQuality — iOS Safari honesty clamps (S10)", () => {
  it("studio viewer on iOS Safari loses transmission (texture/memory limits)", () => {
    const q = getViewerQuality(tierInfoFor("studio", true));
    expect(q.transmission).toBe(false);
  });

  it("iOS Safari caps the instance budget at 256 even on studio", () => {
    const base = getViewerQuality(tierInfoFor("studio", false));
    const ios = getViewerQuality(tierInfoFor("studio", true));
    expect(base.maxInstances).toBe(2048);
    expect(ios.maxInstances).toBe(256);
  });

  it("depth viewer on iOS Safari is clamped to the 256 cap", () => {
    const iosDepth = getViewerQuality(tierInfoFor("depth", true));
    expect(iosDepth.maxInstances).toBe(256); // min(depth's 512, 256)
  });

  it("the iOS clamp never RAISES a budget that is already lower", () => {
    const iosFlat = getViewerQuality(tierInfoFor("flat", true));
    expect(iosFlat.maxInstances).toBe(0); // flat's own 0 stays 0
  });

  it("is deterministic — the same viewer info maps to the same quality twice", () => {
    const info = tierInfoFor("depth", true);
    expect(getViewerQuality(info)).toEqual(getViewerQuality(info));
  });
});

describe("auditViewerMemory — honest unmeasured state outside Chrome", () => {
  it("returns null when performance.memory is absent (jsdom/Firefox/Safari)", () => {
    expect(auditViewerMemory("test")).toBeNull();
  });
});

describe("detectViewerTier — result shape", () => {
  it("always reports the S10 capability shape a viewer surface needs", () => {
    // jsdom cannot reach the SSR branch (window always exists), so the
    // server-side flat fallback is pinned in scene-tier-override.test.ts via
    // the module's structure; here we pin the contract shape itself.
    stubBrowserCapabilities({ webgl: false });
    const info = detectViewerTier();
    expect(info).toHaveProperty("tier");
    expect(info).toHaveProperty("webgl");
    expect(info).toHaveProperty("prefersReducedMotion");
    expect(info).toHaveProperty("isIOSSafari");
    expect(info.tier).toBe("flat"); // no WebGL in jsdom → honest flat
  });
});
