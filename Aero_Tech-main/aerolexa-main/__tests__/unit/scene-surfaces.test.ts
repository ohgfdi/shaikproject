/**
 * Phase 4 gate: the marketing/auth scene surfaces.
 *
 * The realism work is the easy half. The half that actually protects the product
 * is the set of promises around it, and those are exactly the promises a
 * screenshot won't catch:
 *
 *  1. **Determinism.** A scene that renders differently on every load turns the
 *     per-tier screenshot specs into noise. No `Math.random()`, anywhere in a
 *     scene module.
 *  2. **Decorativeness.** Every ambient/backdrop surface is aria-hidden and
 *     pointer-transparent, so it can never eat a click or be announced.
 *  3. **Tier honesty.** A flat or reduced-motion device requests no WebGL at
 *     all, and the canvas mounts only after first paint.
 *  4. **No duplicated rig.** The shared canvas owns the floor, fog and
 *     shadows; a scene that mounts its own copy pays twice and draws twice.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walkFiles(full, out);
    } else if (/\.(t|j)sx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const SCENE_MODULES = [
  "components/marketing/hero-backdrop-scene.tsx",
  "components/scene/ambient-scene.tsx",
  "components/scene/backdrop.tsx",
  "components/scene/scene-canvas.tsx",
  "components/scene/scene-environment.tsx",
];

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

/**
 * Strips comments so the determinism check cannot be satisfied by a doc comment
 * that *mentions* Math.random while explaining why it is banned — which is
 * exactly what the scene modules say today.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("scene modules are deterministic", () => {
  it("uses no Math.random() in any scene module", () => {
    // Checked across the whole scene surface, not just the files this phase
    // touched: a new scene that reaches for Math.random() would otherwise make
    // every screenshot diff a false alarm, and the failure would show up as
    // "the baseline is flaky" rather than as a bug.
    const offenders = walkFiles(join(ROOT, "components"))
      .filter((file) => /scene|backdrop|ambient|skyline/.test(file))
      .filter((file) => /Math\.random\(/.test(code(readFileSync(file, "utf8"))))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("keeps a seeded PRNG and uses it for the hero's orbits", () => {
    const hero = read("components/marketing/hero-backdrop-scene.tsx");
    expect(hero).toMatch(/function prng\(seed: number\)/);
    // Two call sites, two different seeds: the skyline and the orbits must not
    // be correlated by sharing one sequence.
    expect(hero).toMatch(/prng\(42\)/);
    expect(hero).toMatch(/prng\(1337\)/);
  });
});

describe("ambient and backdrop surfaces are decorative", () => {
  it("gives the canvas pointer-events: none at the rig, so no caller can forget it", () => {
    // The guarantee belongs in the shared rig rather than in each caller: a
    // decorative surface that intercepts a click is a bug that only shows up on
    // a slow device, and it would be one forgotten className away.
    const canvas = read("components/scene/scene-canvas.tsx");
    expect(canvas).toMatch(/pointerEvents: "none"/);
    expect(canvas).toMatch(/aria-hidden=\{ariaHidden\}/);
  });

  it("marks the surface wrappers aria-hidden", () => {
    for (const file of ["components/scene/ambient-scene.tsx", "components/marketing/hero-backdrop-scene.tsx"]) {
      expect(read(file)).toContain("aria-hidden");
    }
  });

  it("has every ambient caller pass a pointer-transparent class", () => {
    for (const file of ["components/auth/auth-shell.tsx", "components/onboarding/onboarding-wizard.tsx"]) {
      const source = read(file);
      expect(source).toContain("LazyAmbientScene");
      expect(source).toMatch(/<LazyAmbientScene[\s\S]{0,200}pointer-events-none/);
    }
  });

  it("gates the ambient scene to nothing on a flat tier and mounts it after first paint", () => {
    const source = read("components/scene/ambient-scene.tsx");
    expect(source).toMatch(/cap\.tier === "flat"/);
    // Same idle-defer contract as the hero (S4.2): the form or the wizard owns
    // the first paint.
    expect(source).toContain("whenIdle");
    expect(source).toMatch(/!idleReady/);
  });

  it("gates the hero to nothing on a flat tier and mounts it after first paint", () => {
    const source = read("components/marketing/hero-backdrop-scene.tsx");
    expect(source).toMatch(/cap\.tier === "flat"/);
    expect(source).toContain("whenIdle");
  });
});

describe("the onboarding wizard has a scene, behind every boundary", () => {
  const wizard = read("components/onboarding/onboarding-wizard.tsx");

  it("mounts the ambient scene through the dynamic wrapper", () => {
    expect(wizard).toContain("LazyAmbientScene");
    expect(wizard).toContain("lazy-scenes");
    // Never a direct import of the scene module — that would put three.js in
    // the onboarding route's first load.
    expect(wizard).not.toMatch(/from "@\/components\/scene\/ambient-scene"/);
  });

  it("mounts it behind the content, not over it", () => {
    // A decorative canvas in front of the form would swallow every click.
    expect(wizard).toMatch(/-z-10|isolate/);
    expect(wizard).toContain("pointer-events-none");
  });

  it("uses its own composition, so onboarding is not the login screen's scene", () => {
    expect(wizard).toContain('variant="onboarding"');
    const scene = read("components/scene/ambient-scene.tsx");
    expect(scene).toContain("onboarding");
    // Two distinct compositions: onboarding has no card, so it gets a wider,
    // lifted field; auth has to stay quiet behind a login form.
    expect(scene).toMatch(/auth: \{ count: 9/);
    expect(scene).toMatch(/onboarding: \{ count: 13/);
    expect(scene).toMatch(/lift: 0(?!\.25)/);
    expect(scene).toMatch(/lift: 0\.25/);
  });
});

describe("the shared rig is not duplicated per scene", () => {
  it("mounts the data floor once, in SceneCanvas", () => {
    const canvas = read("components/scene/scene-canvas.tsx");
    expect(canvas).toContain("<SceneFloor");
    // Exactly one Grid in the rig — the floor. Anything else is a second
    // floor drawn on top of the first.
    expect((canvas.match(/<Grid/g) ?? []).length).toBe(1);
  });

  it("has no scene mounting its own Grid on top of the shared floor", () => {
    // The hero used to do exactly this: an identical <Grid> at the same
    // position, doubling the floor's draw calls and drawing every line twice.
    for (const file of SCENE_MODULES.filter((f) => !f.endsWith("scene-canvas.tsx"))) {
      const source = read(file);
      expect(source).not.toMatch(/<Grid\b/);
    }
  });

  it("makes the gradient backdrop opt-in, so chart scenes stay transparent", () => {
    const canvas = read("components/scene/scene-canvas.tsx");
    expect(canvas).toMatch(/backdrop\?: BackdropVariant/);
    expect(canvas).toMatch(/\{backdrop && <GradientBackdrop/);
    // Charts are drawn on the page's own background; a sky behind them would
    // fight the surface they sit on.
    for (const file of ["components/charts/3d/scene.tsx", "components/charts/3d/donut.tsx"]) {
      expect(read(file)).not.toMatch(/backdrop=/);
    }
  });
});
