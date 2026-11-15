/**
 * Operational metrics.
 *
 * `/api/health` is a JSON readiness probe for humans and load balancers. It is
 * the wrong shape for alerting: a dashboard cannot graph a sentence. This
 * module exposes the same measured facts as Prometheus gauges, so queue depth,
 * dead jobs, backup age and filing readiness become alertable series.
 *
 * Honesty rules match the sources:
 *  - an unreadable queue or database reports 0 for `up`, never a fake healthy 1;
 *  - a missing backup receipt has no age series (omitted), and
 *    `ledgerly_backup_verified` is 0;
 *  - the filing gauge reports configuration, not certification. Certification
 *    is a stored-evidence claim and stays in `/compliance/pilot`.
 */

import { prisma } from "@/lib/db";
import { filingGatewayHealth } from "@/lib/engine/filing/gateway";
import { backupPosture, readBackupReceipt, type BackupPosture } from "@/lib/server/backup-evidence";
import { queueHealth, type QueuePosture } from "@/lib/server/queue-health";

export interface OpsMetricsSnapshot {
  now: Date;
  uptimeSeconds: number;
  dbOk: boolean;
  queue: QueuePosture & { available: boolean };
  backup: BackupPosture;
  filing: {
    provider: string;
    activeChannel: string;
    channelConfigured: boolean;
  };
}

function gauge(name: string, help: string, value: number): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`];
}

/** Render the snapshot in Prometheus text exposition format. */
export function renderOpsMetrics(snapshot: OpsMetricsSnapshot): string {
  const lines: string[] = [
    ...gauge("ledgerly_up", "1 while the application process is serving.", 1),
    ...gauge("ledgerly_uptime_seconds", "Process uptime in seconds.", Math.floor(snapshot.uptimeSeconds)),
    ...gauge("ledgerly_db_up", "1 when a database round-trip succeeded.", snapshot.dbOk ? 1 : 0),
    ...gauge("ledgerly_queue_available", "1 when the job queue could be read.", snapshot.queue.available ? 1 : 0),
  ];

  lines.push(
    "# HELP ledgerly_queue_jobs Jobs by status.",
    "# TYPE ledgerly_queue_jobs gauge",
    `ledgerly_queue_jobs{status="pending"} ${snapshot.queue.pending}`,
    `ledgerly_queue_jobs{status="running"} ${snapshot.queue.running}`,
    `ledgerly_queue_jobs{status="done"} ${snapshot.queue.done}`,
    `ledgerly_queue_jobs{status="dead"} ${snapshot.queue.dead}`,
  );

  if (snapshot.queue.oldestPendingAgeMs !== null) {
    lines.push(
      ...gauge(
        "ledgerly_queue_oldest_pending_seconds",
        "Age of the oldest pending job in seconds.",
        Math.floor(snapshot.queue.oldestPendingAgeMs / 1000),
      ),
    );
  }

  lines.push(
    "# HELP ledgerly_queue_severity The queue posture as a one-hot gauge.",
    "# TYPE ledgerly_queue_severity gauge",
    `ledgerly_queue_severity{level="ok"} ${snapshot.queue.severity === "ok" ? 1 : 0}`,
    `ledgerly_queue_severity{level="warn"} ${snapshot.queue.severity === "warn" ? 1 : 0}`,
    `ledgerly_queue_severity{level="critical"} ${snapshot.queue.severity === "critical" ? 1 : 0}`,
  );

  lines.push(
    ...gauge("ledgerly_backup_verified", "1 when a restore drill receipt reports success.", snapshot.backup.verified ? 1 : 0),
    "# HELP ledgerly_backup_severity The backup posture as a one-hot gauge.",
    "# TYPE ledgerly_backup_severity gauge",
    `ledgerly_backup_severity{level="ok"} ${snapshot.backup.severity === "ok" ? 1 : 0}`,
    `ledgerly_backup_severity{level="warn"} ${snapshot.backup.severity === "warn" ? 1 : 0}`,
    `ledgerly_backup_severity{level="critical"} ${snapshot.backup.severity === "critical" ? 1 : 0}`,
  );
  if (snapshot.backup.ageDays !== null) {
    lines.push(
      ...gauge("ledgerly_backup_age_days", "Age of the last restore drill receipt in days.", snapshot.backup.ageDays),
    );
  }

  lines.push(
    ...gauge("ledgerly_filing_live", "1 when FILING_GATEWAY=live.", snapshot.filing.provider === "live" ? 1 : 0),
    ...gauge(
      "ledgerly_filing_channel_configured",
      "1 when the active filing channel has every credential.",
      snapshot.filing.channelConfigured ? 1 : 0,
    ),
  );

  return `${lines.join("\n")}\n`;
}

/** Read every posture. Best-effort: failures degrade the gauge, never throw. */
export async function collectOpsMetrics(now: Date = new Date()): Promise<OpsMetricsSnapshot> {
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const [queue, receipt] = await Promise.all([queueHealth(now), readBackupReceipt()]);
  const health = filingGatewayHealth();
  const availability =
    health.activeChannel === "none" ? null : health.channels[health.activeChannel];

  return {
    now,
    uptimeSeconds: process.uptime(),
    dbOk,
    queue,
    backup: backupPosture(receipt, now),
    filing: {
      provider: health.provider,
      activeChannel: health.activeChannel,
      channelConfigured: Boolean(availability?.configured),
    },
  };
}
