/**
 * Statutory due-date drift.
 *
 * The compliance calendar is generated from a client's registration profile at
 * a point in time, and the generated task id (`client:code:period:occurrence`)
 * is stable across regeneration. When a notification, a corrected profile or a
 * code change moves a date, the stored `ComplianceFilingRun.dueDate` and a
 * freshly generated calendar disagree. Today that disagreement is silent: the
 * board keeps showing the old date and the firm misses (or over-prepares for)
 * the real one.
 *
 * This engine reports the disagreement instead of picking a winner. The firm
 * decides whether to move the run; the queue shows the evidence.
 */

export interface TrackedDueDate {
  taskId: string;
  /** Stored on the filing run. */
  dueDate: string;
  title: string;
  clientName?: string | null;
}

export interface GeneratedDueDate {
  taskId: string;
  /** Freshly computed from the profile. */
  dueDate: string;
}

export type DriftDirection = "advanced" | "postponed";

export interface DueDateDrift {
  taskId: string;
  title: string;
  clientName: string | null;
  storedDueDate: string;
  generatedDueDate: string;
  /** Whole days the deadline moved. Negative = earlier than stored. */
  daysShifted: number;
  direction: DriftDirection;
  /** An earlier deadline is the dangerous direction. */
  severity: "warning" | "info";
}

const DAY_MS = 86_400_000;

function dayMs(value: string): number | null {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Compare stored run dates against a regenerated calendar.
 *
 * Only tasks present on both sides are compared: a run whose obligation is no
 * longer generated (deregistration) or a task with no stored run is a different
 * problem and is not invented here.
 */
export function detectDueDateDrift(
  tracked: TrackedDueDate[],
  generated: GeneratedDueDate[],
): DueDateDrift[] {
  const byTask = new Map(generated.map((task) => [task.taskId, task.dueDate]));
  const drifts: DueDateDrift[] = [];

  for (const task of tracked) {
    const next = byTask.get(task.taskId);
    if (!next || next === task.dueDate) continue;
    const from = dayMs(task.dueDate);
    const to = dayMs(next);
    if (from === null || to === null) continue;
    const daysShifted = Math.round((to - from) / DAY_MS);
    drifts.push({
      taskId: task.taskId,
      title: task.title,
      clientName: task.clientName ?? null,
      storedDueDate: task.dueDate,
      generatedDueDate: next,
      daysShifted,
      direction: daysShifted < 0 ? "advanced" : "postponed",
      severity: daysShifted < 0 ? "warning" : "info",
    });
  }

  return drifts.sort(
    (a, b) =>
      a.severity.localeCompare(b.severity) === 0
        ? a.storedDueDate.localeCompare(b.storedDueDate)
        : a.severity === "warning"
          ? -1
          : 1,
  );
}
