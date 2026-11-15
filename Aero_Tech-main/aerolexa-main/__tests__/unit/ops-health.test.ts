/**
 * Operations posture oracles.
 *
 * The queue, RLS boot gate and backup evidence decide whether an operator is
 * told the truth about a running system. These tests pin the rule, not the
 * wording, so a threshold change is deliberate and visible.
 */

import { backupPosture, parseBackupReceipt } from "@/lib/server/backup-evidence";
import { summariseQueue, QUEUE_THRESHOLDS } from "@/lib/server/queue-health";
import { assertRlsBootFindings, rlsBootFindings } from "@/lib/server/rls-boot-gate";

const NOW = new Date("2026-11-11T10:00:00.000Z");

describe("queue posture", () => {
  it("reports an empty queue as ok", () => {
    const posture = summariseQueue({ counts: { done: 12 }, oldestPendingAt: null }, NOW);
    expect(posture.severity).toBe("ok");
    expect(posture.pending).toBe(0);
    expect(posture.summary).toBe("The queue is empty.");
  });

  it("keeps a short wait at ok and says how old the oldest job is", () => {
    const posture = summariseQueue(
      { counts: { pending: 2 }, oldestPendingAt: new Date(NOW.getTime() - 10 * 60_000) },
      NOW,
    );
    expect(posture.severity).toBe("ok");
    expect(posture.oldestPendingAgeMs).toBe(10 * 60_000);
    expect(posture.summary).toBe("2 jobs pending, oldest 10 minutes.");
  });

  it("warns at the warn threshold", () => {
    const posture = summariseQueue(
      {
        counts: { pending: 1 },
        oldestPendingAt: new Date(NOW.getTime() - QUEUE_THRESHOLDS.pendingWarnMinutes * 60_000),
      },
      NOW,
    );
    expect(posture.severity).toBe("warn");
    expect(posture.remedy).toContain("worker tick");
  });

  it("goes critical at the critical threshold", () => {
    const posture = summariseQueue(
      {
        counts: { pending: 1 },
        oldestPendingAt: new Date(NOW.getTime() - QUEUE_THRESHOLDS.pendingCriticalMinutes * 60_000),
      },
      NOW,
    );
    expect(posture.severity).toBe("critical");
    expect(posture.remedy).toContain("JOB_WORKER_ENABLED");
  });

  it("treats any dead job as a warning even when nothing is pending", () => {
    const posture = summariseQueue({ counts: { dead: 3 }, oldestPendingAt: null }, NOW);
    expect(posture.severity).toBe("warn");
    expect(posture.dead).toBe(3);
    expect(posture.summary).toContain("3 jobs parked as dead");
  });

  it("never treats running jobs as stuck", () => {
    const posture = summariseQueue(
      { counts: { running: 4 }, oldestPendingAt: new Date(NOW.getTime() - 24 * 3_600_000) },
      NOW,
    );
    expect(posture.severity).toBe("ok");
    expect(posture.oldestPendingAgeMs).toBeNull();
  });
});

describe("RLS boot gate", () => {
  const devSqlite = { DATABASE_URL: "file:./dev.db", NODE_ENV: "development" };

  it("says nothing on a plain SQLite development box", () => {
    expect(rlsBootFindings(devSqlite)).toEqual([]);
  });

  it("refuses to boot when RLS is requested without PostgreSQL", () => {
    const findings = rlsBootFindings({ ...devSqlite, RLS_ENABLED: "true" });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: "error", code: "RLS_CONFIG_CONTRADICTION" });
    expect(() => assertRlsBootFindings(findings)).toThrow(/Refusing to boot/);
  });

  it("warns (without blocking) about SQLite in production", () => {
    const findings = rlsBootFindings({ ...devSqlite, NODE_ENV: "production" });
    expect(findings.map((f) => f.code)).toContain("SQLITE_IN_PRODUCTION");
    expect(findings.every((f) => f.level === "warn")).toBe(true);
    expect(() => assertRlsBootFindings(findings)).not.toThrow();
  });

  it("warns (without blocking) when production Postgres runs with RLS off", () => {
    const findings = rlsBootFindings({
      DATABASE_URL: "postgresql://user:pw@db:5432/ledgerly",
      NODE_ENV: "production",
    });
    expect(findings.map((f) => f.code)).toEqual(["RLS_OFF_IN_PRODUCTION"]);
    expect(() => assertRlsBootFindings(findings)).not.toThrow();
  });

  it("blocks when production Postgres requests RLS before the query layer is wrapped", () => {
    const findings = rlsBootFindings({
      DATABASE_URL: "postgresql://user:pw@db:5432/ledgerly",
      NODE_ENV: "production",
      RLS_ENABLED: "true",
    });
    expect(findings.map((f) => f.code)).toEqual(["RLS_CONFIG_CONTRADICTION"]);
    expect(() => assertRlsBootFindings(findings)).toThrow(/RLS/);
  });
});

describe("backup evidence", () => {
  it("rejects a receipt that is not the shape the drill writes", () => {
    expect(parseBackupReceipt(null)).toBeNull();
    expect(parseBackupReceipt({ ranAt: "not-a-date", ok: true })).toBeNull();
    expect(parseBackupReceipt({ ranAt: "2026-11-01T00:00:00.000Z", ok: "yes" })).toBeNull();
  });

  it("is never 'fine' without a receipt", () => {
    const posture = backupPosture(null, NOW);
    expect(posture.severity).toBe("warn");
    expect(posture.verified).toBe(false);
    expect(posture.summary).toContain("No backup drill receipt");
  });

  it("is critical when the last drill failed, regardless of age", () => {
    const posture = backupPosture(
      { ranAt: "2026-11-10T00:00:00.000Z", ok: false, rows: null, note: "row count mismatch" },
      NOW,
    );
    expect(posture.severity).toBe("critical");
    expect(posture.verified).toBe(false);
    expect(posture.ageDays).toBe(1);
  });

  it("passes a fresh proven restore and reports the row count", () => {
    const posture = backupPosture(
      { ranAt: "2026-11-09T00:00:00.000Z", ok: true, rows: 10000, note: null },
      NOW,
    );
    expect(posture.severity).toBe("ok");
    expect(posture.verified).toBe(true);
    expect(posture.ageDays).toBe(2);
    expect(posture.summary).toContain("10,000 rows compared");
  });

  it("warns when the proven restore is older than the limit", () => {
    const posture = backupPosture(
      { ranAt: "2026-09-01T00:00:00.000Z", ok: true, rows: 10, note: null },
      NOW,
      30,
    );
    expect(posture.severity).toBe("warn");
    expect(posture.verified).toBe(true);
    expect(posture.ageDays).toBe(71);
  });
});
