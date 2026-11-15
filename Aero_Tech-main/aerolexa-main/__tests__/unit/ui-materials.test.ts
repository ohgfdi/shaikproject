/**
 * Phase 2 gate: the DOM material system.
 *
 * Three claims are checked, in increasing order of how much they matter:
 *
 *  1. **The model is physical.** The key light comes from the upper left, the
 *     fill is exactly opposite it, the elevation ladder is monotonic, and a
 *     well is concave while everything else is convex. These are oracles, not
 *     snapshots: they fail if someone re-derives the maths wrong.
 *  2. **The CSS is a faithful rendering of the model.** Every `--mat-*` token
 *     and every shadow/gradient declaration in `styles/materials.css` is
 *     re-derived here and compared. The stylesheet cannot drift into
 *     hand-tuned values without failing the suite.
 *  3. **The realism is accessible.** Shading is composited onto the real design
 *     tokens and the *worst-case* pixel is contrast-checked against the text
 *     that sits on it — for both themes and all three accent choices. Shading
 *     may never break a pairing that used to pass, may never cost more than a
 *     quarter of a pairing's headroom, and any sub-AA pairing must be an
 *     acknowledged, pre-existing one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACCENT_BAND_END,
  ACCENT_KEY_ALPHA,
  accentBandSurface,
  contrastRatio,
  convexShadow,
  convexShadowVar,
  DOM_MATERIAL_KINDS,
  effectiveAccentSurface,
  effectiveSurface,
  elevation,
  isConvex,
  LABEL_TOP,
  lightStage,
  materialTokens,
  parseHex,
  relativeLuminance,
  surfaceGradientVar,
  wellShadowVar,
  worstCaseSurface,
  type DomMaterialKind,
} from "@/lib/ui/materials";

const MATERIALS_CSS = readFileSync(join(process.cwd(), "styles/materials.css"), "utf8");
const GLOBALS_CSS = readFileSync(join(process.cwd(), "styles/globals.css"), "utf8");

/* ---------------------------------------------------------------------------
   CSS helpers
   --------------------------------------------------------------------------- */

/** All declarations inside the first block whose selector contains `needle`. */
function blockFor(css: string, needle: string): Record<string, string> {
  const start = css.indexOf(`${needle} {`);
  if (start === -1) throw new Error(`No ${needle} block`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);
  const declarations: Record<string, string> = {};
  for (const line of body.split(";")) {
    const match = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (match) declarations[match[1] as string] = match[2] as string;
  }
  return declarations;
}

/** Collapse CSS whitespace so a declaration can be compared as one string. */
function flat(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("DOM material model — the two-light stage is physical", () => {
  it("lights from the upper left, fills from exactly the opposite side", () => {
    for (const theme of ["dark", "light"] as const) {
      const stage = lightStage(theme);
      // 45deg in CSS = "from the top-left corner", which is the only direction
      // that reads as a lit face rather than as a gradient.
      expect(stage.keyAngle).toBe(45);
      expect(stage.fillAngle).toBe(stage.keyAngle + 180);
    }
  });

  it("keeps the light direction identical across themes (only intensity changes)", () => {
    // A light that moves when the user switches theme reads as a bug, not a theme.
    expect(lightStage("light").keyAngle).toBe(lightStage("dark").keyAngle);
    expect(lightStage("light").fillAngle).toBe(lightStage("dark").fillAngle);
  });

  it("scales intensity with the theme: a dark room needs less key, a white one needs fill", () => {
    const dark = lightStage("dark");
    const light = lightStage("light");
    expect(dark.keyAlpha).toBeLessThan(0.2);
    expect(light.keyAlpha).toBeGreaterThan(0.5);
    expect(dark.fillAlpha).toBeGreaterThan(light.fillAlpha);
    expect(light.occlude).toEqual([15, 23, 42]);
    expect(dark.occlude).toEqual([0, 0, 0]);
  });

  it("elevation is monotonic: higher surfaces catch more light and throw a longer shadow", () => {
    const ladder = DOM_MATERIAL_KINDS.filter(isConvex).map((kind) => ({ kind, ...elevation(kind) }));
    for (let i = 1; i < ladder.length; i++) {
      const below = ladder[i - 1] as (typeof ladder)[number];
      const above = ladder[i] as (typeof ladder)[number];
      expect(above.dy).toBeGreaterThan(below.dy);
      expect(above.blur).toBeGreaterThan(below.blur);
      expect(above.contactDy).toBeGreaterThan(below.contactDy);
      expect(above.contactBlur).toBeGreaterThan(below.contactBlur);
      expect(above.lit).toBeGreaterThan(below.lit);
      expect(above.shade).toBeGreaterThan(below.shade);
      // Shadow blur must outgrow the offset: distance is what softens a shadow.
      expect(above.blur / above.dy).toBeGreaterThan(below.blur / below.dy);
    }
  });

  it("treats inputs as concave wells and everything else as convex solids", () => {
    expect(isConvex("well")).toBe(false);
    expect(elevation("well")).toMatchObject({ dx: 0, dy: 0, lit: 0, shade: 0 });
    for (const kind of DOM_MATERIAL_KINDS.filter(isConvex)) {
      expect(isConvex(kind)).toBe(true);
      expect(elevation(kind).dy).toBeGreaterThan(0);
    }
  });

  it("shadows fall away from the key and read as two physical layers", () => {
    for (const theme of ["dark", "light"] as const) {
      for (const kind of DOM_MATERIAL_KINDS.filter(isConvex)) {
        const shadow = convexShadow(kind, theme);
        const layers = shadow.split(", ");
        // lit edge + key cast shadow + ambient contact shadow
        expect(layers).toHaveLength(3);
        expect(layers[0]).toMatch(/^inset 0 1px 0/);
        const e = elevation(kind);
        // The shadow is thrown down and to the right, i.e. away from a key
        // that comes from the upper left. A negative y would be a light from
        // below, which this model does not have.
        expect(layers[1]).toMatch(new RegExp(`^${e.dx}px ${e.dy}px ${e.blur}px `));
        expect(e.dx).toBeGreaterThan(0);
        expect(e.dy).toBeGreaterThan(0);
        expect(layers[2]).toMatch(/^0 \d+px \d+px /);
      }
      // A well's occlusion falls inward, from the top edge only.
      expect(flat(convexShadow("well", theme))).toBe("none");
    }
  });

  it("a well is shaded inward, a panel is shaded outward", () => {
    // Both stacks use inset shadows — the difference is which edge they start
    // from, and that a well has no cast shadow at all (checked above). The
    // stack is theme-independent: only its *inks* differ per theme.
    expect(flat(wellShadowVar())).toBe("inset 0 2px 4px var(--mat-inset-key), inset 0 -1px 0 var(--mat-inset-fill)");
  });
});

describe("styles/materials.css is rendered from the model", () => {
  it("declares every --mat-* token the model owns, per theme", () => {
    for (const theme of ["dark", "light"] as const) {
      const block = blockFor(MATERIALS_CSS, theme === "dark" ? "html.dark" : "html.light");
      const tokens = materialTokens(theme);
      expect(Object.keys(tokens).length).toBeGreaterThan(10);
      for (const [name, value] of Object.entries(tokens)) {
        expect(block[name]).toBe(value);
      }
    }
  });

  it("uses the same shadow stacks the model generates", () => {
    for (const kind of DOM_MATERIAL_KINDS) {
      const stack = flat(convexShadowVar(kind));
      if (kind === "well") {
        expect(stack).toBe("none");
        continue;
      }
      // The declaration may be wrapped across lines; compare whitespace-free.
      expect(MATERIALS_CSS.replace(/\s+/g, " ")).toContain(stack);
    }
  });

  it("uses the model gradients for convex surfaces and wells", () => {
    const css = MATERIALS_CSS.replace(/\s+/g, " ");
    expect(css).toContain(flat(surfaceGradientVar()));
    expect(css).toContain("linear-gradient(var(--mat-fill-angle), var(--mat-fill-ink) 0%, transparent 42%)");
  });

  it("keeps the honesty switches: reduced contrast stays legible, materials can be switched off", () => {
    expect(MATERIALS_CSS).toContain("@media (prefers-contrast: more)");
    expect(MATERIALS_CSS).toContain('html[data-materials="off"]');
    // Contrast mode keeps the depth cue but strengthens what carries meaning:
    // borders and shadows, never the text.
    const contrastBlock = MATERIALS_CSS.slice(MATERIALS_CSS.indexOf("prefers-contrast: more"));
    expect(contrastBlock).toContain("border-color: var(--line)");
    expect(contrastBlock).not.toContain("color: var(--foreground)");
  });

  it("declares the light stage in the system-preference fallback too", () => {
    // Without these, a user on OS-level light with no .light class gets dark
    // shading on a light surface.
    const fallback = MATERIALS_CSS.slice(MATERIALS_CSS.indexOf("prefers-color-scheme: light"));
    const block = blockFor(`${fallback}\n}`, "html:not(.light):not(.dark)");
    const tokens = materialTokens("light");
    for (const name of ["--mat-key-ink", "--mat-fill-ink", "--mat-inset-key", "--mat-hairline"]) {
      expect(block[name]).toBe(tokens[name]);
    }
  });
});

describe("realism without an accessibility cost", () => {
  const themes = [
    { theme: "dark", vars: blockFor(GLOBALS_CSS, "html.dark") },
    { theme: "light", vars: blockFor(GLOBALS_CSS, "html.light") },
  ] as const;

  const accents = ["teal", "blue", "violet"] as const;
  const accentBlocks = Object.fromEntries(
    accents.map((a) => [a, blockFor(GLOBALS_CSS, `html[data-accent="${a}"]`)]),
  ) as Record<(typeof accents)[number], Record<string, string>>;

  /** The real token, composited over the surface it sits on when translucent. */
  function token(vars: Record<string, string>, name: string, over?: readonly [number, number, number]) {
    const raw = vars[name];
    if (!raw) throw new Error(`Missing token ${name}`);
    // The design tokens are space-separated channels: "18 18 18" or "240 90 100 / 0.4".
    const [channels, alphaPart] = raw.split("/").map((p) => p.trim());
    const rgb = (channels ?? "")
      .split(/\s+/)
      .slice(0, 3)
      .map((c) => Number(c)) as [number, number, number];
    if (rgb.length !== 3 || rgb.some((c) => !Number.isFinite(c))) {
      throw new Error(`Unreadable token ${name}: ${raw}`);
    }
    if (!alphaPart) return rgb;
    const alpha = Number(alphaPart);
    if (!over) return rgb;
    // `bg-danger/10` is painted over the page background, not over nothing.
    const [r, g, b] = over;
    return [
      Math.round(r * (1 - alpha) + rgb[0] * alpha),
      Math.round(g * (1 - alpha) + rgb[1] * alpha),
      Math.round(b * (1 - alpha) + rgb[2] * alpha),
    ] as const;
  }

  it("keeps every button variant at or above WCAG AA (4.5:1) in its worst-case pixel", () => {
    const failures: string[] = [];
    // Pairings that were already sub-AA *before* the material system existed
    // are acknowledged explicitly rather than quietly allowed: if a new one
    // appears it fails here, and the set below is the whole known list.
    const knownSubAA = new Set(["dark/blue primary", "light/blue primary"]);
    const foundSubAA = new Set<string>();
    for (const { theme, vars } of themes) {
      const page = token(vars, "--background");
      for (const accent of accents) {
        const a = { ...vars, ...accentBlocks[accent] } as Record<string, string>;
        const onAccent = token(a, "--on-accent");
        const foreground = token(a, "--foreground");
        const cases: {
          name: string;
          base: readonly [number, number, number];
          text: readonly [number, number, number];
          kind: DomMaterialKind | "accent";
        }[] = [
          { name: "primary", base: token(a, "--accent"), text: onAccent, kind: "accent" },
          { name: "amber", base: token(a, "--amber"), text: onAccent, kind: "accent" },
          { name: "secondary", base: token(a, "--surface"), text: foreground, kind: "raised" },
          // The destructive button is solid per theme, so each theme is checked
          // against the pair it actually renders.
          theme === "light"
            ? { name: "danger", base: parseHex("#B3253C"), text: parseHex("#ffffff"), kind: "accent" }
            : { name: "danger", base: token(a, "--danger"), text: parseHex("#0a0a0a"), kind: "accent" },
          { name: "input well", base: token(a, "--surface"), text: foreground, kind: "well" },
        ];
        for (const c of cases) {
          const textIsLight = relativeLuminance(c.text) > relativeLuminance(c.base);
          const worst =
            c.kind === "accent" ? effectiveAccentSurface(c.base) : worstCaseSurface(c.base, theme, c.kind, textIsLight);
          const flatRatio = contrastRatio(c.text, c.base);
          const ratio = contrastRatio(c.text, worst);
          const label = `${theme}/${accent} ${c.name}`;
          if (ratio < 4.5) {
            if (flatRatio >= 4.5) {
              // Shading broke a pairing that used to pass: never allowed.
              failures.push(`${label}: shading dropped ${flatRatio.toFixed(2)}:1 to ${ratio.toFixed(2)}:1`);
            } else {
              foundSubAA.add(label);
            }
          }
          // Proportional budget: shading may cost contrast, but a quarter of
          // the pairing's headroom is the most it is allowed to take. The dark
          // room's key highlight necessarily lifts a surface toward light
          // text, so a small cost is physical; a large one is a design bug.
          const drift = flatRatio - ratio;
          if (flatRatio > 0 && drift / flatRatio > 0.25) {
            failures.push(
              `${label}: shading costs ${((100 * drift) / flatRatio).toFixed(1)}% of its contrast (budget 25%)`,
            );
          }
        }
      }
      // The page itself is not shaded: nothing composites onto it.
      expect(contrastRatio(token(vars, "--foreground"), page)).toBeGreaterThan(4.5);
    }
    // Only the acknowledged, pre-existing shortfalls are tolerated.
    expect([...foundSubAA].sort()).toEqual([...knownSubAA].sort());
    expect(failures).toEqual([]);
  });

  it("confines the accent specular band above the label, and keeps it legible", () => {
    // The guarantee: an accent button's label never sits on the highlight, so
    // the control's contrast is exactly its flat token's contrast.
    expect(ACCENT_BAND_END).toBeLessThan(LABEL_TOP);
    for (const base of ["#5AA8AA", "#0066FF", "#7C5CFF", "#FFC400"]) {
      const band = accentBandSurface(parseHex(base));
      // A blown-out band would be a second contrast failure in the other
      // direction, so the highlight's own peak must stay readable too.
      expect(contrastRatio(parseHex("#0a0a0a"), band)).toBeGreaterThan(4.5);
      expect(band).not.toEqual(parseHex(base));
    }
    // And the CSS honours the same geometry the model pins.
    const css = readFileSync(join(process.cwd(), "styles/materials.css"), "utf8").replace(/\s+/g, " ");
    expect(css).toContain(
      `linear-gradient(180deg, rgb(255 255 255 / ${ACCENT_KEY_ALPHA}) 0%, transparent ${ACCENT_BAND_END}%)`,
    );
  });

  it("pins the pre-existing token shortfalls so they can never silently worsen", () => {
    // Found by this gate while Phase 2 was being built, and NOT introduced by
    // the material system: the blue accent cannot reach 4.5:1 against the
    // near-black --on-accent label, because a mid-luminance blue under
    // near-black text tops out around 4.1:1. Teal, violet and amber clear it.
    // Tracked here so the number is visible and any future token change
    // re-reports it instead of hiding it. The real fix is a per-accent
    // --on-accent (the badge variants already do exactly this per theme);
    // until then the shading is required to leave the pairing untouched.
    const dark = blockFor(GLOBALS_CSS, "html.dark");
    const onAccent = token(dark, "--on-accent");
    const measured: Record<string, number> = {};
    for (const accent of accents) {
      const base = token({ ...dark, ...accentBlocks[accent] }, "--accent");
      measured[accent] = Number(contrastRatio(onAccent, base).toFixed(2));
    }
    expect(measured.teal).toBeGreaterThan(4.5);
    expect(measured.violet).toBeGreaterThan(4.5);
    expect(measured.blue).toBeLessThan(4.5);
    // Whatever it is, it must not get worse while this gate is watching.
    expect(measured.blue).toBeLessThanOrEqual(4.15);
  });

  it("shading moves the surface in the physically correct direction", () => {
    // In a dark room the key highlight can only lift a surface toward the
    // light text — a dark-theme surface being *darkened* by its own key light
    // would be the physically wrong direction, so assert the sign.
    const dark = effectiveSurface(parseHex("#121212"), "dark", "raised");
    expect(meanChannel(dark)).toBeGreaterThan(meanChannel(parseHex("#121212")));
    // In a light room the fill can only darken a white surface.
    const light = effectiveSurface(parseHex("#ffffff"), "light", "raised");
    expect(meanChannel(light)).toBeLessThan(meanChannel(parseHex("#ffffff")));
  });
});

/** Small helper so the assertions above read as plain luminance comparisons. */
function meanChannel(rgb: readonly [number, number, number]): number {
  return (rgb[0] + rgb[1] + rgb[2]) / 3;
}

describe("the app actually uses the material system", () => {
  const files = {
    button: readFileSync(join(process.cwd(), "components/ui/button.tsx"), "utf8"),
    card: readFileSync(join(process.cwd(), "components/ui/primitives.tsx"), "utf8"),
    form: readFileSync(join(process.cwd(), "components/ui/form.tsx"), "utf8"),
  };

  it("gives every button variant a material", () => {
    for (const kind of ["mat-raised", "mat-panel", "mat-accent"] as const) {
      expect(files.button).toContain(kind);
    }
    // Every declared variant must carry at least one material class. Parsed by
    // name rather than by line, so a wrapped class string cannot quietly drop
    // out of the check.
    const body = /const variants: Record<Variant, string> = \{([\s\S]*?)\n\};/.exec(files.button)?.[1] ?? "";
    const entries = [...body.matchAll(/(\w+):\s*"([^"]*)"/g)];
    expect(entries.map((m) => m[1]).sort()).toEqual(["amber", "danger", "ghost", "primary", "secondary"]);
    for (const [, , classes] of entries) {
      expect(classes).toMatch(/mat-(raised|panel|accent|well)/);
    }
  });

  it("makes cards convex and inputs concave", () => {
    expect(files.card).toContain('cn("card mat-panel", className)');
    expect(files.form).toContain("mat-well");
  });

  it("keeps the text tokens untouched — shading layers over colour, never replaces it", () => {
    // A material class must never be a substitute for the token that carries
    // the text contrast.
    expect(files.button).toContain("text-on-accent");
    expect(files.button).toContain("text-foreground");
    expect(files.form).toContain("text-foreground");
  });
});
