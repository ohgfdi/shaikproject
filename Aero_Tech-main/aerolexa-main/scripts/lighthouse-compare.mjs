#!/usr/bin/env node
/**
 * S4b — Lighthouse perf ≥ 85 with-canvas vs no-canvas comparison.
 *
 * Measures the marketing page twice against the production build:
 *   1. WITH canvas    — the real page (scene mounts per measured tier)
 *   2. WITHOUT canvas — `?scene-tier=flat` forces the honest no-WebGL path
 *
 * The override contract (lib/scene/tier.ts) is what makes this comparison
 * runnable in one pass: Lighthouse owns the page, so the URL param — not
 * localStorage — selects the tier.
 *
 * The gate: performance score WITH the canvas must stay ≥ 85 AND within 5
 * points of the no-canvas run. The scene is idle-deferred (S4.2), so the
 * honest result is "canvas costs ~nothing"; if it doesn't, the gate fails
 * the build exactly like the bundle budget does.
 *
 * Usage (against a production server):
 *   npm run build && npm run start      # terminal 1
 *   npm run lighthouse:compare          # terminal 2 — prints the table
 *
 * Requires: npx lighthouse (no extra dependency) and Chrome/Chromium.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE_URL = process.env.LH_URL ?? "http://localhost:3000";
const THRESHOLD = Number(process.env.LH_MIN_PERF ?? 85);
const MAX_DELTA = Number(process.env.LH_MAX_DELTA ?? 5);
const RUNS = Number(process.env.LH_RUNS ?? 1); // median-of-N when > 1
const OUT_DIR = path.resolve("lighthouse-results");

function runLighthouse(url, label) {
  mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${label}.json`);
  const res = spawnSync(
    "npx",
    [
      "--yes",
      "lighthouse",
      url,
      "--quiet",
      "--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage",
      "--only-categories=performance",
      "--output=json",
      `--output-path=${out}`,
    ],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  if (res.status !== 0) {
    console.error(`[lighthouse] run failed for ${label} (exit ${res.status}).`);
    process.exit(res.status ?? 1);
  }
  const report = JSON.parse(readFileSync(out, "utf8"));
  return {
    label,
    url,
    perfScore: Math.round((report.categories?.performance?.score ?? 0) * 100),
    lcpMs: report.audits?.["largest-contentful-paint"]?.numericValue ?? null,
    tbtMs: report.audits?.["total-blocking-time"]?.numericValue ?? null,
    cls: report.audits?.["cumulative-layout-shift"]?.numericValue ?? null,
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] ?? s[mid]) + s[mid]) / 2);
};

function measure(url, label) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(runLighthouse(url, RUNS > 1 ? `${label}-${i + 1}` : label));
  return {
    label,
    url,
    perfScore: median(runs.map((r) => r.perfScore)),
    lcpMs: Math.round(median(runs.map((r) => r.lcpMs ?? 0))),
    tbtMs: Math.round(median(runs.map((r) => r.tbtMs ?? 0))),
  };
}

console.log(`[lighthouse] comparing ${BASE_URL} — with canvas vs no canvas (?scene-tier=flat)`);
const withCanvas = measure(BASE_URL, "with-canvas");
const withoutCanvas = measure(`${BASE_URL}/?scene-tier=flat`, "no-canvas");

const delta = withoutCanvas.perfScore - withCanvas.perfScore;
const pass = withCanvas.perfScore >= THRESHOLD && delta <= MAX_DELTA;

console.table([
  { run: "with canvas (measured tier)", perf: withCanvas.perfScore, lcpMs: withCanvas.lcpMs, tbtMs: withCanvas.tbtMs },
  {
    run: "no canvas (flat override)",
    perf: withoutCanvas.perfScore,
    lcpMs: withoutCanvas.lcpMs,
    tbtMs: withoutCanvas.tbtMs,
  },
]);

writeFileSync(
  path.join(OUT_DIR, "comparison.json"),
  JSON.stringify({ ...withCanvas, withoutCanvas, delta, threshold: THRESHOLD, maxDelta: MAX_DELTA, pass }, null, 2),
);

if (!pass) {
  console.error(
    `[lighthouse] GATE FAILED — with-canvas perf ${withCanvas.perfScore} < ${THRESHOLD} or canvas cost ${delta} > ${MAX_DELTA} points.`,
  );
  process.exit(1);
}
console.log(
  `[lighthouse] gate passed — with-canvas ${withCanvas.perfScore} ≥ ${THRESHOLD}, canvas cost ${delta} ≤ ${MAX_DELTA} points.`,
);
