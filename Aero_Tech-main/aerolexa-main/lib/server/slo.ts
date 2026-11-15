/**
 * Operator alerts.
 *
 * Metrics are for graphing; an operator needs a short list of things that are
 * actually wrong. This module evaluates the postures the app already measures
 * and emits deterministic alerts with a remedy. It never sends anything: the
 * alert endpoint is token-guarded and a scrape/alert manager decides delivery.
 */

import { filingGatewayHealth } from "@/lib/engine/filing/gateway";
import { backupPosture, readBackupReceipt } from "@/lib/server/backup-evidence";
import { outboxPosture } from "@/lib/server/mail-outbox";
import { queueHealth } from "@/lib/server/queue-health";
import { collectTenantOps } from "@/lib/server/tenant-ops";

export type OpsAlertSeverity = "warning" | "critical";

export interface OpsAlert {
  id: string;
  severity: OpsAlertSeverity;
  title: string;
  detail: string;
  remedy: string;
}

export interface OpsAlertInput {
  queue: { severity: "ok" | "warn" | "critical"; dead: number; pending: number };
  outbox: { failed: number; pending: number; oldestPendingAgeMs: number | null };
  backup: { severity: "ok" | "warn" | "critical"; verified: boolean; ageDays: number | null };
  tenants: { critical: number };
  filing: { provider: string; channelConfigured: boolean };
}

export interface OpsAlertPosture {
  ok: boolean;
  alerts: OpsAlert[];
  summary: string;
}

export function evaluateOpsAlerts(input: OpsAlertInput): OpsAlertPosture {
  const alerts: OpsAlert[] = [];

  if (input.queue.severity === "critical") {
    alerts.push({
      id: "queue-critical",
      severity: "critical",
      title: "Job worker is not draining the queue",
      detail: `${input.queue.pending} job(s) pending and the oldest crossed the critical threshold.`,
      remedy: "Check the worker process and JOB_WORKER_ENABLED; confirm the pending count falls.",
    });
  } else if (input.queue.dead > 0) {
    alerts.push({
      id: "queue-dead",
      severity: "warning",
      title: `${input.queue.dead} job(s) parked as dead`,
      detail: "These exhausted their retries and no one will run them automatically.",
      remedy: "Inspect JobQueue.lastError, fix the cause, then re-enqueue.",
    });
  } else if (input.queue.severity === "warn") {
    alerts.push({
      id: "queue-warn",
      severity: "warning",
      title: "Job queue is waiting",
      detail: "A pending job has crossed the warning threshold.",
      remedy: "Confirm the worker tick is running.",
    });
  }

  if (input.outbox.failed > 0) {
    alerts.push({
      id: "outbox-failed",
      severity: "warning",
      title: `${input.outbox.failed} message(s) were never delivered`,
      detail: "The outbox exhausted its retries; a firm may believe it notified a client when it did not.",
      remedy: "Read MailOutbox.lastError, fix the SMTP cause, reset status to pending, and let the worker retry.",
    });
  } else if (
    input.outbox.pending > 0 &&
    input.outbox.oldestPendingAgeMs !== null &&
    input.outbox.oldestPendingAgeMs > 30 * 60_000
  ) {
    alerts.push({
      id: "outbox-stale",
      severity: "warning",
      title: "Outbox delivery is behind",
      detail: `${input.outbox.pending} message(s) pending; the oldest has waited over 30 minutes.`,
      remedy: "Check that the worker runs startMailOutboxWorker and that SMTP is reachable.",
    });
  }

  if (input.backup.severity === "critical") {
    alerts.push({
      id: "backup-critical",
      severity: "critical",
      title: "Backup evidence is missing or stale",
      detail: input.backup.verified
        ? `The last verified restore drill is ${input.backup.ageDays ?? "unknown"} day(s) old.`
        : "No successful restore drill is on record.",
      remedy: "Run the backup drill and store its receipt; do not onboard a paying firm without a verified restore.",
    });
  } else if (input.backup.severity === "warn" || !input.backup.verified) {
    alerts.push({
      id: "backup-warn",
      severity: "warning",
      title: "Backup verification needs attention",
      detail: input.backup.verified ? "The restore receipt is older than the warning window." : "No successful restore drill is recorded.",
      remedy: "Run scripts/backup-drill.mjs and confirm the receipt is picked up by the preflight.",
    });
  }

  if (input.tenants.critical > 0) {
    alerts.push({
      id: "tenant-attention",
      severity: "warning",
      title: `${input.tenants.critical} tenant(s) need attention`,
      detail: "At least one tenant has overdue filings or failed outbound mail.",
      remedy: "Open /api/metrics tenant lines and work the overdue filing or failed message.",
    });
  }

  if (input.filing.provider === "live" && !input.filing.channelConfigured) {
    alerts.push({
      id: "filing-credentials",
      severity: "critical",
      title: "Live filing is selected but the channel is incomplete",
      detail: "A submission would fail at the credential check instead of reaching the portal.",
      remedy: "Complete the active channel's FILING_* variables or set FILING_GATEWAY=reference until ready.",
    });
  }

  const sorted = alerts.sort((a, b) => (a.severity === b.severity ? a.id.localeCompare(b.id) : a.severity === "critical" ? -1 : 1));
  return {
    ok: sorted.length === 0,
    alerts: sorted,
    summary:
      sorted.length === 0
        ? "No operator alerts: every measured posture is inside its thresholds."
        : `${sorted.filter((alert) => alert.severity === "critical").length} critical and ${sorted.filter((alert) => alert.severity === "warning").length} warning alert(s).`,
  };
}

export async function collectOpsAlerts(now: Date = new Date()): Promise<OpsAlertPosture> {
  const [queue, outbox, receipt, tenants] = await Promise.all([
    queueHealth(now),
    outboxPosture(now),
    readBackupReceipt(),
    collectTenantOps(now.toISOString().slice(0, 10)),
  ]);
  const backup = backupPosture(receipt, now);
  const health = filingGatewayHealth();
  const channel = health.activeChannel === "none" ? null : health.channels[health.activeChannel];

  return evaluateOpsAlerts({
    queue,
    outbox: outbox.counts
      ? {
          failed: outbox.counts.failed,
          pending: outbox.counts.pending + outbox.counts.sending,
          oldestPendingAgeMs: outbox.oldestPendingAgeMs,
        }
      : { failed: 0, pending: 0, oldestPendingAgeMs: null },
    backup: { severity: backup.severity, verified: backup.verified, ageDays: backup.ageDays },
    tenants: { critical: tenants.tenants.filter((tenant) => tenant.attention === "critical").length },
    filing: { provider: health.provider, channelConfigured: Boolean(channel?.configured) },
  });
}

/** Prometheus gauges for the alert list, appended by /api/metrics. */
export function renderOpsAlertsMetrics(posture: OpsAlertPosture): string {
  const lines = [
    "# HELP ledgerly_ops_alert Operator alerts by severity.",
    "# TYPE ledgerly_ops_alert gauge",
    `ledgerly_ops_alert{severity="critical"} ${posture.alerts.filter((alert) => alert.severity === "critical").length}`,
    `ledgerly_ops_alert{severity="warning"} ${posture.alerts.filter((alert) => alert.severity === "warning").length}`,
  ];
  return `${lines.join("\n")}\n`;
}
