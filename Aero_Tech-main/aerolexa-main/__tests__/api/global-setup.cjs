/**
 * API integration harness.
 *
 * Boots a real Next.js dev server on port 3210 against a fresh scratch PostgreSQL
 * database (ledgerly_test) so Supertest exercises the true request pipeline —
 * auth cookies, workspace authorization, uploads, and the analysis engine —
 * with no mocks.
 *
 * Fast path: when Jest is filtered to paths that are NOT __tests__/api (the
 * unit/component suite), no server is started and no migration is needed. A
 * full run (no path filter) DOES include the API suite, so it boots.
 */
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

/**
 * Local-dev fallback: parse the repo `.env` and export any variable that is
 * NOT already set in the process environment. CI exports DATABASE_URL /
 * AUTH_SECRET explicitly (they win), while a fresh local clone running
 * `npm test` has no env at all — without this, serverEnv() rejects at boot
 * and unrelated suites (e.g. mail-transport) fail before asserting anything.
 * Deliberately a tiny KEY=VALUE reader — no dotenv dependency in tests.
 */
function loadDotEnvFallback() {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvFallback();
const PORT = 3210;
const scratch = path.join(root, "data", "api-test");

const env = {
  ...process.env,
  DATABASE_URL: "postgresql://postgres:postgres@localhost:55432/ledgerly_test?sslmode=disable",
  DATA_DIR: "data/api-test",
  AUTH_SECRET: "api-test-secret-0123456789abcdefghijklmnopqrstuv",
  MAIL_TRANSPORT: "console",
  // Disposable scratch box, not a deployment: when a production build exists
  // this harness boots `next start` (NODE_ENV=production) with the console
  // transport, so the boot gate in lib/env.ts would refuse it. State the
  // opt-out explicitly, exactly like scripts/run-api-suite-external.sh.
  ALLOW_INSECURE_PROD_TRANSPORTS: "true",
  NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${PORT}`,
  // The MLOps suite trains real models; the repo .env ships
  // TRAINING_ENABLED=false and loadDotEnvFallback must not win here.
  TRAINING_ENABLED: "true",
  // Supertest replays cookies over plain http://127.0.0.1 — Secure cookies
  // would be dropped by the agent (and by browsers), 401-ing every authed call.
  AUTH_COOKIE_SECURE: "false",
  // Supertest stands in for ONE reverse proxy in front of the app, and the
  // suites rely on that: each agent sends a unique X-Forwarded-For so the
  // per-IP signup budget models distinct clients. The rate limiter only reads
  // that header when TRUST_PROXY_HOPS names the proxy chain (SEC-7) — with the
  // default 0 it is client-controlled and ignored, so EVERY suite collapses
  // into one shared "untrusted-proxy" bucket and the 10/hour signup limit
  // trips mid-run (429s, then cascading 401s). One hop = the supertest agent.
  TRUST_PROXY_HOPS: "1",
  NEXT_TELEMETRY_DISABLED: "1",
};

function shouldBoot() {
  // External-server mode: the operator runs the server (same env contract)
  // and jest connects to it — for sandboxes where a detached spawn from
  // inside jest's proc group gets reaped. Teardown is skipped too.
  if (process.env.API_TEST_EXTERNAL_SERVER === "1") return false;

  const args = process.argv.slice(2);

  // `--testPathPattern(s)` may be spelled with a space or an `=`.
  const patterns = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--testPathPattern" || arg === "--testPathPatterns") {
      patterns.push(args[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("--testPathPattern=") || arg.startsWith("--testPathPatterns=")) {
      patterns.push(arg.slice(arg.indexOf("=") + 1));
    }
  }
  if (patterns.length > 0) {
    // Focused run: boot only when the selected paths include the API suite.
    return patterns.some((p) => p.includes("__tests__/api"));
  }

  // Positional path filters (e.g. `jest __tests__/unit/foo.test.ts`) behave
  // the same way.
  const positional = args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a));
  if (positional.length > 0) {
    return positional.some((p) => p.includes("__tests__/api"));
  }

  // No filter at all: this is the full suite, which includes __tests__/api.
  // It MUST boot, otherwise every API suite fails with ECONNREFUSED.
  return true;
}

module.exports = async function globalSetup() {
  // Only boot the full API suite — unit tests skip server + migration.
  if (!shouldBoot()) {
    console.log("[api] Not targeting __tests__/api — skipping server boot and migration.");
    return;
  }

  // Fresh database + runtime dirs every run.
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });

  // Apply migrations to the scratch DB.
  const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (migrate.status !== 0) {
    throw new Error("global-setup: prisma migrate deploy failed against scratch DB.");
  }

  // The cross-replica rate-limit ledger lives in CollaborativeUpdate rows
  // (`__rl__|…` keyspace) and survives migrate deploy on an existing scratch
  // database. Clear it so a rerun within the limit window does not inherit the
  // previous run's signup counts and 429 the first request from a reused IP.
  const { Client } = require("pg");
  const ledgerClient = new Client({ connectionString: env.DATABASE_URL });
  await ledgerClient.connect();
  try {
    await ledgerClient.query(`DELETE FROM "CollaborativeUpdate" WHERE starts_with("notebookId", '__rl__|')`);
  } finally {
    await ledgerClient.end();
  }

  // Boot the server (detached so teardown can kill it by pid file).
  // Prefer the PRODUCTION build when one exists (`.next/BUILD_ID`): it starts in
  // seconds, serves every route without on-demand compilation, exercises the
  // exact artifact that ships, and avoids dev-mode memory spikes on constrained
  // machines. CI builds after this suite, so it runs the dev fallback there.
  const useProduction = existsSync(path.join(root, ".next", "BUILD_ID"));
  const serverCmd = useProduction ? "start" : "dev";
  const server = spawn("npx", ["next", serverCmd, "-p", String(PORT)], {
    cwd: root,
    env,
    stdio: "pipe",
    detached: true, // own process group so teardown can reap all children
  });
  let stderr = "";
  server.stderr.on("data", (d) => {
    stderr += String(d);
    process.stderr.write(d);
  });
  server.stdout.on("data", (d) => {
    stderr += String(d);
    process.stderr.write(d);
  });

  writeFileSync(path.join(scratch, "server.pid"), String(server.pid));
  // Marks that THIS Jest process owns the server. Global teardown runs in the
  // same process and must not kill a server booted by a concurrent Jest run
  // (the scratch dir is shared between them).
  process.env.__LEDGERLY_API_SERVER_BOOTED = "1";

  // Wait until the login page answers (first request compiles the route).
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (server.exitCode !== null) {
      throw new Error(`[api] Next ${serverCmd} server exited early (${server.exitCode}): ${stderr.slice(-2000)}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/login`, { redirect: "manual" });
      if (res.status === 200) {
        console.log(`[api] Next ${serverCmd} server ready on :${PORT}`);
        break;
      }
    } catch {
      // Server not yet ready — continue polling.
    }
    if (Date.now() > deadline) {
      throw new Error(`[api] Timeout waiting for Next dev server on :${PORT}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
};
