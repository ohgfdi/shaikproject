/**
 * DOM material system — the CSS twin of `lib/scene/materials.ts`.
 *
 * The 3D side already lights the app from a two-light stage: a cool key from
 * above-left and a warm fill from below-right (`roomPanels()` in
 * `lib/scene/environment.ts`, `SceneLights` in `components/scene/scene-canvas.tsx`).
 * This module expresses the *same* stage for DOM surfaces, so a card and the
 * scene behind it look like they live in the same room instead of two
 * different design languages.
 *
 * The physical model, kept deliberately small:
 *
 *   - **Key light** — direction and strength of the highlight. Upper-left,
 *     matching the environment's key panel at (-6, +9, +5).
 *   - **Fill light** — the opposite, weaker light. Lit upper-left / shaded
 *     lower-right is the only honest read of a single key; a symmetric
 *     gradient looks like a gradient, not like a lit object.
 *   - **Elevation** — a 0…1 ladder per surface kind. Higher surfaces catch
 *     more key on their top face and cast a longer, softer key shadow plus a
 *     separate ambient contact shadow. Two shadow layers, because one shadow
 *     never looks physical.
 *   - **Convexity** — panels and buttons are convex (outer shadow, inset lit
 *     edge); inputs are wells, which are concave (inset key shadow on the top
 *     edge, inset bounce on the bottom). Same lights, opposite geometry.
 *
 * This module is the numeric source of truth: `styles/materials.css` renders
 * these values verbatim, and `__tests__/unit/ui-materials.test.ts` fails if the
 * two ever drift. The CSS also works with JavaScript disabled, which injecting
 * the values at runtime would not.
 */

export type DomTheme = "dark" | "light";

/** Surfaces, from resting on the ground up to floating above it. */
export type DomMaterialKind = "well" | "panel" | "raised" | "floating";

export const DOM_MATERIAL_KINDS: readonly DomMaterialKind[] = ["well", "panel", "raised", "floating"];

export interface LightStage {
  /**
   * CSS gradient angle of the key highlight: 45deg = "from the upper left",
   * which is how a gradient reads as a lit face. Theme-independent — a light
   * does not move when the theme switches, only its intensity changes.
   */
  keyAngle: number;
  /** Gradient angle of the fill light: exactly 180deg from the key. */
  fillAngle: number;
  /** Key highlight alpha — the soft, wide falloff across the lit face. */
  keyAlpha: number;
  /** Key alpha for the top edge line, the brightest lit pixel of a solid. */
  keyEdgeAlpha: number;
  /** Fill alpha on the shaded side. */
  fillAlpha: number;
  /** Cast-shadow alpha (the key's occlusion). */
  shadowAlpha: number;
  /** Ambient/contact-shadow alpha. */
  ambientAlpha: number;
  /** Inset key occlusion inside a well. */
  insetKeyAlpha: number;
  /** Bounce light inside a well. */
  insetFillAlpha: number;
  /** Neutral hairline separating a surface from what is behind it. */
  hairlineAlpha: number;
  /**
   * Occlusion colour. Pure black in the dark theme reads as "no light"; in the
   * light theme a slightly blue-slate shadow is what a real room does, and it
   * keeps shadows from going muddy on white.
   */
  occlude: Rgb;
}

const DARK: LightStage = {
  keyAngle: 45,
  fillAngle: 225,
  keyAlpha: 0.045,
  keyEdgeAlpha: 0.09,
  fillAlpha: 0.3,
  shadowAlpha: 0.5,
  ambientAlpha: 0.3,
  insetKeyAlpha: 0.4,
  insetFillAlpha: 0.05,
  hairlineAlpha: 0.07,
  occlude: [0, 0, 0],
};

const LIGHT: LightStage = {
  keyAngle: 45,
  fillAngle: 225,
  keyAlpha: 0.55,
  keyEdgeAlpha: 0.9,
  fillAlpha: 0.1,
  shadowAlpha: 0.14,
  ambientAlpha: 0.08,
  insetKeyAlpha: 0.12,
  insetFillAlpha: 0.9,
  hairlineAlpha: 0.08,
  occlude: [15, 23, 42],
};

export function lightStage(theme: DomTheme): LightStage {
  return theme === "dark" ? DARK : LIGHT;
}

export interface Elevation {
  /** Cast-shadow offset along the key direction, px. */
  dx: number;
  dy: number;
  /** Key-shadow blur. Grows faster than the offset: distance softens. */
  blur: number;
  /** Ambient contact shadow: tight, directly under the object. */
  contactDy: number;
  contactBlur: number;
  /** Fraction of the full key highlight this surface catches. */
  lit: number;
  /** Fraction of the full shadow this surface casts. */
  shade: number;
}

/**
 * The elevation ladder. Monotonic in every column — that is the whole point: a
 * higher surface must catch more light and throw a longer, softer shadow, or
 * the depth cue collapses back into decoration.
 */
const ELEVATION: Record<DomMaterialKind, Elevation> = {
  well: { dx: 0, dy: 0, blur: 0, contactDy: 0, contactBlur: 0, lit: 0, shade: 0 },
  panel: { dx: 1, dy: 2, blur: 8, contactDy: 1, contactBlur: 2, lit: 0.6, shade: 0.55 },
  raised: { dx: 2, dy: 4, blur: 18, contactDy: 2, contactBlur: 4, lit: 0.85, shade: 0.8 },
  floating: { dx: 6, dy: 12, blur: 72, contactDy: 4, contactBlur: 10, lit: 1, shade: 1 },
};

export function elevation(kind: DomMaterialKind): Elevation {
  return ELEVATION[kind];
}

/** A well is carved into the surface; everything else sits on it. */
export function isConvex(kind: DomMaterialKind): boolean {
  return kind !== "well";
}

/* ---------------------------------------------------------------------------
   Colour maths — lets the tests prove the shading stays accessible
   --------------------------------------------------------------------------- */

export type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];

/** Parse `#rgb` / `#rrggbb` into 8-bit channels. */
export function parseHex(hex: string): Rgb {
  const value = hex.replace("#", "").trim();
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`Not a hex colour: ${hex}`);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/** Alpha-composite `over` onto `base`, the way a browser flattens layers. */
export function composite(base: Rgb, over: Rgb, alpha: number): Rgb {
  const a = Math.min(1, Math.max(0, alpha));
  return [
    Math.round(base[0] * (1 - a) + over[0] * a),
    Math.round(base[1] * (1 - a) + over[1] * a),
    Math.round(base[2] * (1 - a) + over[2] * a),
  ];
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque colours (1…21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The colour a surface actually ends up as once the shading is flattened —
 * what a user sees and what a contrast check must be run against. The key and
 * fill layers are wide, soft gradients, so the middle of a surface sits
 * roughly halfway up each: half the fill, then half of the key it catches.
 */
export function effectiveSurface(base: Rgb, theme: DomTheme, kind: DomMaterialKind): Rgb {
  if (!isConvex(kind)) return base;
  const stage = lightStage(theme);
  const shaded = composite(base, stage.occlude, stage.fillAlpha / 2);
  return composite(shaded, WHITE, (stage.keyAlpha * ELEVATION[kind].lit) / 2);
}

/**
 * The most extreme colour the shading can produce on a surface, chosen by which
 * direction actually hurts the text sitting on it: light text loses contrast
 * against the *lightest* pixel the key can make, dark text loses contrast
 * against the *darkest* pixel the fill can make. Checking only one of the two
 * would let half the shading through unexamined.
 */
export function worstCaseSurface(base: Rgb, theme: DomTheme, kind: DomMaterialKind, textIsLight: boolean): Rgb {
  const stage = lightStage(theme);
  // A well only ever darkens (its bounce is a light inset on a light edge), so
  // for light text the well is its own worst case; for dark text it is the
  // fill stop at full strength.
  if (!isConvex(kind)) {
    return textIsLight ? base : composite(base, stage.occlude, stage.fillAlpha);
  }
  const lit = composite(base, WHITE, stage.keyAlpha * ELEVATION[kind].lit);
  const shaded = composite(base, stage.occlude, stage.fillAlpha);
  return textIsLight ? lit : shaded;
}

/**
 * The accent surface (.mat-accent) is a different geometry, not a different
 * colour: a *specular band* across the top 22% of the control, the way a
 * bevel catches a key light at a grazing angle.
 *
 * It is deliberately not a full-surface wash, and that is a correctness
 * decision rather than a taste one. A primary button's label is near-black, and
 * any wash that lightens or darkens the whole control moves the surface toward
 * the text and costs contrast — a 22% white wash drops the blue accent from
 * 4.10:1 to 3.11:1. Confining the highlight above the label (the label box
 * starts at 28% of a 36px control) means the rendered contrast of every accent
 * button is exactly the contrast of its flat token, and the button still gets a
 * real highlight.
 */
export const ACCENT_KEY_ALPHA = 0.22;
/** Where the specular band ends, as a percentage of the control's height. */
export const ACCENT_BAND_END = 22;
/** Where a centred control's label box starts. The band must end above it. */
export const LABEL_TOP = 28;

/** Mid-surface colour of an accent surface: the flat token, by construction. */
export function effectiveAccentSurface(base: Rgb): Rgb {
  return base;
}

/**
 * The brightest pixel of the specular band. Asserted against the label colour
 * too: a highlight strong enough to blow the surface out would be a second
 * contrast failure, just in the other direction.
 */
export function accentBandSurface(base: Rgb): Rgb {
  return composite(base, WHITE, ACCENT_KEY_ALPHA);
}

/* ---------------------------------------------------------------------------
   The CSS layer — rendered from the numbers above
   --------------------------------------------------------------------------- */

function alpha(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** `rgb(r g b / a)` — the occlusion colour, tinted per theme. */
function shade(a: number, theme: DomTheme): string {
  const [r, g, b] = lightStage(theme).occlude;
  return `rgb(${r} ${g} ${b} / ${alpha(a)})`;
}

/** The lit-edge / key highlight colour: white in both themes. */
function key(a: number): string {
  return `rgb(255 255 255 / ${alpha(a)})`;
}

/**
 * The `box-shadow` stack for a convex surface, as literal CSS. Lit top edge
 * first, then the key's cast shadow, then the ambient contact shadow.
 */
export function convexShadow(kind: DomMaterialKind, theme: DomTheme): string {
  const stage = lightStage(theme);
  const e = ELEVATION[kind];
  if (!isConvex(kind)) return "none";
  return [
    `inset 0 1px 0 ${key(stage.keyEdgeAlpha)}`,
    `${e.dx}px ${e.dy}px ${e.blur}px ${shade(stage.shadowAlpha * e.shade, theme)}`,
    `0 ${e.contactDy}px ${e.contactBlur}px ${shade(stage.ambientAlpha * e.shade, theme)}`,
  ].join(", ");
}

/** The `box-shadow` stack for a well: the key occlusion falls inward. */
export function wellShadow(theme: DomTheme): string {
  const stage = lightStage(theme);
  return [`inset 0 2px 4px ${shade(stage.insetKeyAlpha, theme)}`, `inset 0 -1px 0 ${key(stage.insetFillAlpha)}`].join(
    ", ",
  );
}

/** The same stacks written against CSS variables, i.e. what globals.css holds. */
export function convexShadowVar(kind: DomMaterialKind): string {
  const e = ELEVATION[kind];
  if (!isConvex(kind)) return "none";
  const step = `${Math.round(e.shade * 100)}`;
  return [
    "inset 0 1px 0 var(--mat-edge-ink)",
    `${e.dx}px ${e.dy}px ${e.blur}px var(--mat-shadow-key-${step})`,
    `0 ${e.contactDy}px ${e.contactBlur}px var(--mat-shadow-ambient-${step})`,
  ].join(", ");
}

export function wellShadowVar(): string {
  return "inset 0 2px 4px var(--mat-inset-key), inset 0 -1px 0 var(--mat-inset-fill)";
}

/** The key/fill gradient stack that shades a convex surface. */
export function surfaceGradientVar(): string {
  return (
    "radial-gradient(120% 140% at 0% 0%, var(--mat-key-ink) 0%, transparent 55%)," +
    ` linear-gradient(var(--mat-fill-angle), transparent 55%, var(--mat-fill-ink) 100%)`
  );
}

/** The gradient that carves a well: shadow falling in from the top edge. */
export function wellGradientVar(): string {
  return "linear-gradient(var(--mat-fill-angle), var(--mat-fill-ink) 0%, transparent 42%)";
}

/**
 * Every `--mat-*` custom property this module owns, per theme. The shadow
 * stacks need one alpha step per elevation rung, so switching the theme
 * re-tints every surface without re-tuning any of them.
 */
export function materialTokens(theme: DomTheme): Record<string, string> {
  const stage = lightStage(theme);
  const tokens: Record<string, string> = {
    "--mat-key-angle": `${stage.keyAngle}deg`,
    "--mat-fill-angle": `${stage.fillAngle}deg`,
    "--mat-key-ink": key(stage.keyAlpha),
    "--mat-edge-ink": key(stage.keyEdgeAlpha),
    "--mat-fill-ink": shade(stage.fillAlpha, theme),
    "--mat-inset-key": shade(stage.insetKeyAlpha, theme),
    "--mat-inset-fill": key(stage.insetFillAlpha),
    "--mat-hairline": shade(stage.hairlineAlpha, theme),
  };
  for (const kind of DOM_MATERIAL_KINDS) {
    if (!isConvex(kind)) continue;
    const { shade: factor } = ELEVATION[kind];
    const step = Math.round(factor * 100);
    tokens[`--mat-shadow-key-${step}`] = shade(stage.shadowAlpha * factor, theme);
    tokens[`--mat-shadow-ambient-${step}`] = shade(stage.ambientAlpha * factor, theme);
  }
  return tokens;
}
