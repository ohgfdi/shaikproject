/**
 * Motion tokens — one physics vocabulary for the whole app.
 *
 * DOM animation (framer-motion) and scene animation (R3F useFrame) read the
 * same tokens here, so a card tilt and a camera dolly feel like one world.
 * Values are deliberately few and named for intent, not for numbers: every
 * component picks an intent, never a raw duration.
 *
 * Reduced motion is a tier-level contract (lib/scene/tier.ts): the tier drops
 * to flat, and components additionally read `prefers-reduced-motion` via
 * framer-motion's useReducedMotion for DOM-level restraint.
 */

export const DURATION = {
  /** Micro feedback: hovers, focus rings, icon nudges. */
  fast: 120,
  /** Standard transitions: panels, list stagger. */
  base: 180,
  /** Emphasized transitions: page-level entrances. */
  slow: 240,
  /** Scene entrances and value-change animations. */
  scene: 700,
} as const;

export const EASE = {
  /** Things entering the screen. */
  enter: [0.16, 1, 0.3, 1] as const,
  /** Things leaving the screen — quicker than they arrive. */
  exit: [0.4, 0, 1, 1] as const,
  /** The single "expensive" curve for hero moments. */
  emphasized: [0.22, 1, 0.36, 1] as const,
} as const;

export const SPRING = {
  /** UI elements: quick settle, no bounce. */
  snap: { stiffness: 170, damping: 26, mass: 1 },
  /** Cards and scenes: a touch softer. */
  soft: { stiffness: 120, damping: 16, mass: 1 },
  /** Hero/large surfaces: heavy, cinematic. */
  heavy: { stiffness: 90, damping: 18, mass: 1 },
} as const;

/** Stagger between list/card entrances — capped so long lists don't crawl. */
export const STAGGER = 0.05;
export const STAGGER_MAX_STEPS = 8;

export function staggerDelay(index: number): number {
  return Math.min(index, STAGGER_MAX_STEPS) * STAGGER;
}
