/**
 * Phase 1 gate: the 3D runtime must never reach a route's first load.
 *
 * `scripts/check-bundle-budgets.mjs` proves this numerically on a real build
 * (it fails when a three.js string literal turns up in any route's
 * first-load chunks). That gate is only as good as the build it ran against,
 * and it cannot explain *why* a scene leaked. This test is the structural
 * counterpart: it walks the actual import graph from every App Router entry
 * and fails the moment a static import path exists from a route to three.js.
 *
 * What it models, and why it is faithful to how Next bundles:
 *  - `import ... from "x"` and `export ... from "x"` create a *static* edge:
 *    the module lands in the importing chunk, so it is in the first load.
 *  - `import("x")` — including every `next/dynamic(() => import("x"))` — is a
 *    *deferred* edge: a separate chunk fetched at runtime. The walk stops.
 *  - `import type { X } from "x"` is erased at compile time and is not an edge
 *    at all. So is a type specifier inside a value import (`{ a, type B }`).
 *
 * Consequence: if a route's static closure is heavy-free, three.js is not in
 * that route's first load. That is the whole Phase 1 promise, and it is now a
 * test rather than a convention.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = process.cwd();

/** Packages that drag the whole renderer in. */
const HEAVY_PACKAGES = new Set([
  "three",
  "@react-three/fiber",
  "@react-three/drei",
  "@react-three/postprocessing",
  "postprocessing",
]);

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];

interface Edges {
  static: string[];
  deferred: string[];
}

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

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** True when a static import clause carries no runtime binding. */
function isTypeOnly(clause: string): boolean {
  const c = clause.trim();
  if (/^type\b/.test(c)) return true;
  const braced = c.match(/^\{([\s\S]*)\}$/);
  if (!braced?.[1]) return false;
  const specifiers = braced[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return specifiers.length > 0 && specifiers.every((s) => /^type\s/.test(s));
}

function parseEdges(file: string): Edges {
  const source = stripComments(readFileSync(file, "utf8"));
  const staticSpecs = new Set<string>();
  const deferredSpecs = new Set<string>();

  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    deferredSpecs.add(match[1] as string);
  }

  // Statements are anchored at a line start and may not cross a semicolon, so
  // a match can never span two statements and invent an edge between them.
  for (const match of source.matchAll(/^[ \t]*(?:import|export)[ \t]+([^;]*?)[ \t]*from[ \t]*["']([^"']+)["']/gm)) {
    if (isTypeOnly(match[1] as string)) continue;
    staticSpecs.add(match[2] as string);
  }
  for (const match of source.matchAll(/^[ \t]*import[ \t]*["']([^"']+)["']/gm)) {
    staticSpecs.add(match[1] as string);
  }

  return { static: [...staticSpecs], deferred: [...deferredSpecs] };
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) {
    const base = join(ROOT, specifier.slice(2));
    return EXTENSIONS.map((ext) => base + ext).find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
  }
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(fromFile), specifier);
    return EXTENSIONS.map((ext) => base + ext).find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
  }
  return null;
}

interface ModuleNode {
  file: string;
  heavy: string[];
  static: string[];
  deferred: string[];
}

const cache = new Map<string, ModuleNode>();

function node(file: string): ModuleNode {
  const hit = cache.get(file);
  if (hit) return hit;
  const edges = parseEdges(file);
  const heavy: string[] = [];
  const staticDeps: string[] = [];
  for (const specifier of edges.static) {
    if (HEAVY_PACKAGES.has(specifier)) {
      heavy.push(specifier);
      continue;
    }
    const resolved = resolveSpecifier(file, specifier);
    if (resolved) staticDeps.push(resolved);
  }
  const deferred = edges.deferred
    .map((specifier) => resolveSpecifier(file, specifier))
    .filter((f): f is string => f !== null);
  const built: ModuleNode = { file, heavy, static: staticDeps, deferred };
  cache.set(file, built);
  return built;
}

function appEntries(): string[] {
  const entries = walkFiles(join(ROOT, "app")).filter((f) =>
    /(^|[\\/])(page|layout|route|template|loading|error|not-found|global-error|default)\.(t|j)sx?$/.test(f),
  );
  const middleware = join(ROOT, "middleware.ts");
  if (existsSync(middleware)) entries.push(middleware);
  return entries;
}

/** Every module reachable from `file` through static edges only. */
function staticClosure(file: string): Set<string> {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const dep of node(current).static) queue.push(dep);
  }
  return seen;
}

/**
 * Everything that lives in a lazily-fetched chunk: the static closure of every
 * `import()` target reachable from the route graph. A heavy module belongs
 * here iff some deferred edge reaches it, directly or through the heavy
 * modules it statically pulls in (camera-rig, postfx, the chart canvas…).
 */
function deferredClosure(): Set<string> {
  const firstLoad = new Set<string>();
  for (const entry of appEntries()) for (const m of staticClosure(entry)) firstLoad.add(m);

  const roots = new Set<string>();
  for (const file of firstLoad) for (const target of node(file).deferred) roots.add(target);
  for (const file of walkFiles(join(ROOT, "components"))) {
    for (const target of node(file).deferred) roots.add(target);
  }

  const seen = new Set<string>();
  for (const root of roots) for (const m of staticClosure(root)) seen.add(m);
  return seen;
}

describe("scene boundary — three.js stays out of every route's first load", () => {
  it("finds the App Router entry graph (guard against a vacuous pass)", () => {
    const entries = appEntries();
    expect(entries.length).toBeGreaterThan(20);
    // A route that renders 3D must exist in the graph, or the gate below is
    // measuring a codebase with no pages in it.
    expect(entries.some((f) => f.endsWith(join("app", "login", "page.tsx")))).toBe(true);
    expect(entries.some((f) => f.endsWith(join("app", "onboarding", "page.tsx")))).toBe(true);
  });

  it("no route's static import closure reaches three.js", () => {
    const violations: string[] = [];
    for (const entry of appEntries()) {
      for (const reached of staticClosure(entry)) {
        const heavy = node(reached).heavy;
        if (heavy.length > 0) {
          violations.push(
            `${relative(ROOT, entry)} → ${relative(ROOT, reached)} statically imports ${heavy.join(", ")}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("auth, hero, workspace and KPI all mount scenes through the lazy boundary", () => {
    const lazy = readFileSync(join(ROOT, "components/scene/lazy-scenes.tsx"), "utf8");
    // Every scene surface is a deferred edge, i.e. its own chunk.
    for (const specifier of [
      "./ambient-scene",
      "@/components/ui/backdrop-webgl",
      "@/components/marketing/hero-backdrop-scene",
      "@/components/dashboard/kpi-skyline-scene",
    ]) {
      expect(lazy).toContain(`import("${specifier}")`);
    }
    // And each surface's real consumer reaches it through lazy-scenes, never
    // by importing the scene module itself.
    const surfaces: [string, string][] = [
      ["components/auth/auth-shell.tsx", "LazyAmbientScene"],
      ["components/onboarding/onboarding-wizard.tsx", "LazyAmbientScene"],
      ["app/page.tsx", "LazyHeroBackdrop"],
      ["components/ui/backdrop-3d.tsx", "LazyBackdropWebGL"],
      ["components/dashboard/kpi-slabs.tsx", "LazyKpiSkylineScene"],
    ];
    for (const [file, symbol] of surfaces) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source).toContain(symbol);
      expect(source).toContain("lazy-scenes");
    }
  });

  it("every heavy component is behind a dynamic import (no eager, dead 3D)", () => {
    const lazy = deferredClosure();
    const heavyComponents = walkFiles(join(ROOT, "components"))
      .map((file) => ({ file, heavy: node(file).heavy }))
      .filter((entry) => entry.heavy.length > 0)
      .map((entry) => entry.file);

    // Sanity: the closure is not empty, or this test proves nothing.
    expect(lazy.size).toBeGreaterThan(10);

    // A heavy module outside every lazy chunk is either eagerly bundled (caught
    // above) or dead code pretending to be a feature.
    const orphans = heavyComponents.filter((file) => !lazy.has(file)).map((f) => relative(ROOT, f));
    expect(orphans).toEqual([]);
  });

  it("the bundle gate and this test agree on what 'heavy' means", () => {
    // check-bundle-budgets.mjs detects the scene chunk by a three.js string
    // literal. If that marker or the manifest source drifts, one of the two
    // gates silently stops measuring — so pin both here.
    const gate = readFileSync(join(ROOT, "scripts/check-bundle-budgets.mjs"), "utf8");
    expect(gate).toContain('const SCENE_MARKER = "WebGLRenderer: Context Lost"');
    expect(gate).toContain("app-build-manifest.json");
    // The heavy set must cover at least the renderer + the React bindings; a
    // scene can only exist with both.
    expect([...HEAVY_PACKAGES]).toEqual(expect.arrayContaining(["three", "@react-three/fiber", "@react-three/drei"]));
  });
});
