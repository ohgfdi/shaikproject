/**
 * Scroll progress math — pure, deterministic, allocation-free.
 *
 * The scroll dolly (S4.1) eases the hero camera between two poses as the user
 * scrolls the first viewport of the page. This module holds the arithmetic;
 * camera-rig.tsx owns the listener and the camera, so the math stays
 * node-testable against a hand-computed oracle (scene-scroll.test.ts).
 */

export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Scroll position normalised to [0, 1] over `span` pixels. A non-positive
 * span (layout not ready, zero-height viewport) collapses to 0 — never NaN.
 */
export function scrollProgress(scrollY: number, span: number): number {
  if (!(span > 0)) return 0;
  return clamp01(scrollY / span);
}

/**
 * Smoothstep easing — starts and ends with zero velocity, so the dolly never
 * snaps when scrolling begins or settles. Monotonic on [0, 1].
 */
export function smoothstep(p: number): number {
  const x = clamp01(p);
  return x * x * (3 - 2 * x);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
