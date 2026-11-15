/**
 * Data alerts — server orchestration.
 *
 * The pure engine (lib/engine/alerts.ts) decides *whether* a rule fires;
 * this module owns everything stateful around it:
 *
 *  - loading the dataset's live rows and extracting the watched column
 *  - maintaining the anomaly baseline (`valueHistory`, capped at 90 points)
 *  - firing → resolved transitions with a per-alert cooldown so a flapping
 *    metric cannot spam the inbox
 *  - delivery: email (nodemailer) and WhatsApp (Business Cloud API template
 *    hook, same transport as OTP) — never both silent
 *  - one audit entry per notification, honest evidence in every message
 *
 * Evaluation points:
 *  - after every connector sync (runAlertEvaluationsForDataset) — the
 *    "data changed, is anything wrong?" moment
 *  - from the scheduler poller (runDueAlertChecks) for staleness rules,
 *    which must fire even when nothing syncs anymore
 */

import { createHmac } from "node:crypto";

import { mailFooter } from "@/lib/auth/mail";
import { prisma } from "@/lib/db";
import { evaluateAlert, isAlertRuleConfig, type AlertRuleConfig, type AlertVerdict } from "@/lib/engine/alerts";
import { columnIndex, loadParsedDataset } from "@/lib/engine/dataset";
import { appUrl, serverEnv } from "@/lib/env";
import { notify } from "@/lib/server/activity";

const MAX_HISTORY = 90;

interface HistoryPoint {
  t: number;
  v: number;
}

function parseHistory(raw: string): HistoryPoint[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is { t: number; v: number } => {
        if (p === null || typeof p !== "object") return false;
        const rec = p as Record<string, unknown>;
        return typeof rec.t === "number" && typeof rec.v === "number" && Number.isFinite(rec.v);
      })
      .slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

function appendHistory(raw: string, value: number, now: Date): string {
  const history = parseHistory(raw);
  history.push({ t: now.getTime(), v: value });
  return JSON.stringify(history.slice(-MAX_HISTORY));
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

function severityEmoji(severity: string): string {
  return severity === "critical" ? "🔴" : severity === "warning" ? "🟠" : "🔵";
}

interface DeliverInput {
  to: string[];
  whatsappPhones: string[];
  alertName: string;
  datasetName: string;
  verdict: AlertVerdict;
  dashboardUrl: string;
}

/** Send the alert through every configured channel; failures never throw. */
async function deliverAlert(input: DeliverInput): Promise<{ emailed: number; whatsapped: number }> {
  const { verdict } = input;
  const subject = `${severityEmoji(verdict.severity)} Ledgerly alert: ${input.alertName}`;
  const text = [
    `${verdict.message}`,
    "",
    `Dataset: ${input.datasetName}`,
    `View: ${input.dashboardUrl}`,
    "",
    mailFooter(),
  ].join("\n");

  let emailed = 0;
  for (const email of input.to) {
    try {
      const { sendMail } = await import("@/lib/auth/mail");
      await sendMail({ to: email, subject, text });
      emailed += 1;
    } catch {
      // Delivery failure must not break evaluation; lastError surfaces it.
    }
  }

  let whatsapped = 0;
  const env = serverEnv();
  if (env.WHATSAPP_ENABLED && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN) {
    for (const phone of input.whatsappPhones) {
      try {
        const res = await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: phone,
            type: "text",
            text: { body: `${subject}\n\n${verdict.message}\n\n${input.dashboardUrl}` },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) whatsapped += 1;
      } catch {
        // Same posture: never throw from delivery.
      }
    }
  }
  return { emailed, whatsapped };
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

/** Extract the watched column's raw cells from the dataset's live rows. */
async function loadColumnValues(
  datasetId: string,
  columnName: string,
): Promise<{ values: unknown[]; columnType: string | null; totalRows: number }> {
  const dataset = await prisma.dataset.findUnique({
    where: { id: datasetId },
    select: { columns: true, updatedAt: true },
  });
  if (!dataset) return { values: [], columnType: null, totalRows: 0 };
  const columns = JSON.parse(dataset.columns || "[]") as { name: string; type: string }[];
  const idx = columnIndex(columns as never, columnName);
  if (idx < 0) return { values: [], columnType: null, totalRows: 0 };
  const { rows, totalRows } = await loadParsedDataset(datasetId);
  const values = rows.map((row) => row[idx]);
  return { values, columnType: columns[idx]?.type ?? null, totalRows };
}

/**
 * Evaluate one alert rule. Persists the verdict, manages fired→resolved
 * transitions + cooldown, and returns whether a notification was sent.
 */
export async function evaluateDataAlert(
  alertId: string,
  now: Date = new Date(),
): Promise<{ outcome: string; notified: boolean; verdict: AlertVerdict | null }> {
  const alert = await prisma.dataAlert.findUnique({
    where: { id: alertId },
    include: { dataset: { select: { id: true, name: true, updatedAt: true } } },
  });
  if (!alert || !alert.enabled) return { outcome: "skipped", notified: false, verdict: null };

  const parsed = JSON.parse(alert.ruleConfig || "{}") as unknown;
  if (!isAlertRuleConfig(parsed)) {
    return { outcome: "skipped", notified: false, verdict: null };
  }
  const rule: AlertRuleConfig = parsed;

  let verdict: AlertVerdict;
  let history = parseHistory(alert.valueHistory);

  if (rule.kind === "staleness") {
    verdict = evaluateAlert({
      rule,
      columnValues: [],
      columnType: "number",
      datasetUpdatedAtMs: alert.dataset.updatedAt ? alert.dataset.updatedAt.getTime() : null,
      baseline: [],
      nowMs: now.getTime(),
    });
  } else {
    if (!alert.columnName) return { outcome: "skipped", notified: false, verdict: null };
    const { values } = await loadColumnValues(alert.datasetId, alert.columnName);
    verdict = evaluateAlert({
      rule,
      columnValues: values,
      columnType: "number",
      datasetUpdatedAtMs: alert.dataset.updatedAt ? alert.dataset.updatedAt.getTime() : null,
      baseline: history.map((h) => h.v),
      nowMs: now.getTime(),
    });
    // Every non-staleness evaluation records today's aggregate into the
    // rolling baseline (even non-firing ones — that is what makes the
    // baseline "recent history").
    const v = verdict.value;
    if (v !== null && Number.isFinite(v)) {
      history = parseHistory(appendHistory(alert.valueHistory, v, now));
    }
  }

  const wasFiring = alert.lastOutcome === "firing";
  const firedNow = verdict.outcome === "fired";

  // Cooldown: a firing alert does not re-notify inside its cooldown window.
  const inCooldown =
    alert.lastFiredAt !== null && now.getTime() - alert.lastFiredAt.getTime() < alert.cooldownMinutes * 60_000;
  const shouldNotify = firedNow && !(wasFiring && inCooldown);

  await prisma.dataAlert.update({
    where: { id: alert.id },
    data: {
      lastOutcome: firedNow ? "firing" : wasFiring ? "resolved" : "never",
      lastFiredAt: firedNow ? now : alert.lastFiredAt,
      lastResolvedAt: !firedNow && wasFiring ? now : alert.lastResolvedAt,
      lastValue: verdict.value,
      lastMessage: verdict.message,
      valueHistory: JSON.stringify(history),
    },
  });

  let notified = false;
  if (shouldNotify) {
    const recipients = await alertRecipients(
      alert.workspaceId,
      alert.createdById,
      alert.notifyEmail,
      alert.notifyWhatsapp,
    );
    const result = await deliverAlert({
      to: recipients.emails,
      whatsappPhones: recipients.phones,
      alertName: alert.name,
      datasetName: alert.dataset.name,
      verdict,
      dashboardUrl: `${appUrl()}/datasets/${alert.datasetId}`,
    });
    notified = result.emailed > 0 || result.whatsapped > 0;
    // In-app notification (bell icon) alongside email/WhatsApp.
    await notify(alert.createdById, {
      type: "anomaly",
      title: `Alert “${alert.name}” ${verdict.outcome}`,
      message: verdict.message,
    });
  }

  return { outcome: verdict.outcome, notified, verdict };
}

/** Workspace owner + alert creator emails; creator's verified phone for WhatsApp. */
async function alertRecipients(
  workspaceId: string,
  creatorId: string,
  notifyEmail: boolean,
  notifyWhatsapp: boolean,
): Promise<{ emails: string[]; phones: string[] }> {
  const emails: string[] = [];
  const phones: string[] = [];
  const users = await prisma.user.findMany({
    where: notifyWhatsapp ? { id: { in: [creatorId] }, phoneNumber: { not: null } } : { id: { in: [creatorId] } },
    select: { email: true, phoneNumber: true, phoneVerifiedAt: true },
  });
  for (const user of users) {
    if (notifyEmail) emails.push(user.email);
    if (notifyWhatsapp && user.phoneNumber && user.phoneVerifiedAt) phones.push(user.phoneNumber);
  }
  return { emails, phones };
}

/**
 * Evaluate every enabled alert for one dataset (called after a connector
 * sync completes — the natural "data just changed" checkpoint).
 */
export async function runAlertEvaluationsForDataset(datasetId: string, now: Date = new Date()): Promise<number> {
  const alerts = await prisma.dataAlert.findMany({
    where: { datasetId, enabled: true },
    select: { id: true },
  });
  let notified = 0;
  for (const alert of alerts) {
    try {
      const result = await evaluateDataAlert(alert.id, now);
      if (result.notified) notified += 1;
    } catch {
      // One broken alert never blocks the others (or the sync that triggered us).
    }
  }
  return notified;
}

/**
 * Scheduler hook: evaluate staleness rules for ALL enabled alerts on a cron
 * cadence. Non-staleness rules are also re-evaluated so they can resolve
 * even without a new sync. Returns how many notifications went out.
 */
export async function runDueAlertChecks(now: Date = new Date()): Promise<number> {
  const alerts = await prisma.dataAlert.findMany({
    where: { enabled: true },
    select: { id: true },
    take: 500,
  });
  let notified = 0;
  for (const alert of alerts) {
    try {
      const result = await evaluateDataAlert(alert.id, now);
      if (result.notified) notified += 1;
    } catch {
      // Isolated failure: skip this alert, keep the poller alive.
    }
  }
  return notified;
}

/* ------------------------------------------------------------------ */
/* Connector webhook (push-based refresh)                              */
/* ------------------------------------------------------------------ */

/** Constant-time string equality for HMAC comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}

/**
 * Verify an inbound webhook signature: `X-Ledgerly-Signature: sha256=<hex>`
 * over the raw request body, keyed by the connector's per-connector secret.
 * Returns the connector id on success; null on any mismatch.
 */
export function verifyConnectorWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return safeEqual(expected, match[1]?.toLowerCase() ?? "");
}

/** Generate a new per-connector webhook secret (256-bit, URL-safe hex). */
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
