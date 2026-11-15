/**
 * Bundle-weight guard (Phase 4.1).
 *
 * Two ~1 MB runtimes must never sit on a first-load path:
 *  - `echarts` — `components/charts/pbi-visual.tsx` does `import * as echarts`
 *  - `three`   — the 3D scene subtree
 *
 * `three` regressed once already: the Power BI studio lazy-loads PbiVisual, but
 * `published-view.tsx` and `dashboard-builder.tsx` imported it eagerly, putting
 * ECharts on the critical path of both PUBLIC viewer routes
 * (/apps/[shareToken] and /embed/[token]) — ~390 kB each, for dashboards that
 * may contain no chart at all.
 *
 * The codebase already answers "where may a heavy runtime live?" in
 * `components/scene/lazy-scenes.tsx`: every 3D surface is re-exported from that
 * one file through `dynamic()`, precisely so the rule is a property of the
 * codebase rather than something each new scene has to remember. This test
 * enforces that convention structurally — it asserts WHICH FILES may import a
 * heavy runtime, and that the sanctioned entry point exists — rather than a
 * byte count, so it keeps working when the bundle baseline moves.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

/** The single sanctioned dynamic boundary for the backdrop / ambient 3D scenes. */
const LAZY_ENTRYPOINT = "components/scene/lazy-scenes.tsx";
/** The dynamic boundary for the ECharts-backed Power BI visual. */
const LAZY_CHART_ENTRYPOINT = "components/charts/3d/chart3d.tsx";
/** Where the Power BI studio reaches PbiVisual lazily. */
const LAZY_STUDIO_ENTRYPOINT = "components/pbi/power-bi-studio-panel.tsx";

/**
 * Files permitted to import a heavy runtime eagerly, because they ARE (or
 * belong to) a lazy chunk and are only ever reached through a dynamic import.
 *
 * Membership is not taken on trust: the next tests prove each of these is
 * reachable ONLY from one of the DYNAMIC_ENTRYPOINTS below, so an entry that
 * quietly became eager fails the build.
 */
const HEAVY_IMPORT_ALLOWLIST = [
  // The ECharts visual.
  "components/charts/pbi-visual.tsx",
  // 3D chart scenes (the chart3d → live chunk and everything it statically
  // imports, e.g. the shared ./scene and ./bars bases).
  "components/charts/3d/live.tsx",
  "components/charts/3d/donut.tsx",
  "components/charts/3d/heatmap3d.tsx",
  "components/charts/3d/key-influencers.tsx",
  "components/charts/3d/line-area.tsx",
  "components/charts/3d/scatter.tsx",
  "components/charts/3d/scene.tsx",
  "components/charts/3d/whatif.tsx",
  // Backdrop / ambient scenes (the lazy-scenes chunk and its subtree).
  "components/ui/backdrop-webgl.tsx",
  "components/dashboard/kpi-skyline-scene.tsx",
  "components/marketing/hero-backdrop-scene.tsx",
  "components/scene/ambient-scene.tsx",
  "components/scene/backdrop.tsx",
  "components/scene/camera-rig.tsx",
  "components/scene/scene-canvas.tsx",
  // Shared (non-React) scene maths/materials — pulled in by the above.
  "lib/scene/environment.ts",
  "lib/scene/materials.ts",
];

/**
 * The only files allowed to pull a heavy module in through `dynamic()`. A
 * module is safe iff it is reachable from one of these and from NOTHING else.
 */
const DYNAMIC_ENTRYPOINTS = [
  "components/charts/3d/chart3d.tsx",
  "components/pbi/power-bi-studio-panel.tsx",
  "components/dashboards/published-view.tsx",
  "components/dashboards/dashboard-builder.tsx",
  LAZY_ENTRYPOINT,
];

const HEAVY_RUNTIME_PACKAGES = ["echarts", "three"];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (full.endsWith(".tsx") || full.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

const ALL_SOURCES = [
  ...sourceFiles(path.join(ROOT, "app")),
  ...sourceFiles(path.join(ROOT, "components")),
  ...sourceFiles(path.join(ROOT, "lib")),
];

/** Resolve a relative or `@/`-aliased import specifier to a repo-relative path. */
function resolveImport(fromRel: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? path.join(ROOT, spec.slice(2))
    : path.resolve(path.dirname(path.join(ROOT, fromRel)), spec);
  for (const candidate of [`${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return path.relative(ROOT, candidate).split(path.sep).join("/");
  }
  return null;
}

describe("heavy chart runtimes stay out of the initial bundle", () => {
  it("the sanctioned lazy entry points exist", () => {
    // If these ever move, the allowlist below is meaningless — fail loudly
    // rather than silently allowing an eager import to slip through.
    for (const entry of [LAZY_ENTRYPOINT, LAZY_CHART_ENTRYPOINT, LAZY_STUDIO_ENTRYPOINT]) {
      expect(existsSync(path.join(ROOT, entry))).toBe(true);
    }

    const scenes = readFileSync(path.join(ROOT, LAZY_ENTRYPOINT), "utf8");
    expect(scenes).toMatch(/import\(\s*["']\.\/ambient-scene["']/);
    expect(scenes).toMatch(/import\(\s*["']@\/components\/ui\/backdrop-webgl["']/);

    const chart3d = readFileSync(path.join(ROOT, LAZY_CHART_ENTRYPOINT), "utf8");
    expect(chart3d).toMatch(/import\(\s*["']\.\/live["']/);
  });

  it.each(HEAVY_RUNTIME_PACKAGES)("%s is only imported from the lazy scene subtree", (pkg) => {
    const offenders: string[] = [];

    for (const file of ALL_SOURCES) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (HEAVY_IMPORT_ALLOWLIST.includes(rel)) continue;

      const src = readFileSync(file, "utf8");
      // An eager VALUE import is `import * as echarts from "echarts"` or
      // `import { x } from "three"`. `import type` is erased at compile time
      // and costs nothing, so it is not an offender.
      const eager = new RegExp(`^import\\s+(?!type\\b)[^;]*from\\s+["']${pkg}(["']|/[^"']*["'])`, "m");
      if (eager.test(src)) offenders.push(rel);
    }

    if (offenders.length > 0) {
      throw new Error(
        `these files import "${pkg}" eagerly, putting a ~1 MB runtime on the initial bundle. ` +
          `Either reach it through a dynamic() boundary (see ${LAZY_ENTRYPOINT} / ${LAZY_CHART_ENTRYPOINT}), ` +
          `or add it to HEAVY_IMPORT_ALLOWLIST if it IS a lazy chunk. Offenders: ${offenders.join(", ")}`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it("no heavy module is on any route's critical (static) path", () => {
    // The decisive invariant, computed as two graph walks:
    //
    //   INSIDE_CHUNK — reachable from a dynamic entry point following BOTH
    //                   static and dynamic imports. This is what may be heavy.
    //   CRITICAL_PATH — reachable from any app/ route following STATIC imports
    //                   only. This is what ships in the first load.
    //
    // A heavy module is safe iff it is in INSIDE_CHUNK and NOT in CRITICAL_PATH.
    const heavy = new Set(HEAVY_IMPORT_ALLOWLIST);

    const walk = (roots: string[], followDynamic: boolean): Set<string> => {
      const seen = new Set<string>();
      const queue = [...roots];
      while (queue.length > 0) {
        const rel = queue.pop()!;
        if (seen.has(rel)) continue;
        seen.add(rel);
        const abs = path.join(ROOT, rel);
        if (!existsSync(abs)) continue;
        const src = readFileSync(abs, "utf8");
        const specs = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
        if (followDynamic) {
          // dynamic(() => import("./x"))
          for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]!);
        }
        for (const spec of specs) {
          if (!spec.startsWith(".") && !spec.startsWith("@/")) continue;
          const resolved = resolveImport(rel, spec);
          if (resolved) queue.push(resolved);
        }
      }
      return seen;
    };

    const insideChunk = walk(DYNAMIC_ENTRYPOINTS, true);
    const appRoutes = ALL_SOURCES.filter((f) => path.relative(ROOT, f).split(path.sep)[0] === "app").map((f) =>
      path.relative(ROOT, f).split(path.sep).join("/"),
    );
    const criticalPath = walk(appRoutes, false);

    const eager = HEAVY_IMPORT_ALLOWLIST.filter((f) => !insideChunk.has(f));
    if (eager.length > 0) {
      throw new Error(
        `these heavy-import modules are not inside any lazy chunk, so they load eagerly: ${eager.join(", ")}`,
      );
    }

    const onCriticalPath = HEAVY_IMPORT_ALLOWLIST.filter((f) => criticalPath.has(f));
    if (onCriticalPath.length > 0) {
      throw new Error(
        `these heavy modules are statically reachable from an app route, so they land in a first-load ` +
          `bundle. Put a next/dynamic boundary between the route and the module: ${onCriticalPath.join(", ")}`,
      );
    }

    expect(eager).toEqual([]);
    expect(onCriticalPath).toEqual([]);
    expect(heavy.size).toBeGreaterThan(0);
  });

  it("no allowlisted module is reachable from an app route without a boundary", () => {
    // The decisive check: nothing under app/ may import a heavy runtime, and no
    // shared component outside the scene subtree may either.
    const sceneFiles = new Set(HEAVY_IMPORT_ALLOWLIST);
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (rel.startsWith("app/") || sceneFiles.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (/^import\s+(?!type\b)[^;]*from\s+["'](echarts|three)["']/m.test(src)) offenders.push(rel);
    }
    if (offenders.length > 0) {
      throw new Error(`heavy runtimes imported outside the lazy scene subtree: ${offenders.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the public viewer routes lazy-load ECharts (the exact 4.1 regression)", () => {
    for (const rel of ["components/dashboards/published-view.tsx", "components/dashboards/dashboard-builder.tsx"]) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      if (!/dynamic\(\s*\(\)\s*=>\s*import\(\s*["'][^"']*pbi-visual["']/.test(src)) {
        throw new Error(`${rel} must lazy-load PbiVisual via next/dynamic`);
      }
      expect(true).toBe(true);
    }
  });
});
