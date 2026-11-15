/**
 * Compliance notifications, deadline summaries and exposure scoring.
 *
 * Two rules govern this module:
 *
 *  1. A notification is only reported as sent when a transport accepted it.
 *     There is no "queued" state that pretends to be delivery.
 *  2. Nothing is inferred from data the system does not have. The earlier
 *     `severityTrend` compared the current overdue count against a *simulated*
 *     prior count (`overdueCritical * 0.8`) and the resource predictor invented
 *     a "suitability score" from fixed weights. Both produced numbers that read
 *     as analysis but were fiction; they are gone. A trend now requires a real
 *     historical baseline supplied by the caller.
 */

import { sendMail } from "@/lib/auth/mail";
import { prisma } from "@/lib/db";
import {
  complianceTaskState,
  type ComplianceTask,
} from "@/lib/engine/compliance-calendar";
import { daysUntilDue, notifyComplianceDeadline, sendSms, type SendSmsResult } from "@/lib/notifications/sms";

export const DEFAULT_DUE_SOON_DAYS = 30;

/**
 * Send reminders for tasks due within `daysThreshold`.
 * Returns one result per task, including tasks the transport rejected.
 */
export async function sendComplianceReminderSms({
  phone,
  tasks,
  daysThreshold = DEFAULT_DUE_SOON_DAYS,
}: {
  phone: string;
  tasks: ComplianceTask[];
  daysThreshold?: number;
}): Promise<Array<{ task: ComplianceTask; result: SendSmsResult }>> {
  const results: Array<{ task: ComplianceTask; result: SendSmsResult }> = [];
  for (const task of tasks) {
    const days = daysUntilDue(task.dueDate);
    if (days == null || days > daysThreshold) continue;
    const result = await sendSms({
      to: phone,
      body:
        "\n⚠️ " +
        (days <= 3 ? "CRITICAL" : days <= 7 ? "WARNING" : "REMINDER") +
        " — Compliance Deadline\n\nEngagement: " +
        task.title +
        "\nDue: " +
        task.dueDate +
        "\nDays left: " +
        days +
        "\n\nAction required: Log in to review and file before deadline.\n\n—— Ledgerly Compliance Bot",
      referenceId: task.id,
      priority: days <= 3 ? "high" : "normal",
    });
    results.push({ task, result });
  }
  return results;
}

/** Individually-addressable deadline notifications (same contract as above). */
export async function sendIndividualDeadlineNotifications(
  phone: string,
  tasks: ComplianceTask[],
  daysThreshold = 7,
): Promise<Array<{ task: ComplianceTask; result: SendSmsResult }>> {
  const results: Array<{ task: ComplianceTask; result: SendSmsResult }> = [];
  for (const task of tasks) {
    const days = daysUntilDue(task.dueDate);
    if (days == null || days > daysThreshold) continue;
    const result = await notifyComplianceDeadline(phone, task.clientName, task.title, task.dueDate, days, task.id);
    results.push({ task, result });
  }
  return results;
}

/** Categorise tasks by urgency state. */
export function summarizeTasksByState(tasks: ComplianceTask[]): {
  overdue: ComplianceTask[];
  dueSoon: ComplianceTask[];
  upcoming: ComplianceTask[];
} {
  const today = new Date().toISOString().slice(0, 10);
  const overdue: ComplianceTask[] = [];
  const dueSoon: ComplianceTask[] = [];
  const upcoming: ComplianceTask[] = [];
  for (const task of tasks) {
    const noteFiled = task.note === "filed" ? "filed" : task.note === "waived" ? "waived" : null;
    const state = complianceTaskState(task.dueDate, today, noteFiled);
    if (state === "overdue") overdue.push(task);
    else if (state === "due-soon") dueSoon.push(task);
    else upcoming.push(task);
  }
  return { overdue, dueSoon, upcoming };
}

export interface EngagementNotificationResult {
  success: boolean;
  delivered: boolean;
  transport: "email" | "sms" | "email+sms" | "none";
  message: string;
  recipients: string[];
}

/**
 * Notify a real recipient about an engagement event.
 *
 * Recipients resolve in this order: an explicit address/addresses, then the
 * engagement's own members (email and phone from their account). When neither
 * exists the call fails explicitly — the previous implementation logged to the
 * console and returned `success: true`, which is indistinguishable from a sent
 * notification at every call site.
 */
export async function sendEngagementNotification({
  engagementId,
  purpose,
  title,
  message,
  type = "email",
  to,
}: {
  engagementId: string;
  purpose: string;
  title: string;
  message: string;
  type?: "email" | "sms" | "both";
  to?: string | string[];
}): Promise<EngagementNotificationResult> {
  const engagement = await prisma.engagement.findUnique({
    where: { id: engagementId },
    select: { name: true, members: { select: { userId: true } } },
  });
  if (!engagement) {
    return {
      success: false,
      delivered: false,
      transport: "none",
      message: "Engagement not found; nothing was sent.",
      recipients: [],
    };
  }

  const explicit = (Array.isArray(to) ? to : to ? [to] : []).map((v) => v.trim()).filter(Boolean);
  let emails: string[] = [];
  let phones: string[] = [];

  if (explicit.length > 0) {
    if (type === "sms") phones = explicit;
    else if (type === "both") {
      emails = explicit.filter((v) => v.includes("@"));
      phones = explicit.filter((v) => !v.includes("@"));
    } else emails = explicit;
  } else {
    const memberIds = engagement.members.map((m) => m.userId);
    if (memberIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: memberIds } },
        select: { email: true, phoneNumber: true },
      });
      emails = users.map((u) => u.email).filter((v): v is string => Boolean(v));
      phones = users.map((u) => u.phoneNumber ?? "").filter((v) => v.length > 0);
    }
  }

  if (emails.length === 0 && phones.length === 0) {
    return {
      success: false,
      delivered: false,
      transport: "none",
      message: `No recipient address is on file for ${engagement.name}; nothing was sent.`,
      recipients: [],
    };
  }

  const failures: string[] = [];
  let delivered = false;
  const recipients: string[] = [];

  if (type !== "sms" && emails.length > 0) {
    for (const email of [...new Set(emails)]) {
      try {
        await sendMail({
          to: email,
          subject: `[${purpose}] ${title}`,
          text: `${title}\n\n${message}\n\n— Ledgerly`,
        });
        delivered = true;
        recipients.push(email);
      } catch (err) {
        failures.push(`${email}: ${err instanceof Error ? err.message : "mail transport failed"}`);
      }
    }
  }

  if (type !== "email" && phones.length > 0) {
    for (const phone of [...new Set(phones)]) {
      const result = await sendSms({
        to: phone,
        body: `${title}\n\n${message}\n\n— Ledgerly`,
        referenceId: engagementId,
      });
      if (result.success) {
        // Console transport counts as accepted but never as delivered.
        if (result.delivered) delivered = true;
        recipients.push(phone);
      } else {
        failures.push(`${phone}: ${result.error ?? "SMS transport failed"}`);
      }
    }
  }

  const transport: EngagementNotificationResult["transport"] =
    type === "both" ? "email+sms" : type;
  return {
    success: recipients.length > 0 && failures.length === 0,
    delivered,
    transport,
    message:
      failures.length > 0
        ? `Delivered to ${recipients.length} recipient(s); failed for ${failures.join("; ")}.`
        : `Delivered to ${recipients.length} recipient(s).`,
    recipients,
  };
}

/**
 * Weighted compliance exposure on a 0–100 scale.
 *
 * The score is a transparent weighted count: every task contributes a fixed
 * number of points by proximity to its deadline, divided by the maximum a
 * calendar of this size could contribute. No history is assumed and no baseline
 * is fabricated — a client with nothing overdue cannot score high because time
 * passed.
 */
export function computeRiskScore(tasks: ComplianceTask[]): number {
  const open = tasks.filter((task) => task.note !== "filed" && task.note !== "waived");
  if (open.length === 0) return 0;

  let weighted = 0;
  for (const task of open) {
    const days = daysUntilDue(task.dueDate);
    if (days < 0 || days <= 3) weighted += 25;
    else if (days <= 7) weighted += 18;
    else if (days <= 14) weighted += 12;
    else if (days <= 30) weighted += 6;
    else if (days <= 60) weighted += 2;
  }

  const maximum = open.length * 25;
  return Math.max(0, Math.min(100, Math.round((weighted / maximum) * 100)));
}

export interface DeadlineForecast {
  critical: ComplianceTask[];
  warning: ComplianceTask[];
  upcoming: ComplianceTask[];
  next30Days: number;
  /**
   * `null` when the caller supplied no historical overdue count. A direction
   * cannot be observed from a single snapshot, so none is invented.
   */
  severityTrend: "improving" | "stable" | "worsening" | null;
  /** Where the trend number came from; `none` means no claim is being made. */
  trendBasis: "supplied-history" | "none";
}

/**
 * Group deadlines by urgency. `previousOverdue` must come from stored history
 * (for example yesterday's `ClientComplianceStatus` snapshot); without it the
 * trend is reported as unknown rather than guessed.
 */
export function forecastDeadlines(
  tasks: ComplianceTask[],
  opts: { previousOverdue?: number | null } = {},
): DeadlineForecast {
  const critical: ComplianceTask[] = [];
  const warning: ComplianceTask[] = [];
  const upcoming: ComplianceTask[] = [];

  for (const task of tasks) {
    const days = daysUntilDue(task.dueDate);
    if (days < 0) critical.push(task);
    else if (days <= 7) warning.push(task);
    else if (days <= 30) upcoming.push(task);
  }

  const overdue = critical.length;
  const previous = opts.previousOverdue;
  const hasHistory = typeof previous === "number" && Number.isFinite(previous);
  const severityTrend = !hasHistory
    ? null
    : overdue > (previous as number)
      ? "worsening"
      : overdue < (previous as number)
        ? "improving"
        : "stable";

  return {
    critical,
    warning,
    upcoming,
    next30Days: critical.length + warning.length + upcoming.length,
    severityTrend,
    trendBasis: hasHistory ? "supplied-history" : "none",
  };
}
