import { DURATION, EASE, SPRING, STAGGER, STAGGER_MAX_STEPS, staggerDelay } from "@/lib/scene/motion";

describe("motion tokens — one physics vocabulary", () => {
  it("durations are ordered fast → slow and all frame-friendly", () => {
    expect(DURATION.fast).toBeLessThan(DURATION.base);
    expect(DURATION.base).toBeLessThan(DURATION.slow);
    expect(DURATION.slow).toBeLessThan(DURATION.scene);
    for (const ms of Object.values(DURATION)) {
      expect(ms).toBeGreaterThan(0);
      expect(Number.isInteger(ms)).toBe(true);
    }
  });

  it("easings are cubic-bezier arrays of four numbers in [0,1]", () => {
    for (const curve of Object.values(EASE)) {
      expect(curve).toHaveLength(4);
      for (const n of curve) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }
    }
    // Enter is decelerating: it starts fast and settles.
    const [x1] = EASE.enter;
    expect(x1).toBeLessThan(0.5);
  });

  it("springs are damped — no infinite oscillation", () => {
    for (const spring of Object.values(SPRING)) {
      expect(spring.damping).toBeGreaterThan(0);
      expect(spring.stiffness).toBeGreaterThan(0);
      // Under-damped but stable: damping ratio ζ = c / (2√(km)) below 1 but not near 0.
      const zeta = spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass));
      expect(zeta).toBeGreaterThan(0.5);
      expect(zeta).toBeLessThan(1);
    }
  });

  it("stagger is capped so long lists don't crawl", () => {
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(3)).toBeCloseTo(3 * STAGGER);
    expect(staggerDelay(50)).toBe(STAGGER_MAX_STEPS * STAGGER);
    expect(staggerDelay(50)).toBeLessThan(0.5);
  });
});
