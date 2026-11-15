import { lerp, scrollProgress, smoothstep } from "@/lib/scene/scroll";

/**
 * Oracle for the scroll-dolly math (S4.1): every expected number below is
 * hand-computed, matching the discipline of the other scene suites. The rig
 * consumes these functions verbatim, so pinning them pins the dolly.
 */

describe("scroll math — hand-computed oracle", () => {
  it("normalises scrollY over the span", () => {
    expect(scrollProgress(0, 900)).toBe(0);
    expect(scrollProgress(450, 900)).toBe(0.5);
    expect(scrollProgress(900, 900)).toBe(1);
  });

  it("clamps both ends — no negative progress, no overshoot", () => {
    expect(scrollProgress(-120, 900)).toBe(0);
    expect(scrollProgress(1800, 900)).toBe(1);
  });

  it("collapses a non-positive span to 0 (layout not ready), never NaN", () => {
    expect(scrollProgress(500, 0)).toBe(0);
    expect(scrollProgress(500, -10)).toBe(0);
  });

  it("treats a NaN scroll read as zero progress", () => {
    expect(scrollProgress(Number.NaN, 900)).toBe(0);
  });

  it("smoothstep: zero velocity at both ends, fixed midpoint", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
    // Hand-computed midpoint check: x*x*(3-2x) at x=0.25 → 0.15625.
    expect(smoothstep(0.25)).toBe(0.15625);
  });

  it("smoothstep is monotonic on [0, 1] — the dolly never reverses", () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = smoothstep(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it("lerp interpolates linearly, including extrapolation-free ends", () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(lerp(13, 23.4, 0)).toBe(13);
    expect(lerp(13, 23.4, 1)).toBeCloseTo(23.4);
  });

  it("the default dolly target is 78% of the way toward the origin", () => {
    // Hand-computed for the hero camera [0, 13, 30]: to = base * 0.78.
    const base: [number, number, number] = [0, 13, 30];
    const t = smoothstep(1);
    expect(lerp(base[0], base[0] * 0.78, t)).toBe(0);
    expect(lerp(base[1], base[1] * 0.78, t)).toBeCloseTo(10.14);
    expect(lerp(base[2], base[2] * 0.78, t)).toBeCloseTo(23.4);
  });
});
