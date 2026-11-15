#!/usr/bin/env node
/**
 * Ledgerly one-click dev launcher.
 *
 *   npm run dev
 *
 * 1. Creates `.env` from `.env.example` when missing, generating a fresh
 *    AUTH_SECRET and pointing at the local SQLite database.
 * 2. Ensures the `data/` runtime directory exists.
 * 3. Runs any pending Prisma migrations against the local database.
 * 4. Starts the Next.js dev server and forwards signals so Ctrl+C works.
 *
 * The demo API / live ML providers are intentionally NOT started: every
 * feature is fully deterministic and runs in-process against your uploaded
 * file. The scheduled-report poller starts automatically inside Next.js
 * (instrumentation.ts) when SCHEDULER_ENABLED=true.
 * See README for the roadmap and demo-mode labelling policy.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Keep the in-browser SQL engine's wasm/worker assets in public/duckdb fresh.
await import("./copy-duckdb-assets.mjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");

// Webpack's persistent dev cache can be left corrupt when `next dev` dies
// uncleanly (OOM kill, crash, force-killed terminal): afterwards every route
// 500s with `Cannot find module './vendor-chunks/*.js'` until someone notices
// and nukes `.next` by hand. Prevent that: on startup, purge a dev-derived
// cache unless it carries the clean-shutdown sentinel. Production build
// output (`.next/BUILD_ID`) is never touched — a stale BUILD_ID just means
// `next start` should be re-run, and dev overwrite is always safe.
const DEV_CACHE_OK = ".next/.dev-clean";
function healDevCache() {
  const devCache = path.join(root, ".next");
  if (!existsSync(devCache)) return;
  if (existsSync(path.join(root, ".next", "BUILD_ID"))) return; // prod build
  if (!existsSync(path.join(root, DEV_CACHE_OK))) {
    console.log("[dev] Previous dev server did not shut down cleanly — clearing the (possibly corrupt) .next cache…");
    rmSync(devCache, { recursive: true, force: true });
    return;
  }
  console.log("[dev] .next dev cache carries a clean-shutdown sentinel — reusing it.");
}
// acquireDevLock() must run BEFORE healDevCache(): a second instance that
// merely wanted to notice the lock must not have purged the cache already.

// Two dev instances share ONE .next dir; a second instance issuing compiles
// while the first purges/rebuilds yields ENOENT routes-manifest errors and
// phantom 500s that look like app bugs. Guard with a live-process lock.
const DEV_LOCK = path.join(root, "data", ".dev.lock");
function acquireDevLock() {
  try {
    if (existsSync(DEV_LOCK)) {
      const raw = parseInt(readFileSync(DEV_LOCK, "utf8").trim(), 10);
      if (Number.isFinite(raw) && raw !== process.pid) {
        try {
          process.kill(raw, 0); // throws if no such process → stale lock
          console.error(`[dev] Another dev server is already running (pid ${raw}). Stop it first:  kill ${raw}`);
          process.exit(1);
        } catch {
          console.log("[dev] Removing stale dev lock from a dead pid…");
        }
      }
    }
    writeFileSync(DEV_LOCK, String(process.pid));
    process.on("exit", () => {
      try {
        if (existsSync(DEV_LOCK) && readFileSync(DEV_LOCK, "utf8").trim() === String(process.pid)) {
          rmSync(DEV_LOCK, { force: true });
        }
      } catch {
        // Best effort — a leftover lock is auto-cleaned next start.
      }
    });
  } catch (err) {
    console.warn("[dev] Could not manage the dev lock file:", err.message);
  }
}
acquireDevLock();

function ensureEnv() {
  if (existsSync(envFile)) {
    console.log("[dev] .env already exists — leaving it untouched.");
    return;
  }
  const example = path.join(root, ".env.example");
  if (!existsSync(example)) {
    console.warn(
      "[dev] .env.example missing — skipping .env generation. Expect DATABASE_URL/AUTH_SECRET from the shell.",
    );
    return;
  }
  const template = readFileSync(example, "utf8");
  const secret = randomBytes(32).toString("hex");
  const contents = template.replace("change-me-generate-a-random-64-hex-secret", secret);
  writeFileSync(envFile, contents);
  console.log("[dev] Created .env with a fresh AUTH_SECRET.");
}

function ensureDataDir() {
  const dir = path.join(root, "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

ensureEnv();
ensureDataDir();

try {
  console.log("[dev] Applying pending database migrations…");
  await run("npx", ["prisma", "migrate", "deploy"]);
} catch (err) {
  console.error("[dev] Migration failed:", err.message);
  process.exit(1);
}

console.log("[dev] Starting Next.js at http://localhost:3000");
if (!process.env.ANTHROPIC_API_KEY) {
  console.log(
    "[dev] Copilot: no ANTHROPIC_API_KEY set — AI answers use the deterministic engine.\n" +
      "      For live Claude answers, add to .env:  ANTHROPIC_API_KEY=<key>",
  );
}
const child = spawn("npx", ["next", "dev"], { cwd: root, stdio: "inherit", env: process.env });
child.on("error", (err) => {
  console.error("[dev] Failed to start Next.js:", err.message);
  process.exit(1);
});
// A clean start means the freshly written cache can be trusted next time. If
// the process dies any other way (crash, OOM, kill -9) the sentinel stays
// absent and the next `npm run dev` purges instead of reusing a corrupt cache.
function trustDevCache() {
  try {
    mkdirSync(path.join(root, ".next"), { recursive: true });
    writeFileSync(path.join(root, DEV_CACHE_OK), new Date().toISOString(), "utf8");
  } catch {
    // Best effort; absence only costs one rebuild.
  }
}

child.on("close", (code) => process.exit(code ?? 0));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    trustDevCache();
    child.kill(sig);
  });
}
