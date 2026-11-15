/**
 * Compliance nudges.
 *
 * A due date nobody sent to the client is not a reminder. This module renders a
 * short, honest digest of the next obligations for one client and queues it in
 * the durable outbox (so a mail outage retries instead of losing it).
 *
 * It is firm-triggered, not an autonomous legal notice: the text says the firm
 * generated it, lists the dates, and does not claim the client is compliant.
 */

import type { ComplianceTask } from "@/lib/engine/compliance-calendar";

import { enqueueMail } from "./mail-outbox";

export interface NudgeDigest {
  subject: string;
  text: string;
  taskCount: number;
}

function daysUntil(today: string, dueDate: string): number {
  return Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/**
 * Build the digest, or null when nothing is overdue/approaching. `horizonDays`
 * bounds how far ahead the client is asked to look.
 */
export function buildNudgeDigest(input: {
  firmName: string;
  clientName: string;
  tasks: ComplianceTask[];
  today: string;
  horizonDays?: number;
}): NudgeDigest | null {
  const horizon = input.horizonDays ?? 30;
  const selected = input.tasks
    .map((task) => ({ task, days: daysUntil(input.today, task.dueDate) }))
    .filter(({ days }) => days <= horizon)
    .sort((a, b) => a.days - b.days)
    .slice(0, 20);
  if (selected.length === 0) return null;

  const lines = selected.map(({ task, days }) => {
    const when = days < 0 ? `overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}` : `${days} day${days === 1 ? "" : "s"} to go`;
    return `- ${task.title} (${task.authority}) — due ${task.dueDate}, ${when}`;
  });

  return {
    subject: `${selected.length} compliance date${selected.length === 1 ? "" : "s"} for ${input.clientName}`,
    text: [
      `Hello ${input.clientName},`,
      "",
      `${input.firmName} has these statutory dates on record for you:`,
      "",
      ...lines,
      "",
      "This is a firm-generated reminder. It is not a statutory notice and does not confirm that a filing has been made.",
      `Prepared on ${input.today}.`,
    ].join("\n"),
    taskCount: selected.length,
  };
}

export async function queueComplianceNudge(input: {
  organizationId: string;
  to: string;
  firmName: string;
  clientName: string;
  tasks: ComplianceTask[];
  today: string;
  horizonDays?: number;
}): Promise<{ queued: false; taskCount: 0 } | { queued: true; id: string; taskCount: number }> {
  const digest = buildNudgeDigest(input);
  if (!digest) return { queued: false, taskCount: 0 };
  const { id } = await enqueueMail({
    organizationId: input.organizationId,
    to: input.to,
    subject: digest.subject,
    text: digest.text,
  });
  return { queued: true, id, taskCount: digest.taskCount };
}
