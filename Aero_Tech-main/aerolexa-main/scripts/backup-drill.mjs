#!/usr/bin/env node
/**
 * Backup & restore DRILL — "a backup that has never been restored is a
 * hypothesis, not a backup."
 *
 *   npm run drill:backup            # run the drill
 *   npm run drill:backup -- --keep  # leave the drill containers running
 *
 * Runs entirely against disposable Postgres 16 containers — no risk to any
 * real instance, nothing to clean up:
 *
 *   1. Starts `Ledgerly-drill-src` (port 55433) and stands up the REAL
 *      Prisma schema (db push), then seeds 10,000 verifiable rows.
 *   2. Dumps with `pg_dump -Fc` — the exact command deploy-postgres.md §6
 *      tells operators to run in production.
 *   3. Starts `Ledgerly-drill-dst` (port 55434), copies the dump in, and
 *      restores with `pg_restore --clean --if-exists` — again the exact
 *      production command.
 *   4. VERIFIES: row counts match, an md5 content checksum over the seeded
 *      table matches, and the restored schema carries foreign keys.
 *   5. Appends a dated PASS row to docs/quality-baseline.md.
 *
 * Safety: the Prisma provider flip (sqlite → postgresql for the drill) is
 * undone in a FINALLY block, and drill containers are torn down on every
 * exit path — a failed drill never leaves the workspace switched or dirty.
 *
 * Exit 0 = the restore is proven. Anything else = fix before launch.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "Ledgerly-drill-src";
const DST = "Ledgerly-drill-dst";
const IMAGE = process.env.AEROLEXA_DRILL_PG_IMAGE || "postgres:16-alpine";
const PORT_SRC = Number(process.env.AEROLEXA_DRILL_SRC_PORT || 55433);
const PORT_DST = Number(process.env.AEROLEXA_DRILL_DST_PORT || 55434);
const URL_SRC = `postgres://drill:drill@127.0.0.1:${PORT_SRC}/drill`;
// docker-exec psql runs INSIDE the container — Postgres is on its
// localhost:5432, not the host's mapped port.
const INTERNAL_URL = "postgres://drill:drill@127.0.0.1:5432/drill";
const DUMP_FILE = path.join(root, "data", "drill-backup.dump");
const RECEIPT_FILE = path.join(root, "data", "backup-drill.json");

const keep = process.argv.slice(2).includes("--keep");

/**
 * Machine-readable evidence for /api/health. Written on EVERY exit path — a
 * failed drill is itself evidence and must not leave a stale PASS behind.
 */
let evidence = { ok: false, rows: null, note: "The drill did not complete." };

function writeReceipt() {
  try {
    mkdirSync(path.dirname(RECEIPT_FILE), { recursive: true });
    writeFileSync(
      RECEIPT_FILE,
      `${JSON.stringify({ ranAt: new Date().toISOString(), ...evidence }, null, 2)}\n`,
    );
    log(`receipt written: ${RECEIPT_FILE}`);
  } catch (err) {
    // A receipt that cannot be written must not change the drill's exit code.
    console.error(`[drill] could not write the receipt: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function log(msg) {
  console.log(`[drill] ${msg}`);
}

/** die = throw: the finally block still restores provider + tears containers down. */
function die(msg) {
  throw new Error(msg);
}

function docker(dockerArgs) {
  const res = spawnSync("docker", dockerArgs, { encoding: "utf8" });
  if (res.error) {
    die(
      `docker is required for the drill (${res.error.message}). ` +
        `Alternatively run the §6 commands from docs/deploy-postgres.md by hand against two Postgres instances.`,
    );
  }
  return res;
}

function down(name) {
  docker(["rm", "-f", name]);
}

function psql(container, sql) {
  const res = docker(["exec", container, "psql", INTERNAL_URL, "-tA", "-v", "ON_ERROR_STOP=1", "-c", sql]);
  if (res.status !== 0) die(`psql failed on ${container}: ${res.stderr || res.stdout}`);
  return (res.stdout || "").trim();
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForReady(container) {
  for (let i = 0; i < 60; i++) {
    const res = docker(["exec", container, "pg_isready", "-U", "drill", "-d", "drill"]);
    if (res.status === 0) return;
    sleep(500);
  }
  die(`${container} never became ready`);
}

function switchProvider(target) {
  const res = spawnSync(process.execPath, [path.join(root, "scripts", "switch-provider.mjs"), target], {
    cwd: root,
    encoding: "utf8",
  });
  if (res.status !== 0)
    die(`could not switch the Prisma provider to ${target}:\n${res.stdout || ""}\n${res.stderr || ""}`);
}

let providerFlipped = false;

function runDrill() {
  // --- 1) Start both containers ----------------------------------------------
  down(SRC);
  down(DST);
  docker([
    "run",
    "-d",
    "--name",
    SRC,
    "-e",
    "POSTGRES_USER=drill",
    "-e",
    "POSTGRES_PASSWORD=drill",
    "-e",
    "POSTGRES_DB=drill",
    "-p",
    `127.0.0.1:${PORT_SRC}:5432`,
    IMAGE,
  ]);
  docker([
    "run",
    "-d",
    "--name",
    DST,
    "-e",
    "POSTGRES_USER=drill",
    "-e",
    "POSTGRES_PASSWORD=drill",
    "-e",
    "POSTGRES_DB=drill",
    "-p",
    `127.0.0.1:${PORT_DST}:5432`,
    IMAGE,
  ]);
  log(`started ${SRC} (source) + ${DST} (restore target) on ${PORT_SRC}/${PORT_DST}`);
  waitForReady(SRC);
  waitForReady(DST);

  // --- 2) Real migrations + verifiable seed on the source --------------------
  // The provider is flipped to PostgreSQL for the drill (restored in the
  // finally below); switch-provider installs migrations-postgres/, and the
  // schema is created with the REAL `prisma migrate deploy` — the exact
  // command the blessed deploy path runs (deploy-postgres.md §1). No db push,
  // no data-loss flags: the drill exercises the production migration path.
  log("applying the real Prisma migrations to the source…");
  const schemaSrc = readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  if (/provider\s*=\s*"sqlite"/.test(schemaSrc)) {
    switchProvider("postgresql");
    providerFlipped = true;
    log("Prisma provider switched sqlite → postgresql (restored after the drill)");
  }

  const mig = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: URL_SRC },
  });
  if (mig.status !== 0) {
    die(`prisma migrate deploy failed against the source:\n${mig.stdout || ""}\n${mig.stderr || ""}`);
  }

  psql(
    SRC,
    `
    DROP TABLE IF EXISTS drill_check;
    CREATE TABLE drill_check (id int primary key, payload text, created_at timestamptz default now());
    INSERT INTO drill_check SELECT g, md5(g::text), now() FROM generate_series(1, 10000) g;
  `,
  );
  log("seeded 10,000 verifiable rows in drill_check");

  // --- 3) Dump (the production command) ---------------------------------------
  log("pg_dump -Fc (deploy-postgres.md §6 command)…");
  const dump = docker(["exec", SRC, "pg_dump", "-U", "drill", "-d", "drill", "-Fc", "-f", "/tmp/drill-backup.dump"]);
  if (dump.status !== 0) die(`pg_dump failed: ${dump.stderr}`);
  docker(["cp", `${SRC}:/tmp/drill-backup.dump`, DUMP_FILE]);
  const dumpBytes = statSync(DUMP_FILE).size;
  log(`dump: ${DUMP_FILE} (${(dumpBytes / 1024 / 1024).toFixed(2)} MB)`);

  // --- 4) Restore (the production command) ------------------------------------
  docker(["cp", DUMP_FILE, `${DST}:/tmp/drill-backup.dump`]);
  log("pg_restore --clean --if-exists into the target…");
  const restore = docker([
    "exec",
    DST,
    "pg_restore",
    "-U",
    "drill",
    "-d",
    "drill",
    "--clean",
    "--if-exists",
    "/tmp/drill-backup.dump",
  ]);
  // pg_restore exits 1 on "errors ignored" (e.g. ownership roles that don't
  // exist in the target) — acceptable for a drill; hard failures exit ≥ 2.
  if (restore.status >= 2) die(`pg_restore failed hard: ${restore.stderr}`);

  // --- 5) Verify ---------------------------------------------------------------
  const srcCount = psql(SRC, "SELECT COUNT(*) FROM drill_check;");
  const dstCount = psql(DST, "SELECT COUNT(*) FROM drill_check;");
  if (srcCount !== dstCount) die(`ROW COUNT MISMATCH: source=${srcCount} restored=${dstCount}`);
  log(`row counts match: ${srcCount}`);

  const srcMd5 = psql(SRC, "SELECT md5(string_agg(payload, '' ORDER BY id)) FROM drill_check;");
  const dstMd5 = psql(DST, "SELECT md5(string_agg(payload, '' ORDER BY id)) FROM drill_check;");
  if (srcMd5 !== dstMd5) die(`CONTENT MISMATCH: source md5=${srcMd5} restored md5=${dstMd5}`);
  log(`content checksum matches: ${srcMd5.slice(0, 12)}…`);

  const fkCount = psql(DST, "SELECT COUNT(*) FROM pg_constraint WHERE contype = 'f';");
  if (Number(fkCount) < 1) die("no foreign keys in the restored schema — restore is suspect");
  log(`foreign keys restored: ${fkCount}`);

  evidence = {
    ok: true,
    rows: Number(srcCount),
    note: `pg_dump -Fc → pg_restore --clean; ${srcCount} rows, md5 content checksum and ${fkCount} foreign keys verified.`,
  };

  // --- 6) Record ----------------------------------------------------------------
  const baseline = path.join(root, "docs", "quality-baseline.md");
  if (existsSync(baseline)) {
    const today = new Date().toISOString().slice(0, 10);
    appendFileSync(
      baseline,
      `\n| ${today} | backup drill (pg_dump→pg_restore, 10k rows) | PASS | ${dumpBytes} bytes | counts + checksum verified |\n`,
    );
    log("PASS recorded in docs/quality-baseline.md");
  }
}

try {
  runDrill();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  evidence = { ok: false, rows: evidence.rows, note: message };
  console.error(`[drill] FAIL: ${message}`);
  process.exitCode = 1;
} finally {
  writeReceipt();
  // EVERY exit path: undo the provider flip, tear the containers down.
  if (providerFlipped) {
    const back = spawnSync(process.execPath, [path.join(root, "scripts", "switch-provider.mjs"), "sqlite"], {
      cwd: root,
      encoding: "utf8",
    });
    log(
      back.status === 0
        ? "Prisma provider restored to sqlite"
        : "WARNING: provider restore failed — run: npm run switch:sqlite",
    );
  }
  if (!keep) {
    down(SRC);
    down(DST);
    log("drill containers torn down.");
  } else {
    log(`--keep: containers left running (${SRC} on ${PORT_SRC}, ${DST} on ${PORT_DST}).`);
  }
  if (process.exitCode === 1) {
    console.error("[drill] The backup is NOT verified — fix the failure above before launch.");
  } else {
    log("The backup is verified, not hypothetical.");
  }
}
