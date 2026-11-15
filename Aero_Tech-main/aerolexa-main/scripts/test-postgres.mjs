#!/usr/bin/env node
/**
 * Zero-skipped-tests gate for the Postgres-gated integration suites.
 *
 *   npm run test:postgres              # start a scratch Postgres 16 container,
 *                                      # run the gated suites, tear it down
 *   npm run test:postgres -- --keep    # leave the container running for re-runs
 *   npm run test:postgres -- --all     # run the whole unit suite (gated suites included)
 *
 * The suites in `__tests__/unit/connectors-postgres.test.ts` and
 * `__tests__/unit/connector-scheduler.test.ts` run against a REAL PostgreSQL
 * server and skip cleanly when TEST_POSTGRES_URL is unset. That skip is honest
 * for CI without a database — but it is also how 12 real tests silently stop
 * running. This script makes the skip unexcusable:
 *
 *   1. start a disposable Postgres 16 container (Ledgerly-test-pg) on 127.0.0.1:55432
 *   2. export TEST_POSTGRES_URL and run Jest ONCE (gated suites, or --all for
 *      the whole unit suite with the gate applied to it)
 *   3. fail the run if any test is still skipped/pending
 *   4. tear the container down unless --keep
 *
 * If TEST_POSTGRES_URL is already set (developer-provided or a CI service
 * container) the script reuses it and never starts or stops any container.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "Ledgerly-test-pg";
const PORT = Number(process.env.AEROLEXA_TEST_PG_PORT || 55432);
const IMAGE = process.env.AEROLEXA_TEST_PG_IMAGE || "postgres:16-alpine";
const URL_TEMPLATE = `postgres://test:test@127.0.0.1:${PORT}/test`;
const SUMMARY_FILE = path.join(root, "data", "jest-postgres-summary.json");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const runAll = args.includes("--all");

function log(msg) {
  console.log(`[test:postgres] ${msg}`);
}

function die(msg) {
  console.error(`[test:postgres] ${msg}`);
  process.exit(1);
}

function docker(dockerArgs) {
  const res = spawnSync("docker", dockerArgs, { encoding: "utf8" });
  if (res.error) {
    die(
      `docker is required for the gated integration suites (${res.error.message}). ` +
        `Start a Postgres yourself and export TEST_POSTGRES_URL instead.`,
    );
  }
  return res;
}

function containerState() {
  const res = docker(["ps", "-a", "--filter", `name=^${CONTAINER}$`, "--format", "{{.Status}}"]);
  return (res.stdout || "").trim();
}

function waitForPostgres(url) {
  // Poll with node-postgres until initdb finishes and the server accepts queries.
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `const { Client } = require(${JSON.stringify(path.join(root, "node_modules", "pg"))});
       (async () => {
         for (let i = 0; i < 60; i++) {
           try {
             const c = new Client({ connectionString: process.argv[1] });
             await c.connect();
             await c.query("select 1");
             await c.end();
             process.exit(0);
           } catch { await new Promise(r => setTimeout(r, 500)); }
         }
         process.exit(1);
       })();`,
      url,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (probe.status !== 0) die("Postgres container did not become ready within 30s.");
  log("Postgres is ready.");
}

let ownsContainer = false;

if (process.env.TEST_POSTGRES_URL) {
  log("Using provided TEST_POSTGRES_URL — no container management.");
} else {
  const state = containerState();
  if (state.startsWith("Up")) {
    log(`Container ${CONTAINER} is already running — reusing it.`);
  } else {
    if (state) {
      log(`Removing stale container ${CONTAINER}…`);
      docker(["rm", "-f", CONTAINER]);
    }
    log(`Starting scratch Postgres (${IMAGE}) on 127.0.0.1:${PORT}…`);
    const run = docker([
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-e",
      "POSTGRES_USER=test",
      "-e",
      "POSTGRES_PASSWORD=test",
      "-e",
      "POSTGRES_DB=test",
      "-p",
      `127.0.0.1:${PORT}:5432`,
      IMAGE,
    ]);
    if (run.status !== 0) die(`docker run failed: ${(run.stderr || run.stdout || "").trim()}`);
    ownsContainer = true;
    waitForPostgres(URL_TEMPLATE);
  }
}

mkdirSync(path.join(root, "data"), { recursive: true });
rmSync(SUMMARY_FILE, { force: true });

const testPattern = runAll ? "^__tests__/unit/" : "__tests__/(unit/(connectors-postgres|connector-scheduler))";
log(`Running Jest: ${testPattern}${runAll ? " (full unit suite)" : ""}`);

// Jest prints its human-readable report to stderr and writes the JSON summary
// to SUMMARY_FILE — one run gives us both the console UX and the gate data.
const jest = spawnSync(
  "npx",
  ["jest", "--runInBand", "--testPathPatterns=" + testPattern, "--json", `--outputFile=${SUMMARY_FILE}`],
  {
    cwd: root,
    env: { ...process.env, TEST_POSTGRES_URL: process.env.TEST_POSTGRES_URL || URL_TEMPLATE },
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
      `[test:postgres] ZERO-SKIP GATE FAILED: ${pending} test(s) were skipped. ` +
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
  log("Tearing down scratch Postgres…");
  docker(["rm", "-f", CONTAINER]);
} else if (keep) {
  log(`Container ${CONTAINER} left running — the next run will reuse it (npm run test:postgres -- --keep once).`);
}

process.exit(exit);
