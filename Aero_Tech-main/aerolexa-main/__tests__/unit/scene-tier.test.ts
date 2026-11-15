import { computeSceneTier, resetSceneTierCache } from "@/lib/scene/tier";
import { supportsWebGL } from "@/lib/scene/webgl-support";

jest.mock("@/lib/scene/webgl-support", () => ({
  supportsWebGL: jest.fn(),
}));

const mockSupportsWebGL = supportsWebGL as jest.MockedFunction<typeof supportsWebGL>;

beforeEach(() => {
  jest.resetAllMocks();
  resetSceneTierCache();
});

describe("scene tier — hardware measurement", () => {
  it("flat when WebGL is unavailable (e.g. SSR or a CPU without a GPU)", () => {
    mockSupportsWebGL.mockReturnValue(false);
    const cap = computeSceneTier({ dpr: 2, hardwareConcurrency: 16, deviceMemory: 16 });
    expect(cap.tier).toBe("flat");
    expect(cap.webgl).toBe(false);
    expect(cap.effects).toBe(false);
    expect(cap.shadows).toBe(false);
    expect(cap.reason).toBe("no-webgl");
  });

  it("flat (and no canvas) when the user asks for reduced motion — even with a strong GPU", () => {
    mockSupportsWebGL.mockReturnValue(true);
    const cap = computeSceneTier({ dpr: 2, hardwareConcurrency: 16, deviceMemory: 16, prefersReducedMotion: true });
    expect(cap.tier).toBe("flat");
    expect(cap.reason).toBe("prefers-reduced-motion");
    expect(cap.dpr).toBe(1);
  });

  it("studio only on a genuinely capable machine", () => {
    mockSupportsWebGL.mockReturnValue(true);
    const cap = computeSceneTier({ dpr: 2, hardwareConcurrency: 8, deviceMemory: 8 });
    expect(cap.tier).toBe("studio");
    expect(cap.effects).toBe(true);
    expect(cap.shadows).toBe(true);
    expect(cap.detail).toBe(1);
  });

  it("depth on mid-range hardware (no postprocessing, lower detail)", () => {
    mockSupportsWebGL.mockReturnValue(true);
    const cap = computeSceneTier({ dpr: 1.5, hardwareConcurrency: 4, deviceMemory: 4 });
    expect(cap.tier).toBe("depth");
    expect(cap.effects).toBe(false);
    expect(cap.shadows).toBe(false);
    expect(cap.detail).toBeLessThan(1);
  });

  it("never exceeds a 2x device pixel ratio", () => {
    mockSupportsWebGL.mockReturnValue(true);
    const cap = computeSceneTier({ dpr: 3, hardwareConcurrency: 8, deviceMemory: 8 });
    expect(cap.dpr).toBeLessThanOrEqual(2);
  });

  it("forceTier overrides the heuristics (used by the theme/tier switcher)", () => {
    mockSupportsWebGL.mockReturnValue(true);
    expect(computeSceneTier({ dpr: 1, hardwareConcurrency: 2, deviceMemory: 2, forceTier: "studio" }).tier).toBe(
      "studio",
    );
    expect(computeSceneTier({ dpr: 2, hardwareConcurrency: 16, deviceMemory: 16, forceTier: "flat" }).tier).toBe(
      "flat",
    );
  });
});

describe("scene tier — consumption", () => {
  it("computeSceneTier is pure: same inputs, same capability", () => {
    mockSupportsWebGL.mockReturnValue(true);
    const inputs = { dpr: 1.5, hardwareConcurrency: 4, deviceMemory: 4 };
    expect(computeSceneTier(inputs)).toEqual(computeSceneTier(inputs));
  });

  it("depth tier keeps the grid but drops fog-demanding effects", () => {
    mockSupportsWebGL.mockReturnValue(true);
    const cap = computeSceneTier({ dpr: 1.25, hardwareConcurrency: 2, deviceMemory: 4 });
    expect(cap.tier).toBe("depth");
    expect(cap.dpr).toBe(1.25);
  });
});
