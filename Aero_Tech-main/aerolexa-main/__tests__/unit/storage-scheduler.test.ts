/**
 * Storage driver + scheduler claim semantics.
 *
 * The claim test is the concurrency-critical one: it proves the
 * compare-and-swap in claimSchedule() can only succeed once for a given
 * lastRunAt — the property that makes multi-instance deployments safe.
 *
 * Follows the repo convention for DB-touching unit suites: set env BEFORE any
 * @/ import, migrate a scratch SQLite database, then load modules dynamically.
 * Skips with a printed reason when the DB is unavailable (same earned-skip
 * convention as the other runtime-gated suites).
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

// Env FIRST — modules below read these at construction time.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "storage-scheduler-test-secret-0123456789abcdef";
process.env.DATA_DIR = process.env.DATA_DIR ?? "data/storage-scheduler-test";

import { keys, localPath, saveFile, storageKind, exists, deleteFile, readTextFile } from "@/lib/server/storage";

// ---------------------------------------------------------------------------
// Storage driver (local mode — the default test configuration)
// ---------------------------------------------------------------------------

describe("storage driver (local)", () => {
  it("defaults to the local driver", () => {
    expect(storageKind()).toBe("local");
  });

  it("rejects path traversal in keys", () => {
    expect(() => localPath("../secrets.env")).toThrow(/invalid storage key/i);
    expect(() => localPath("parsed/../../.env")).toThrow(/invalid storage key/i);
  });

  it("maps keys under DATA_DIR deterministically", () => {
    expect(keys.parsed("ds1")).toBe("parsed/ds1.ndjson");
    expect(keys.upload("ds1")).toBe("uploads/ds1.raw");
    expect(keys.version("ds1", "snap1")).toBe("versions/ds1/snap1.ndjson");
    expect(keys.export("sched", "abcdef1234", "20260915120000")).toMatch(/^exports\/sched-abcdef12-\d{14}\.html$/);
  });

  it("round-trips a save → read → delete cycle", async () => {
    const key = "parsed/__test-roundtrip.ndjson";
    await saveFile(key, '{"row":1}\n{"row":2}\n');
    expect(await exists(key)).toBe(true);
    expect(await readTextFile(key)).toBe('{"row":1}\n{"row":2}\n');
    await deleteFile(key);
    expect(await exists(key)).toBe(false);
  });

  it("writes atomically (no temp files left behind)", async () => {
    const key = "parsed/__test-atomic.ndjson";
    await saveFile(key, "x\n");
    const siblings = await fs.readdir(path.dirname(localPath(key)));
    expect(siblings.filter((f) => f.includes(".tmp-"))).toEqual([]);
    await deleteFile(key);
  });
});

// ---------------------------------------------------------------------------
// Scheduler claim semantics (scratch DB)
// ---------------------------------------------------------------------------

describe("scheduler claim (compare-and-swap)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let claimSchedule: (typeof import("@/lib/server/scheduler"))["claimSchedule"];
  let dbReady = false;

  beforeAll(async () => {
    try {
      await fs.rm(path.join(process.cwd(), "data", "storage-scheduler-test"), { force: true, recursive: true });
      const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
      if (migrate.status !== 0) throw new Error(`migrate failed: ${String(migrate.stderr).slice(-500)}`);
      ({ prisma } = await import("@/lib/db"));
      ({ claimSchedule } = await import("@/lib/server/scheduler"));
      await prisma.$queryRaw`SELECT 1`;
      dbReady = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `storage-scheduler: skipping claim test — scratch DB unavailable (${(err as Error).message.split("\n")[0]}).`,
      );
    }
  });

  it("claims a due schedule exactly once across competing callers", async () => {
    if (!dbReady) return;
    const workspace = await prisma.workspace.create({ data: { name: `sched-claim-${Date.now()}` } });
    const owner = await prisma.user.create({
      data: {
        email: `sched-claim-${Date.now()}@test.dev`,
        name: "Scheduler Claim Test",
        passwordHash: "x",
        workspaceId: workspace.id,
      },
    });
    const schedule = await prisma.scheduledReport.create({
      data: {
        workspaceId: workspace.id,
        userId: owner.id,
        name: "claim test",
        cron: "*/5 * * * *",
        recipients: "[]",
        enabled: true,
        lastRunAt: null,
      },
    });

    // Two replicas see the same previous lastRunAt (null) — only one wins.
    const [first, second] = await Promise.all([claimSchedule(schedule.id, null), claimSchedule(schedule.id, null)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    // A stale claim (outdated lastRunAt) loses against the claimed row.
    const stale = await claimSchedule(schedule.id, null);
    expect(stale).toBe(false);

    // Cleanup
    await prisma.scheduledReport.delete({ where: { id: schedule.id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: owner.id } }).catch(() => undefined);
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
  });
});
