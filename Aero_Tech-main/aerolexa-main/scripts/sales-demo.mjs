#!/usr/bin/env node
/**
 * One-command sales demo.
 *
 *   npm run demo
 *
 * Boots the SQLite-profile container, waits for /api/health, seeds the
 * labelled demo workspace (demo@aerolexa.local / demo12345 — every artifact
 * named "Demo / Synthetic", nothing pretending to be real), and prints the
 * 10-minute walkthrough a presenter follows. Idempotent: re-running repairs
 * the plan catalog and leaves existing data alone (the seed itself refuses
 * to duplicate).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.DEMO_URL || "http://localhost:3000";

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (res.status !== 0) {
    console.error(`[demo] "${cmd} ${args.join(" ")}" failed (exit ${res.status}).`);
    process.exit(res.status ?? 1);
  }
}

function log(msg) {
  console.log(`[demo] ${msg}`);
}

// 1) Boot the app container (SQLite profile — zero external services).
log("booting the app (docker compose)…");
run("docker", ["compose", "up", "--build", "-d"]);

// 2) Wait for /api/health before touching the database.
log("waiting for /api/health…");
let ready = false;
for (let i = 0; i < 90; i++) {
  const probe = spawnSync("curl", ["-fsS", `${BASE}/api/health`], { encoding: "utf8" });
  if (probe.status === 0) {
    ready = true;
    break;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
}
if (!ready) {
  console.error("[demo] the app never became healthy — check: docker compose logs app");
  process.exit(1);
}
log("app is healthy");

// 3) Seed the labelled demo workspace (runs INSIDE the container so the
//    SQLite file lives on the container volume, not the host). tsx resolves
//    the seed's TypeScript + @/ aliases (dev deps are present in the image).
log("seeding the Demo / Synthetic workspace…");
run("docker", ["compose", "exec", "-T", "app", "npx", "tsx", "prisma/seed.ts", "--demo"]);

// 4) Hand the presenter the walkthrough.
const url = `${BASE}/login`;
console.log(`
────────────────────────────────────────────────────────────────
  Ledgerly sales demo is ready
────────────────────────────────────────────────────────────────
  Sign in:  ${url}
  email     demo@aerolexa.local
  password  demo12345

  Every artifact is labelled "Demo / Synthetic" — present that label as
  a feature: results are computed and provable, never invented.

  10-minute walkthrough
  ─────────────────────
  1. (1 min)  Projects → open the demo project. Show the activity trail.
  2. (2 min)  Dataset → Profile: column stats + data-quality warnings.
              Open "How was this calculated?" on any stat.
  3. (2 min)  Run a trend + correlation analysis. Point out the
              "Calculated" label and its provenance note.
  4. (2 min)  Dashboard Builder → add a chart + KPI card, click a slice
              to cross-filter, shift-click for drill-through.
  5. (2 min)  Reports → the 12-section executive template, export PDF.
  6. (1 min)  Settings → Audit log: "here is who did what, provably."

  Security talking point: workspace isolation, RLS defense-in-depth,
  rate limiting and audit export are in the product, not the roadmap.

  Teardown when done:  docker compose down -v
────────────────────────────────────────────────────────────────
`);
