#!/usr/bin/env node
/**
 * Bundle budget gate — the teeth behind the plan's size budgets.
 *
 * Reads the First Load JS for every App Router route that `next build` emitted
 * and fails when a budget is breached. Wired into `npm run build` AFTER the
 * build itself, so the gate runs on every build — local or CI — with zero
 * extra setup.
 *
 * Where the numbers come from: `.next/app-build-manifest.json` → `.pages`,
 * which Next writes for App Router and which maps each route to the JS/CSS
 * files that make up its first load (shared framework chunks + the route's own
 * chunk). The legacy `.next/build-manifest.json` → `.pages` is NOT used: on an
 * App Router build it only contains the two phantom entries `/_app` and
 * `/_error`, so a gate built on it measures nothing and always passes.
 *
 * Budgets (docs/3d-realism-master-plan.md §7):
 *   - No route's First Load JS may grow beyond its recorded baseline by more
 *     than the regression tolerance (a ratchet, not a cliff — see below).
 *   - The scene runtime must never appear in any route's first load
 *     (docs/3d-realism-master-plan.md §2: "3D chunk is always next/dynamic +
 *     ssr: false and never enters a route's first-load bundle").
 *
 * Ratchet vs absolute budget: the plan's headline bar is 300 kB gz, but the app
 * does not meet it yet (it is a multi-year target, not today's state). Turning
 * that on as a hard gate would fail nearly every route and block all work, so
 * the gate is a *ratchet* by default: it records today's per-route sizes and
 * fails only on regression. Run with --write-baseline to re-record (do this
 * deliberately — it is how a real improvement is banked, and it is also how a
 * regression could be laundered). Set BUDGET_FIRST_LOAD_KB with
 * BUDGET_ABSOLUTE=1 to enforce the absolute bar instead.
 *
 * The 3D lazy chunks themselves are not budget-capped by first-load numbers
 * (they load after paint by design); their budget is enforced by the fps specs
 * — a slow scene fails there, visibly.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const NEXT = join(ROOT, ".next");
const BASELINE_PATH = join(ROOT, "scripts", "bundle-baseline.json");

const FIRST_LOAD_BUDGET_KB = Number(process.env.BUDGET_FIRST_LOAD_KB ?? 300);
const REGRESSION_TOLERANCE_KB = Number(process.env.BUDGET_REGRESSION_TOLERANCE_KB ?? 20);
const ABSOLUTE = process.env.BUDGET_ABSOLUTE === "1";

/**
 * A three.js string literal from the WebGLRenderer context-loss handler.
 * It is a real string in three's source, so it survives minification — which
 * hashed chunk filenames (`b536a0f1-….js`) do not. Verified present in the
 * scene chunk and absent from ordinary framework chunks.
 */
const SCENE_MARKER = "WebGLRenderer: Context Lost";

/** Rough gzip factor for JS when no prebuilt .gz sits next to the chunk. */
const GZIP_FACTOR = 0.35;

const failures = [];

function fail(message) {
  failures.push(message);
}

function readJSON(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`✖ Could not read ${label}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const manifestPath = join(NEXT, "app-build-manifest.json");
if (!existsSync(manifestPath)) {
  console.error("✖ No .next/app-build-manifest.json — run `next build` before the budget check.");
  process.exit(1);
}

const allRoutes = readJSON(manifestPath, ".next/app-build-manifest.json").pages ?? {};

/** Client-relevant routes: pages and layouts, not API route handlers. */
function isClientRoute(key) {
  if (key.includes("/api/")) return false;
  if (key.endsWith("/route")) return false;
  return true;
}

function chunkPathKB(rel) {
  const p = join(NEXT, rel.replace(/^\//, ""));
  if (!existsSync(p)) return 0;
  const bytes = readFileSync(p).length;
  return (bytes * GZIP_FACTOR) / 1024;
}

/** Every emitted chunk that carries the three.js runtime. */
function findSceneChunks() {
  const chunkDir = join(NEXT, "static", "chunks");
  if (!existsSync(chunkDir)) return { chunks: new Set(), scanned: 0 };
  const chunks = new Set();
  let scanned = 0;
  for (const name of readdirSync(chunkDir)) {
    if (!name.endsWith(".js")) continue;
    scanned++;
    // Key on the manifest's own path form: Next writes these WITHOUT a leading
    // slash ("static/chunks/x.js"). Normalise here, or this check silently
    // compares "/static/chunks/x.js" against "static/chunks/x.js" and always
    // passes.
    const rel = `static/chunks/${name}`;
    if (readFileSync(join(chunkDir, name), "utf8").includes(SCENE_MARKER)) chunks.add(rel);
  }
  return { chunks, scanned };
}

const { chunks: sceneChunks, scanned } = findSceneChunks();

/** First-load weight per route, plus any scene runtime it wrongly pulls in. */
function measure(key) {
  const files = allRoutes[key] ?? [];
  let kb = 0;
  const sceneInFirstLoad = [];
  for (const rel of files) {
    kb += chunkPathKB(rel);
    if (sceneChunks.has(rel)) sceneInFirstLoad.push(rel);
  }
  return { kb, files: files.length, sceneInFirstLoad };
}

const measured = Object.keys(allRoutes)
  .filter(isClientRoute)
  .sort()
  .map((key) => ({ key, ...measure(key) }));

if (measured.length === 0) {
  console.error("✖ app-build-manifest.json listed no client routes — refusing to pass vacuously.");
  process.exit(1);
}

const writeBaseline = process.argv.includes("--write-baseline");

if (writeBaseline) {
  const baseline = {
    _comment:
      "Per-route first-load JS (kB, gzip-estimated) recorded by scripts/check-bundle-budgets.mjs --write-baseline. The gate fails when a route grows past its entry plus the regression tolerance. Re-record only for a deliberate, reviewed change.",
    toleranceKB: REGRESSION_TOLERANCE_KB,
    routes: Object.fromEntries(measured.map((r) => [r.key, Math.round(r.kb)])),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`✔ Wrote baseline for ${measured.length} routes → ${BASELINE_PATH}`);
  process.exit(0);
}

const baseline = existsSync(BASELINE_PATH) ? readJSON(BASELINE_PATH, "scripts/bundle-baseline.json") : null;
const tolerance = baseline?.toleranceKB ?? REGRESSION_TOLERANCE_KB;

// ---------------------------------------------------------------------------
// 1. The scene runtime must not be in any route's first load.
// ---------------------------------------------------------------------------
for (const { key, sceneInFirstLoad } of measured) {
  if (sceneInFirstLoad.length > 0) {
    const kb = sceneInFirstLoad.reduce((sum, rel) => sum + chunkPathKB(rel), 0);
    fail(
      `${key}: the 3D scene runtime is in its first load (${kb.toFixed(0)} kB via ${sceneInFirstLoad
        .map((r) => r.split("/").pop())
        .join(
          ", ",
        )}). Wrap the scene in a "use client" next/dynamic boundary with ssr:false — see docs/3d-realism-master-plan.md §2.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. First-load size: ratchet by default, absolute on request.
// ---------------------------------------------------------------------------
const rows = [];
for (const { key, kb, files, sceneInFirstLoad } of measured) {
  const recorded = baseline?.routes?.[key];
  let note = "";
  let bad = false;

  if (baseline) {
    if (recorded === undefined) {
      note = "new route (unrecorded)";
    } else {
      const delta = kb - recorded;
      if (delta > tolerance) {
        bad = true;
        note = `+${delta.toFixed(0)} kB over baseline ${recorded} kB (tolerance ${tolerance} kB)`;
      } else if (delta < -1) {
        note = `${delta.toFixed(0)} kB under baseline ${recorded} kB`;
      }
    }
  }

  if (ABSOLUTE && kb > FIRST_LOAD_BUDGET_KB) {
    bad = true;
    note = note
      ? `${note}; over absolute budget ${FIRST_LOAD_BUDGET_KB} kB`
      : `over absolute budget ${FIRST_LOAD_BUDGET_KB} kB`;
  }

  if (bad) fail(`${key}: first load ~${kb.toFixed(0)} kB — ${note}`);
  rows.push({ key, kb, files, note, bad, sceneInFirstLoad: sceneInFirstLoad.length > 0 });
}

const sceneInFirstLoadCount = rows.filter((r) => r.sceneInFirstLoad).length;
const overAbsolute = ABSOLUTE ? rows.filter((r) => r.kb > FIRST_LOAD_BUDGET_KB).length : 0;

console.log(
  `Bundle budget — ${rows.length} client routes, gz-estimated, tolerance ±${tolerance} kB${
    ABSOLUTE ? `, absolute bar ${FIRST_LOAD_BUDGET_KB} kB` : " (ratchet mode)"
  }`,
);
for (const row of rows) {
  const mark = row.bad ? "✖" : row.sceneInFirstLoad ? "▲" : "✔";
  const suffix = row.note ? `  ${row.note}` : row.sceneInFirstLoad ? "  scene runtime in first load" : "";
  console.log(`${mark} ${row.key.padEnd(44)} ~${row.kb.toFixed(0).padStart(5)} kB  (${row.files} files)${suffix}`);
}

if (scanned > 0 && sceneChunks.size === 0) {
  console.log(
    `\n⚠ No chunk matched the scene marker ("${SCENE_MARKER}") across ${scanned} scanned chunks — the 3D-in-first-load check is VACUOUS this build, not passing.`,
  );
}

if (baseline) {
  console.log(`\n✔ Ratchet: ${rows.length - overAbsolute} route(s) within baseline + ${tolerance} kB.`);
} else {
  console.log(`\n⚠ No baseline at scripts/bundle-baseline.json — run with --write-baseline to start the ratchet.`);
}

if (failures.length > 0) {
  console.error(`\n✖ ${failures.length} budget violation(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("✔ All bundle budgets satisfied.");
