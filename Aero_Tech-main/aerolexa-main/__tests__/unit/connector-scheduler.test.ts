/**
 * Scheduled connector sync — real integration test.
 *
 * Proves that `runDueConnectorSyncs` (the scheduler tick's connector branch)
 * re-pulls a connector-backed dataset when its cron is due and records a new
 * versioned run with a diff-able change log, never a silent overwrite.
 *
 * Uses a fresh scratch PostgreSQL database (created and migrated in
 * beforeAll) + the real Postgres at TEST_POSTGRES_URL for the connector
 * source. Skips cleanly without TEST_POSTGRES_URL.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "pg";

import { prisma } from "@/lib/db";

const TEST_PG = process.env.TEST_POSTGRES_URL ?? "postgresql://aerolexa:aerolexa@localhost:55432/aerolexa?sslmode=disable";

const SCRATCH_DB_NAME = "aerolexa_sched_app";
// Swap only the database name but keep TEST_PG's query string: resolving a
// relative path against the base URL would drop it, losing sslmode=disable for
// the scratch database and making a non-TLS test server reject the handshake.
const SCRATCH_DB = TEST_PG
  ? (() => {
      const url = new URL(TEST_PG);
      url.pathname = `/${SCRATCH_DB_NAME}`;
      return url.toString();
    })()
  : "";
const SCRATCH_DIR = "data/connector-scheduler-test";
const SCRATCH_SCHEMA = "aerolexa_test_sched";

const maybe = TEST_PG ? describe : describe.skip;

maybe("scheduled connector sync", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let runDueConnectorSyncs: (typeof import("@/lib/server/connector-sync"))["runDueConnectorSyncs"];
  let encryptJson: (typeof import("@/lib/engine/connectors/crypto"))["encryptJson"];
  let storeRowsAsDataset: (typeof import("@/lib/file/store-rows"))["storeRowsAsDataset"];
  let stringifyJson: (typeof import("@/lib/json"))["stringifyJson"];

  let connectorId = "";
  let datasetId = "";
  let firstRunId = "";

  beforeAll(async () => {
    if (!TEST_PG) return;
    process.env.DATABASE_URL = SCRATCH_DB;
    process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "scheduler-test-secret-0123456789abcdefghijklmnopqrstuv";
    process.env.DATA_DIR = SCRATCH_DIR;

    // Fresh scratch database + data dir for this suite only. The app is
    // PostgreSQL-only, so the old SQLite scratch file no longer works.
    await fs.rm(path.join(process.cwd(), SCRATCH_DIR), { recursive: true, force: true });
    const admin = new Client({ connectionString: TEST_PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_NAME}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB_NAME}"`);
    await admin.end();
    const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
    if (migrate.status !== 0) {
      throw new Error(`prisma migrate deploy failed: ${String(migrate.stderr).slice(-2000)}`);
    }

    // Seed a real source table in Postgres.
    const client = new Client({ connectionString: TEST_PG });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCRATCH_SCHEMA}`);
    await client.query(`CREATE TABLE ${SCRATCH_SCHEMA}.events (id integer, name text)`);
    await client.query(`INSERT INTO ${SCRATCH_SCHEMA}.events VALUES (1, 'alpha'), (2, 'beta')`);
    await client.end();

    // Load the modules AFTER env is set (they read env at call time / prisma at construction).
    ({ prisma } = await import("@/lib/db"));
    ({ runDueConnectorSyncs } = await import("@/lib/server/connector-sync"));
    ({ encryptJson } = await import("@/lib/engine/connectors/crypto"));
    ({ storeRowsAsDataset } = await import("@/lib/file/store-rows"));
    ({ stringifyJson } = await import("@/lib/json"));
  });

  it("imports the source table as a dataset (sync run #1)", async () => {
    const url = new URL(TEST_PG);
    const user = await prisma.user.create({
      data: { email: `sched-${Date.now()}@test.dev`, name: "Scheduler Tester", passwordHash: "x" },
    });
    const workspace = await prisma.workspace.create({
      data: { name: "Scheduler Workspace", user: { connect: { id: user.id } } },
    });
    const connector = await prisma.connector.create({
      data: {
        workspaceId: workspace.id,
        name: "Scheduler source",
        kind: "postgres",
        config: encryptJson({
          kind: "postgres",
          postgres: {
            host: url.hostname,
            port: Number(url.port || 5432),
            database: url.pathname.replace(/^\//, ""),
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            ssl: false,
          },
        }),
        createdById: user.id,
      },
    });
    connectorId = connector.id;

    const columns = [
      { name: "id", type: "number" as const },
      { name: "name", type: "string" as const },
    ];
    const rows = [
      [1, "alpha"],
      [2, "beta"],
    ];
    const id = "sched-dataset-1";
    const stored = await storeRowsAsDataset(id, columns, rows);
    const dataset = await prisma.dataset.create({
      data: {
        id,
        workspaceId: workspace.id,
        name: "events import",
        originalName: "events",
        mimeType: "application/x-Ledgerly-connector",
        sizeBytes: 100,
        rowCount: stored.rowCount,
        columnCount: stored.columns.length,
        status: "READY",
        ndjsonPath: `${id}.ndjson`,
        profile: stringifyJson(stored.profile),
        columns: stringifyJson(stored.columns),
        preview: stringifyJson(stored.preview),
        qualityWarnings: stringifyJson(stored.qualityWarnings),
        connectorId,
        connectorSourceTable: `${SCRATCH_SCHEMA}.events`,
        createdById: user.id,
      },
    });
    datasetId = dataset.id;
    expect(dataset.rowCount).toBe(2);

    // Mirror importConnectorTable: the import is recorded as sync run #1 with
    // its own snapshot, so prior versions stay retrievable after later syncs.
    const snapshotDir = path.join(process.cwd(), SCRATCH_DIR, "connector-syncs");
    await fs.mkdir(snapshotDir, { recursive: true });
    const importRun = await prisma.connectorSyncRun.create({
      data: {
        workspaceId: dataset.workspaceId,
        connectorId,
        datasetId: dataset.id,
        tableName: `${SCRATCH_SCHEMA}.events`,
        status: "SUCCESS",
        rowCount: 2,
        changeLog: stringifyJson({
          previousRowCount: 0,
          newRowCount: 2,
          rowsAdded: 2,
          rowsRemoved: 0,
          comparedRows: 2,
          truncated: false,
          note: "Initial import of 2 row(s).",
        }),
        triggeredBy: "manual",
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        finishedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    await fs.writeFile(
      path.join(snapshotDir, `${importRun.id}.ndjson`),
      `${JSON.stringify(rows[0])}\n${JSON.stringify(rows[1])}\n`,
      "utf8",
    );
    await prisma.connectorSyncRun.update({
      where: { id: importRun.id },
      data: { snapshotPath: `${importRun.id}.ndjson` },
    });
  });

  it("does not sync when the schedule is not due", async () => {
    // Insert a third row that the due sync should pick up later.
    const client = new Client({ connectionString: TEST_PG });
    await client.connect();
    await client.query(`INSERT INTO ${SCRATCH_SCHEMA}.events VALUES (3, 'gamma')`);
    await client.end();

    await prisma.connector.update({
      where: { id: connectorId },
      data: { syncEnabled: true, syncCron: "* * * * *", lastSyncAt: new Date() }, // due in ~1 minute
    });
    expect(await runDueConnectorSyncs()).toBe(0);
  });

  it("runs the due sync, versions the result, and records a diff-able change log", async () => {
    // Backdate lastSyncAt so the every-minute cron is now due.
    await prisma.connector.update({
      where: { id: connectorId },
      data: { lastSyncAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const synced = await runDueConnectorSyncs();
    expect(synced).toBe(1);

    const run = await prisma.connectorSyncRun.findFirst({
      where: { connectorId, datasetId },
      orderBy: { startedAt: "desc" },
    });
    expect(run).not.toBeNull();
    firstRunId = run!.id;
    expect(run!.status).toBe("SUCCESS");
    expect(run!.triggeredBy).toBe("schedule");
    expect(run!.rowCount).toBe(3);

    const changeLog = JSON.parse(run!.changeLog ?? "null") as {
      previousRowCount: number;
      newRowCount: number;
      rowsAdded: number;
      rowsRemoved: number;
      note: string;
    };
    expect(changeLog.previousRowCount).toBe(2);
    expect(changeLog.newRowCount).toBe(3);
    expect(changeLog.rowsAdded).toBe(1);
    expect(changeLog.rowsRemoved).toBe(0);
    expect(changeLog.note).toMatch(/1 new row/);

    // The dataset was updated — not silently: the run row + snapshot exist.
    const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
    expect(dataset?.rowCount).toBe(3);
  });

  it("keeps the previous version's snapshot retrievable", async () => {
    const run = await prisma.connectorSyncRun.findFirst({ where: { id: firstRunId } });
    const snapshot = path.join(process.cwd(), SCRATCH_DIR, "connector-syncs", run!.snapshotPath!);
    const content = await fs.readFile(snapshot, "utf8");
    const lines = content.trim().split("\n");
    // The synced snapshot holds the NEW (3-row) pull; the import snapshot
    // (run #1, written before this sync) still holds the original 2 rows.
    expect(lines).toHaveLength(3);

    const importRun = await prisma.connectorSyncRun.findFirst({
      where: { connectorId, datasetId, triggeredBy: "manual" },
      orderBy: { startedAt: "asc" },
    });
    expect(importRun).not.toBeNull();
    const importSnapshot = await fs.readFile(
      path.join(process.cwd(), SCRATCH_DIR, "connector-syncs", importRun!.snapshotPath!),
      "utf8",
    );
    expect(importSnapshot.trim().split("\n")).toHaveLength(2);
  });

  afterAll(async () => {
    if (!TEST_PG) return;
    try {
      await prisma?.$disconnect();
    } catch {
      // cleanup is best-effort
    }
    try {
      const client = new Client({ connectionString: TEST_PG });
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`);
      await client.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_NAME}" WITH (FORCE)`);
      await client.end();
    } catch {
      // cleanup is best-effort
    }
    await fs.rm(path.join(process.cwd(), SCRATCH_DIR), { recursive: true, force: true });
  });
});
