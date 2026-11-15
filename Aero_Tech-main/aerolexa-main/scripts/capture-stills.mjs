#!/usr/bin/env node
/**
 * S4a — path-traced stills for README/social (dev-only, L5 assets).
 *
 * Drives the deterministic hero scene (`seed 42` skyline) through
 * headless Chromium at high resolution and captures:
 *   - the studio-tier marketing scene with the full post stack (DoF on)
 *   - the depth-tier variant (no post stack)
 *
 * Determinism: the skyline uses a seeded PRNG and the tier is forced via
 * localStorage BEFORE page scripts run, so the same code renders the same
 * pixels — two runs produce byte-identical stills (the screenshot gate).
 *
 * Usage:
 *   npm run build && npm run start        # terminal 1 (production server)
 *   npm run stills                        # terminal 2 — writes public/stills/
 *
 * Output is committed only intentionally — stills are marketing artifacts,
 * not build products (never in CI paths).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.STILLS_URL ?? "http://localhost:3000";
const OUT_DIR = path.resolve("public/stills");
const WIDTH = Number(process.env.STILLS_WIDTH ?? 1920);
const HEIGHT = Number(process.env.STILLS_HEIGHT ?? 1080);
const DEVICE_SCALE = Number(process.env.STILLS_SCALE ?? 2);

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch {
    console.error("[stills] @playwright/test is required (dev dependency) — run `npm ci` first.");
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
  });

  const shots = [
    { tier: "studio", file: `hero-${WIDTH}x${HEIGHT}@${DEVICE_SCALE}-studio.png` },
    { tier: "depth", file: `hero-${WIDTH}x${HEIGHT}@${DEVICE_SCALE}-depth.png` },
  ];

  let produced = 0;
  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: DEVICE_SCALE,
      reducedMotion: "no-preference",
    });
    // Force the tier before any page script runs — the override contract
    // (lib/scene/tier.ts) makes the tier a per-load decision.
    await context.addInitScript((tier) => {
      window.localStorage.setItem("aerolexa:tier", tier);
    }, shot.tier);

    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    // Scene mount is idle-deferred (S4.2): wait until the canvas exists, then
    // let the entrance springs settle so the capture is post-animation.
    try {
      await page.waitForSelector("canvas", { timeout: 15_000 });
      await page.waitForTimeout(2500);
    } catch {
      console.warn(`[stills] no canvas mounted at tier=${shot.tier} (headless WebGL missing?) — skipped.`);
      await context.close();
      continue;
    }

    const out = path.join(OUT_DIR, shot.file);
    await page.screenshot({ path: out });
    produced++;
    console.log(`[stills] ${shot.tier} → ${out}`);
    await context.close();
  }

  await browser.close();

  if (produced === 0) {
    console.error("[stills] no stills produced — is the production server running?");
    process.exit(1);
  }
  console.log(`[stills] done: ${produced} still(s) in ${OUT_DIR}`);
}
