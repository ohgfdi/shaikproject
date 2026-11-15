/**
 * Deadline arithmetic, kept pure so both the API and the screen agree
 * on what "due" means. A reply or a client document that misses its window is a lost
 * opportunity, so the boundary is explicit: the due date itself is still `due`,
 * and anything past it is `overdue` regardless of how many days have elapsed.
 */

export type DeadlineStatus = "overdue" | "due" | "upcoming";

export interface Deadline {
  dueDate: string;
  daysLeft: number;
  status: DeadlineStatus;
}

/** Whole days between two ISO dates (b − a), ignoring time of day. */
function daysBetween(a: string, b: string): number {
  const from = Date.parse(`${a}T00:00:00Z`);
  const to = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

/** Threshold (in days) inside which an open deadline is flagged as immediately due. */
export const DUE_SOON_DAYS = 7;

export function deadlineStatus(dueDate: string, today: string, dueSoonDays = DUE_SOON_DAYS): Deadline {
  const daysLeft = daysBetween(today, dueDate);
  const status: DeadlineStatus = daysLeft < 0 ? "overdue" : daysLeft <= dueSoonDays ? "due" : "upcoming";
  return { dueDate, daysLeft, status };
}

/** Sort key: overdue and nearer deadlines first, then the notice number. */
export function compareByDeadline(
  a: { dueDate: string; label: string },
  b: { dueDate: string; label: string },
): number {
  return a.dueDate.localeCompare(b.dueDate) || a.label.localeCompare(b.label);
}
