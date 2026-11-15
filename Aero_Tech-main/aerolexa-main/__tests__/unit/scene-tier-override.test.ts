/** @jest-environment jsdom */
/**
 * Scene tier override — `?scene-tier=` URL param + localStorage contract.
 *
 * The override chain is: URL param (wins) → localStorage["aerolexa:tier"] →
 * measured heuristics. Tools that own the page (Lighthouse) can't have
 * localStorage pre-seeded, so the URL param is what makes the with/without-
 * canvas comparison runnable (S4 pending item).
 */
import { readForcedTier, resetSceneTierCache, sceneTier } from "@/lib/scene/tier";
import { detectViewerTier, getRTLSceneTransform } from "@/lib/scene/viewer-tier";
import { supportsWebGL } from "@/lib/scene/webgl-support";

jest.mock("@/lib/scene/webgl-support", () => ({
  supportsWebGL: jest.fn(),
}));

const mockSupportsWebGL = supportsWebGL as jest.MockedFunction<typeof supportsWebGL>;

function setUrlSearch(search: string): void {
  window.history.replaceState(null, "", search || "/");
}

beforeEach(() => {
  jest.resetAllMocks();
  resetSceneTierCache();
  setUrlSearch("");
  window.localStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("readForcedTier — ?scene-tier= URL param", () => {
  it("reads the URL param when present", () => {
    setUrlSearch("/?scene-tier=flat");
    expect(readForcedTier()).toBe("flat");
  });

  it("accepts studio and depth from the URL", () => {
    setUrlSearch("/?scene-tier=studio");
    expect(readForcedTier()).toBe("studio");
    setUrlSearch("/?scene-tier=depth");
    expect(readForcedTier()).toBe("depth");
  });

  it("rejects unknown tier values from the URL (fail closed)", () => {
    setUrlSearch("/?scene-tier=ultra");
    expect(readForcedTier()).toBeUndefined();
  });

  it("URL param wins over localStorage when both are set", () => {
    window.localStorage.setItem("aerolexa:tier", "studio");
    setUrlSearch("/?scene-tier=flat");
    expect(readForcedTier()).toBe("flat");
  });
});

describe("readForcedTier — localStorage fallback", () => {
  it("falls back to localStorage when no URL param is present", () => {
    window.localStorage.setItem("aerolexa:tier", "depth");
    expect(readForcedTier()).toBe("depth");
  });

  it("rejects an invalid localStorage value (fail closed)", () => {
    window.localStorage.setItem("aerolexa:tier", "gorgeous");
    expect(readForcedTier()).toBeUndefined();
  });

  it("returns undefined when neither source sets an override", () => {
    expect(readForcedTier()).toBeUndefined();
  });
});

describe("sceneTier() consumption of the override", () => {
  it("a URL flat override wins over everything", () => {
    mockSupportsWebGL.mockReturnValue(true);
    window.localStorage.setItem("aerolexa:tier", "studio");
    setUrlSearch("/?scene-tier=flat");
    expect(sceneTier().tier).toBe("flat");
  });

  it("the cached tier clears between measurements (no stale override)", () => {
    mockSupportsWebGL.mockReturnValue(true);
    setUrlSearch("/?scene-tier=flat");
    expect(sceneTier().tier).toBe("flat");
    setUrlSearch("/?scene-tier=studio");
    resetSceneTierCache();
    expect(sceneTier().tier).toBe("studio");
  });
});

describe("detectViewerTier — shared-app override contract", () => {
  /** jsdom has no WebGL and no matchMedia; give it honest stand-ins. */
  function stubBrowserCapabilities({ webgl }: { webgl: boolean }) {
    jest
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(webgl ? ({ getExtension: () => null } as unknown as WebGLRenderingContext) : null);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: jest.fn().mockReturnValue({ matches: false } as MediaQueryList),
    });
  }

  it("honours a forced flat override from the URL (shared-viewer parity)", () => {
    stubBrowserCapabilities({ webgl: true });
    setUrlSearch("/?scene-tier=flat");
    expect(detectViewerTier().tier).toBe("flat");
  });

  it("honours a forced studio override from the URL", () => {
    stubBrowserCapabilities({ webgl: true });
    setUrlSearch("/?scene-tier=studio");
    expect(detectViewerTier().tier).toBe("studio");
  });

  it("a forced studio override still cannot conjure WebGL that does not exist", () => {
    stubBrowserCapabilities({ webgl: false });
    setUrlSearch("/?scene-tier=studio");
    expect(detectViewerTier().tier).toBe("flat");
  });
});

describe("RTL scene transforms", () => {
  it("mirrors X in RTL and keeps identity in LTR", () => {
    expect(getRTLSceneTransform(false)).toEqual({ scaleX: 1, cameraX: -1 });
    expect(getRTLSceneTransform(true)).toEqual({ scaleX: -1, cameraX: 1 });
  });
});
