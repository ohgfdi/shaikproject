#!/usr/bin/env node
/**
 * Copy the DuckDB-wasm browser assets from node_modules into public/duckdb.
 *
 * The in-browser SQL Lab engine (lib/engine/duckdb/browser.ts) loads its wasm
 * and worker scripts from /duckdb/* — same origin, no CDN, no network. Run at
 * install/dev/start time so a fresh checkout is always ready:
 *
 *   npm run copy:duckdb
 *
 * Only the files the MANUAL_BUNDLES config references are copied:
 *   - duckdb-mvp.wasm  + duckdb-browser-mvp.worker.js  (small, single-threaded)
 *   - duckdb-eh.wasm   + duckdb-browser-eh.worker.js   (fast, single-threaded)
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "node_modules", "@duckdb", "duckdb-wasm", "dist");
const out = path.join(root, "public", "duckdb");

const FILES = ["duckdb-mvp.wasm", "duckdb-browser-mvp.worker.js", "duckdb-eh.wasm", "duckdb-browser-eh.worker.js"];

if (!existsSync(dist)) {
  console.warn("[copy:duckdb] @duckdb/duckdb-wasm not installed — skipping (run npm install).");
}

mkdirSync(out, { recursive: true });
for (const file of FILES) {
  const from = path.join(dist, file);
  const to = path.join(out, file);
  if (!existsSync(from)) {
    console.warn(`[copy:duckdb] missing ${from} — the installed duckdb-wasm version changed layout?`);
    continue;
  }
  copyFileSync(from, to);
}
console.log(`[copy:duckdb] Copied ${FILES.length} DuckDB-wasm assets to public/duckdb/.`);
