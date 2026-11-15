/**
 * Filing automation — the work the board cannot ask a person to remember.
 *
 * Three decisions, all pure and oracle-tested:
 *  1. Deadline reminders at T-7, T-3 and T-0 for runs that are not yet filed.
 *  2. Escalation when a run has crossed its due date and is still open.
 *  3. Nothing else: no auto-filing. A machine may remind and escalate; it may
 *     not claim a statutory return was lodged.
 *
 * Delivery is deliberately split: the assignee gets the reminder, the firm's
 * owners/admins get an escalation. Dedupe is the append-only filing event log,
 * so a process restart or two replicas running the job cannot double-notify.
 */

import { prisma } from "@/lib/db";
import { notify } from "@/lib/server/activity";

export const REMINDER_OFFSETS = [7, 3, 0] as const;
export type ReminderKind = "T-7" | "T-3" | "T-0";

const DAY_MS = 86_400_000;

function dayNumber(iso: string): number | null {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / DAY_MS) : null;
}

/** Days from `today` to `dueDate` (positive = still ahead). */
export function daysUntil(dueDate: string, today: string): number | null {
  const due = dayNumber(dueDate);
  const now = dayNumber(today);
  if (due === null || now === null) return null;
  return due - now;
}

/** The reminder bucket a run falls into today, if any. */
export function reminderKind(dueDate: string, today: string): ReminderKind | null {
  const days = daysUntil(dueDate, today);
  if (days === null) return null;
  if (days === 7) return "T-7";
  if (days === 3) return "T-3";
  if (days === 0) return "T-0";
  return null;
}

/** A run escalates once it is past due and still not filed/acknowledged. */
export function escalationDue(stage: string, dueDate: string, today: string): boolean {
  if (stage === "filed" || stage === "acknowledged") return false;
  const days = daysUntil(dueDate, today);
  return days !== null && days < 0;
}

/** Event note used as the idempotency key for a reminder. */
export function reminderMarker(kind: ReminderKind): string {
  return `reminder:${kind}`;
}

/** Event note used as the idempotency key for an escalation (one per day). */
export function escalationMarker(today: string): string {
  return `escalated:${today}`;
}

export interface FilingAutomationResult {
  reminders: number;
  escalations: number;
}

/**
 * Run the reminder + escalation pass for every organization.
 *
 * The query is bounded to runs due within the reminder window or already
 * overdue, so a firm with thousands of historical runs does not scan them on
 * every scheduler tick. Failures are counted per run and never abort the pass.
 */
export async function runFilingAutomation(now: Date = new Date()): Promise<FilingAutomationResult> {
  const today = now.toISOString().slice(0, 10);
  const windowEnd = new Date(now.getTime() + 8 * DAY_MS).toISOString().slice(0, 10);

  const runs = await prisma.complianceFilingRun.findMany({
    where: {
      stage: { notIn: ["filed", "acknowledged"] },
      dueDate: { lte: windowEnd },
    },
    select: {
      id: true,
      organizationId: true,
      engagementId: true,
      title: true,
      dueDate: true,
      stage: true,
      assigneeId: true,
      engagement: { select: { name: true } },
      events: { select: { note: true }, orderBy: { createdAt: "desc" }, take: 50 },
    },
    take: 2000,
  });

  const result: FilingAutomationResult = { reminders: 0, escalations: 0 };

  for (const run of runs) {
    const notes = new Set(run.events.map((event) => event.note ?? ""));
    const kind = reminderKind(run.dueDate, today);
    if (kind && !notes.has(reminderMarker(kind))) {
      try {
        if (run.assigneeId) {
          await notify(run.assigneeId, {
            type: "system",
            title: `Filing ${kind}: ${run.title}`,
            message: `${run.engagement.name} — ${run.title} is due ${run.dueDate}. Open Firm Operations to see what is outstanding.`,
          });
        }
        await prisma.complianceFilingEvent.create({
          data: {
            runId: run.id,
            organizationId: run.organizationId,
            fromStage: run.stage,
            toStage: run.stage,
            note: reminderMarker(kind),
            actorId: "system",
          },
        });
        result.reminders += 1;
      } catch {
        // A failed notification must not stop other runs from being reminded.
      }
    }

    if (escalationDue(run.stage, run.dueDate, today) && !notes.has(escalationMarker(today))) {
      try {
        const recipients = await escalationRecipients(run.organizationId);
        for (const userId of recipients) {
          await notify(userId, {
            type: "system",
            title: `Overdue filing: ${run.title}`,
            message: `${run.engagement.name} — ${run.title} was due ${run.dueDate} and is still at “${run.stage}”.`,
          });
        }
        await prisma.complianceFilingEvent.create({
          data: {
            runId: run.id,
            organizationId: run.organizationId,
            fromStage: run.stage,
            toStage: run.stage,
            note: escalationMarker(today),
            actorId: "system",
          },
        });
        result.escalations += 1;
      } catch {
        // Isolated: one organization's membership problem never blocks others.
      }
    }
  }

  return result;
}

/** Owners and admins of the organization, cached per pass. */
async function escalationRecipients(organizationId: string): Promise<string[]> {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, role: { in: ["OWNER", "ADMIN"] } },
    select: { userId: true },
    take: 25,
  });
  return members.map((member) => member.userId);
}
