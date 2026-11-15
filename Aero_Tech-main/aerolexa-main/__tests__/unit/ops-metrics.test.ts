/**
 * Ops-metrics oracles. The renderer is what an alerting rule reads, so the
 * gauge names and the one-hot severity values must not drift silently.
 */

import { renderOpsMetrics, type OpsMetricsSnapshot } from "@/lib/server/ops-metrics";
import { queueThresholds } from "@/lib/server/queue-health";

function snapshot(overrides: Partial<OpsMetricsSnapshot> = {}): OpsMetricsSnapshot {
  return {
    now: new Date("2026-11-13T10:00:00Z"),
    uptimeSeconds: 1234.8,
    dbOk: true,
    queue: {
      pending: 3,
      running: 1,
      done: 40,
      dead: 2,
      oldestPendingAgeMs: 90_000,
      severity: "warn",
      summary: "test",
      remedy: "test",
      available: true,
    },
    backup: {
      severity: "ok",
      verified: true,
      ageDays: 2,
      ranAt: "2026-11-11T00:00:00Z",
      summary: "test",
      remedy: "test",
    },
    filing: { provider: "reference", activeChannel: "irp-irn", channelConfigured: false },
    ...overrides,
  };
}

describe("renderOpsMetrics", () => {
  it("renders queue counts and the one-hot severity", () => {
    const text = renderOpsMetrics(snapshot());
    expect(text).toContain('ledgerly_queue_jobs{status="pending"} 3');
    expect(text).toContain('ledgerly_queue_jobs{status="dead"} 2');
    expect(text).toContain("ledgerly_queue_oldest_pending_seconds 90");
    expect(text).toContain('ledgerly_queue_severity{level="warn"} 1');
    expect(text).toContain('ledgerly_queue_severity{level="ok"} 0');
  });

  it("omits the oldest-pending series when nothing is pending", () => {
    const text = renderOpsMetrics(
      snapshot({
        queue: { ...snapshot().queue, pending: 0, oldestPendingAgeMs: null, severity: "ok" },
      }),
    );
    expect(text).not.toContain("ledgerly_queue_oldest_pending_seconds");
    expect(text).toContain('ledgerly_queue_severity{level="ok"} 1');
  });

  it("reports a failed database as down and a missing backup as unverified", () => {
    const text = renderOpsMetrics(
      snapshot({
        dbOk: false,
        backup: {
          severity: "warn",
          verified: false,
          ageDays: null,
          ranAt: null,
          summary: "no receipt",
          remedy: "run the drill",
        },
      }),
    );
    expect(text).toContain("ledgerly_db_up 0");
    expect(text).toContain("ledgerly_backup_verified 0");
    expect(text).not.toContain("ledgerly_backup_age_days");
  });

  it("separates live configuration from certification", () => {
    const text = renderOpsMetrics(
      snapshot({ filing: { provider: "live", activeChannel: "irp-irn", channelConfigured: true } }),
    );
    expect(text).toContain("ledgerly_filing_live 1");
    expect(text).toContain("ledgerly_filing_channel_configured 1");
  });
});

describe("queueThresholds", () => {
  it("uses the defaults when the environment is unset", () => {
    expect(queueThresholds({})).toEqual({
      pendingWarnMinutes: 15,
      pendingCriticalMinutes: 60,
    });
  });

  it("honours overrides and keeps critical above warn", () => {
    expect(
      queueThresholds({
        QUEUE_PENDING_WARN_MINUTES: "5",
        QUEUE_PENDING_CRITICAL_MINUTES: "7",
      }),
    ).toEqual({ pendingWarnMinutes: 5, pendingCriticalMinutes: 7 });

    expect(
      queueThresholds({
        QUEUE_PENDING_WARN_MINUTES: "30",
        QUEUE_PENDING_CRITICAL_MINUTES: "10",
      }),
    ).toEqual({ pendingWarnMinutes: 30, pendingCriticalMinutes: 31 });
  });
});
