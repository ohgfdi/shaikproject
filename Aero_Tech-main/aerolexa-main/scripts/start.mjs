#!/usr/bin/env node
/**
 * Production start:
 *
 *   npm run start
 *
 * Applies pending migrations (idempotent) and boots the compiled Next.js
 * server. Requires a prior `npm run build`. Secrets come from the process
 * environment — never from a committed file.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Keep the in-browser SQL engine's wasm/worker assets in public/duckdb fresh.
await import("./copy-duckdb-assets.mjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

try {
  console.log("[start] Applying pending database migrations…");
  await run("npx", ["prisma", "migrate", "deploy"]);
  console.log("[start] Migrations up to date. Starting server…");
  const child = spawn("npx", ["next", "start"], { cwd: root, stdio: "inherit", env: process.env });
  child.on("error", (err) => {
    console.error("[start] Failed to start Next.js:", err.message);
    process.exit(1);
  });
  child.on("close", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => child.kill(sig));
  }
} catch (err) {
  console.error("[start] Migration failed:", err.message);
  process.exit(1);
}
