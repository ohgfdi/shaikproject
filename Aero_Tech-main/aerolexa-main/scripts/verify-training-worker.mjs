/**
 * Real-thread verification for worker-offloaded ML training.
 *
 * Jest runs the training module INLINE (esbuild.buildSync deadlocks inside
 * jest's own worker pool), so the actual thread mechanics — bundling the
 * engine, spawning a worker, forwarding progress, and getting a byte-equal
 * result back — are verified HERE, in plain node, and wired into CI via
 * `npm run verify:worker`.
 *
 * Exits 0 only when ALL of the following hold:
 *  1. esbuild bundles the engine + entry to a standalone CJS worker;
 *  2. the worker answers a fit with progress events (cv → refit → importance);
 *  3. the worker's result is byte-identical to an inline trainWithCv call;
 *  4. engine errors propagate with their message;
 *  5. the worker terminates cleanly on dispose.
 */
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const requireFromRoot = createRequire(path.join(root, "package.json"));
const esbuild = requireFromRoot("esbuild");
const { Worker } = requireFromRoot("node:worker_threads");

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// ---- 1. Bundle ------------------------------------------------------------
const entry = path.join(root, "lib", "engine", "training-worker-entry.ts");
if (!existsSync(entry)) fail("worker entry missing");
const outDir = mkdtempSync(path.join(tmpdir(), "Ledgerly-worker-"));
const bundle = path.join(outDir, "worker.cjs");
const t0 = Date.now();
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: bundle,
  logLevel: "silent",
});
if (!existsSync(bundle)) fail("bundle did not produce a file");
console.log(`✓ bundled in ${Date.now() - t0}ms`);

// ---- Inline reference fit -------------------------------------------------
const source = {
  columns: [
    { name: "spend", type: "number" },
    { name: "label", type: "string" },
  ],
  rows: Array.from({ length: 60 }, (_, i) => [i * 2, i * 2 >= 50 ? "yes" : "no"]),
};
const request = {
  task: "binary-classification",
  algorithm: "random-forest",
  targetColumn: "label",
  cvFolds: 3,
  seed: 11,
  nTrees: 8,
};

// Inline engine (the same module jest tests): bundled + imported here so the
// reference result comes from the SAME transpilation the worker uses.
const inlineBundle = path.join(outDir, "inline.cjs");
esbuild.buildSync({
  entryPoints: [path.join(root, "lib", "engine", "ml-training.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: inlineBundle,
  logLevel: "silent",
});
const { trainWithCv } = await import(inlineBundle);
const direct = trainWithCv(source, request);

// ---- 2+3. Worker fit with progress ----------------------------------------
const worker = new Worker(bundle);
const events = [];
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("worker fit timed out (60s)")), 60_000);
  worker.on("message", (m) => {
    if (m.type === "progress") {
      events.push(m.progress);
      return;
    }
    clearTimeout(timer);
    if (m.type === "result") resolve(m.result);
    else reject(new Error(m.message));
  });
  worker.on("error", (e) => reject(e));
});
worker.postMessage({ type: "fit", id: 1, source, req: request });
let result;
try {
  result = await done;
} catch (e) {
  await worker.terminate().catch(() => undefined);
  fail(`worker fit: ${e.message}`);
}
const phases = events.map((e) => e.phase);
if (phases[0] !== "cv" || !phases.includes("refit") || !phases.includes("importance")) {
  fail(`progress phases incomplete: ${JSON.stringify(phases)}`);
}
if (events.filter((e) => e.phase === "cv").length !== 3) fail("expected 3 cv events");
const same =
  JSON.stringify(result.cv) === JSON.stringify(direct.cv) &&
  JSON.stringify(result.importance) === JSON.stringify(direct.importance) &&
  JSON.stringify(result.artifact) === JSON.stringify(direct.artifact);
if (!same) fail("worker result differs from inline result");
console.log(`✓ worker fit byte-identical to inline (${events.length} progress events)`);

// ---- 4. Error propagation --------------------------------------------------
const errDone = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("error case timed out")), 30_000);
  const onMsg = (m) => {
    clearTimeout(timer);
    worker.off("message", onMsg);
    if (m.type === "error") resolve(m.message);
    else reject(new Error(`expected error, got ${m.type}`));
  };
  worker.on("message", onMsg);
});
worker.postMessage({
  type: "fit",
  id: 2,
  source: {
    columns: [
      { name: "x", type: "number" },
      { name: "y", type: "number" },
    ],
    rows: Array.from({ length: 10 }, (_, i) => [i, i]),
  },
  req: { task: "regression", algorithm: "ridge", targetColumn: "y" },
});
const errMsg = await errDone;
if (!/at least 12 rows/.test(errMsg)) fail(`error propagation broken: ${errMsg}`);
console.log("✓ engine errors propagate with their message");

// ---- 5. Clean shutdown ------------------------------------------------------
await worker.terminate();
console.log("✓ worker terminated cleanly");
console.log("\nverify:worker — ALL CHECKS PASSED");
process.exit(0);
