#!/usr/bin/env node
/**
 * Zero-skipped-tests gate for the mySQL-gated integration suite.
 *
 *   npm run test:mysql                # start a scratch mySQL 8 container on
 *                                     # 127.0.0.1:55433, run the gated suite,
 *                                     # tear the container down
 *   npm run test:mysql -- --keep      # leave the container running for re-runs
 *   npm run test:mysql -- --all       # whole unit suite (gate applied to it)
 *
 * Mirrors scripts/test-postgres.mjs — see that file for the rationale.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "Ledgerly-test-mysql";
const PORT = Number(process.env.AEROLEXA_TEST_MYSQL_PORT || 55433);
const IMAGE = process.env.AEROLEXA_TEST_MYSQL_IMAGE || "mysql:8";
const URL_TEMPLATE = `mysql://test:test@127.0.0.1:${PORT}/test`;
const SUMMARY_FILE = path.join(root, "data", "jest-mysql-summary.json");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const runAll = args.includes("--all");

function log(msg) {
  console.log(`[test:mysql] ${msg}`);
}

function die(msg) {
  console.error(`[test:mysql] ${msg}`);
  process.exit(1);
}

function docker(dockerArgs) {
  const res = spawnSync("docker", dockerArgs, { encoding: "utf8" });
  if (res.error) {
    die(
      `docker is required for the gated integration suite (${res.error.message}). ` +
        `Start a mySQL yourself and export TEST_MYSQL_URL instead.`,
    );
  }
  return res;
}

function containerState() {
  const res = docker(["ps", "-a", "--filter", `name=^${CONTAINER}$`, "--format", "{{.Status}}"]);
  return (res.stdout || "").trim();
}

function waitForMySql(url) {
  // Poll with the mysql2 driver until a connection stays stable. The image's
  // entrypoint boots a temporary server first (grant setup) whose connection
  // dies when the real server takes over — so a single success is not enough:
  // require two consecutive successful probes.
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `const mysql = require(${JSON.stringify(path.join(root, "node_modules", "mysql2", "promise"))});
       (async () => {
         let streak = 0;
         for (let i = 0; i < 2400; i++) {
           try {
             const c = await mysql.createConnection({ uri: process.argv[1], connectTimeout: 5000 });
             await c.execute("select 1");
             await c.end();
             streak += 1;
           } catch { streak = 0; }
           if (streak >= 2) process.exit(0);
           await new Promise(r => setTimeout(r, 250));
         }
         process.exit(1);
       })();`,
      url,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (probe.status !== 0) die("mySQL container did not become ready within 10 minutes.");
  // mysqld can accept a TCP connection slightly before it is fully ready and
  // then drop it — a short settle after the stable probe avoids a race in the
  // very first test suite that opens a connection.
  spawnSync("sleep", ["3"]);
  log("mySQL is ready.");
}

let ownsContainer = false;

if (process.env.TEST_MYSQL_URL) {
  log("Using provided TEST_MYSQL_URL — no container management.");
} else {
  const state = containerState();
  if (state.startsWith("Up")) {
    log(`Container ${CONTAINER} is already running — reusing it.`);
  } else {
    if (state) {
      log(`Removing stale container ${CONTAINER}…`);
      docker(["rm", "-f", CONTAINER]);
    }
    log(`Starting scratch mySQL (${IMAGE}) on 127.0.0.1:${PORT}…`);
    const run = docker([
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-e",
      "MYSQL_ROOT_PASSWORD=root",
      "-e",
      "MYSQL_DATABASE=test",
      "-e",
      "MYSQL_USER=test",
      "-e",
      "MYSQL_PASSWORD=test",
      "-p",
      `127.0.0.1:${PORT}:3306`,
      IMAGE,
    ]);
    if (run.status !== 0) die(`docker run failed: ${(run.stderr || run.stdout || "").trim()}`);
    ownsContainer = true;
    waitForMySql(URL_TEMPLATE);
  }
}

mkdirSync(path.join(root, "data"), { recursive: true });
rmSync(SUMMARY_FILE, { force: true });

const testPattern = runAll ? "^__tests__/unit/" : "__tests__/unit/connectors-mysql";
log(`Running Jest: ${testPattern}${runAll ? " (full unit suite)" : ""}`);

const jest = spawnSync(
  "npx",
  ["jest", "--runInBand", "--testPathPatterns=" + testPattern, "--json", `--outputFile=${SUMMARY_FILE}`],
  { cwd: root, env: { ...process.env, TEST_MYSQL_URL: process.env.TEST_MYSQL_URL || URL_TEMPLATE }, stdio: "inherit" },
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
      `[test:mysql] ZERO-SKIP GATE FAILED: ${pending} test(s) were skipped. ` +
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
  log("Tearing down scratch mySQL…");
  docker(["rm", "-f", CONTAINER]);
} else if (keep) {
  log(`Container ${CONTAINER} left running — the next run will reuse it (npm run test:mysql -- --keep once).`);
}

process.exit(exit);
