#!/usr/bin/env node
/**
 * Zero-skipped-tests gate for the MongoDB-gated integration suite.
 *
 *   npm run test:mongodb              # start a scratch MongoDB 7 container on
 *                                     # 127.0.0.1:55434, run the gated suite,
 *                                     # tear the container down
 *   npm run test:mongodb -- --keep     # leave the container running for re-runs
 *   npm run test:mongodb -- --all      # whole unit suite (gate applied to it)
 *
 * Mirrors scripts/test-postgres.mjs — see that file for the rationale.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "Ledgerly-test-mongo";
const PORT = Number(process.env.AEROLEXA_TEST_MONGO_PORT || 55434);
const IMAGE = process.env.AEROLEXA_TEST_MONGO_IMAGE || "mongo:7";
const URL_TEMPLATE = `mongodb://127.0.0.1:${PORT}/test`;
const SUMMARY_FILE = path.join(root, "data", "jest-mongodb-summary.json");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const runAll = args.includes("--all");

function log(msg) {
  console.log(`[test:mongodb] ${msg}`);
}

function die(msg) {
  console.error(`[test:mongodb] ${msg}`);
  process.exit(1);
}

function docker(dockerArgs) {
  const res = spawnSync("docker", dockerArgs, { encoding: "utf8" });
  if (res.error) {
    die(
      `docker is required for the gated integration suite (${res.error.message}). ` +
        `Start a MongoDB yourself and export TEST_MONGODB_URL instead.`,
    );
  }
  return res;
}

function containerState() {
  const res = docker(["ps", "-a", "--filter", `name=^${CONTAINER}$`, "--format", "{{.Status}}"]);
  return (res.stdout || "").trim();
}

function waitForMongo(url) {
  // Poll with the mongodb driver until the server answers ping.
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `const { MongoClient } = require(${JSON.stringify(path.join(root, "node_modules", "mongodb"))});
       (async () => {
         for (let i = 0; i < 2400; i++) {
           try {
             const c = new MongoClient(process.argv[1], { serverSelectionTimeoutMS: 5000 });
             await c.connect();
             await c.db("test").command({ ping: 1 });
             await c.close();
             process.exit(0);
           } catch { await new Promise(r => setTimeout(r, 250)); }
         }
         process.exit(1);
       })();`,
      url,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (probe.status !== 0) die("MongoDB container did not become ready within 10 minutes.");
  log("MongoDB is ready.");
}

let ownsContainer = false;

if (process.env.TEST_MONGODB_URL) {
  log("Using provided TEST_MONGODB_URL — no container management.");
} else {
  const state = containerState();
  if (state.startsWith("Up")) {
    log(`Container ${CONTAINER} is already running — reusing it.`);
  } else {
    if (state) {
      log(`Removing stale container ${CONTAINER}…`);
      docker(["rm", "-f", CONTAINER]);
    }
    log(`Starting scratch MongoDB (${IMAGE}) on 127.0.0.1:${PORT}…`);
    const run = docker(["run", "-d", "--name", CONTAINER, "-p", `127.0.0.1:${PORT}:27017`, IMAGE]);
    if (run.status !== 0) die(`docker run failed: ${(run.stderr || run.stdout || "").trim()}`);
    ownsContainer = true;
    waitForMongo(URL_TEMPLATE);
  }
}

mkdirSync(path.join(root, "data"), { recursive: true });
rmSync(SUMMARY_FILE, { force: true });

const testPattern = runAll ? "^__tests__/unit/" : "__tests__/unit/connectors-mongodb";
log(`Running Jest: ${testPattern}${runAll ? " (full unit suite)" : ""}`);

const jest = spawnSync(
  "npx",
  ["jest", "--runInBand", "--testPathPatterns=" + testPattern, "--json", `--outputFile=${SUMMARY_FILE}`],
  {
    cwd: root,
    env: { ...process.env, TEST_MONGODB_URL: process.env.TEST_MONGODB_URL || URL_TEMPLATE },
    stdio: "inherit",
  },
);

let exit = jest.status ?? 1;

try {
  if (!existsSync(SUMMARY_FILE)) throw new Error("summary file missing");
  const report = JSON.parse(readFileSync(SUMMARY_FILE, "utf8"));
  const pending = report.numPendingTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  if (pending > 0) {
    console.error(
      `[test:mongodb] ZERO-SKIP GATE FAILED: ${pending} test(s) were skipped. ` +
        `A skipped integration test is an unverified claim — fix the environment, don't accept the skip.`,
    );
    exit = 1;
  } else if (exit === 0) {
    log(`Gate OK: ${passed} passed, 0 skipped, 0 failed.`);
  }
} catch (err) {
  log(`Could not read the Jest summary (${err.message}) — relying on the Jest exit code.`);
}

if (ownsContainer && !keep) {
  log("Tearing down scratch MongoDB…");
  docker(["rm", "-f", CONTAINER]);
} else if (keep) {
  log(`Container ${CONTAINER} left running — the next run will reuse it (npm run test:mongodb -- --keep once).`);
}

process.exit(exit);
