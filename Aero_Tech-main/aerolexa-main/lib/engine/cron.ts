/**
 * Minimal 5-field cron parser for scheduled reports.
 *
 * Supports the subset the scheduled-report UI exposes (and raw expressions):
 *   field        allowed values
 *   minute       0–59
 *   hour         0–23
 *   day-of-month 1–31
 *   month        1–12
 *   day-of-week  0–7 (0 and 7 = Sunday)
 *
 * Each field accepts `*`, `n`, `a-b`, `a,b,c`, and stepped variants
 * (e.g. every 5 minutes, or a stepped range).
 * When both day-of-month and day-of-week are restricted, a match on either
 * triggers the schedule (standard cron behaviour); when only one is
 * restricted, that one must match.
 *
 * Dependency-free + unit-tested (__tests__/unit/cron.test.ts).
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

interface CronField {
  restricted: boolean; // true when not `*`
  values: Set<number>;
}

export interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

const RANGES: [keyof Omit<CronSchedule, "dom"> | "dom", number, number][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["dom", 1, 31],
  ["month", 1, 12],
  ["dow", 0, 7],
];

function expandField(expr: string, min: number, max: number): { restricted: boolean; values: Set<number> } {
  const out = new Set<number>();
  const parts = expr.split(",");
  if (parts.length === 1 && parts[0] === "*") {
    for (let v = min; v <= max; v++) out.add(v);
    return { restricted: false, values: out };
  }
  for (const part of parts) {
    let match: RegExpMatchArray | null;
    if ((match = /^\*\/(\d+)$/.exec(part))) {
      const step = Number(match[1]);
      if (!Number.isInteger(step) || step < 1) throw new CronError(`Invalid step “${part}”.`);
      for (let v = min; v <= max; v += step) out.add(v);
      continue;
    }
    if ((match = /^(\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part))) {
      const a = Number(match[1]);
      const bRaw = match[2];
      const step = match[3] ? Number(match[3]) : 1;
      const b = bRaw === undefined ? a : Number(bRaw);
      if (a < min || a > max || b < min || b > max || a > b || step < 1) {
        throw new CronError(`Value out of range in “${part}” (field allows ${min}–${max}).`);
      }
      for (let v = a; v <= b; v += step) out.add(v);
      continue;
    }
    throw new CronError(`Could not parse cron field “${part}”.`);
  }
  // Normalize dow 7 → 0 (both mean Sunday).
  const normalized = new Set<number>();
  for (const v of out) normalized.add(v === 7 ? 0 : v);
  if (expr.split(",").every((p) => p === "*")) {
    return { restricted: false, values: normalized };
  }
  return { restricted: true, values: normalized };
}

export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      `Cron expressions have 5 fields (minute hour day-of-month month day-of-week) — found ${fields.length}.`,
    );
  }
  const schedule = {} as CronSchedule;
  RANGES.forEach(([key, min, max], i) => {
    const field = expandField(fields[i] as string, min, max);
    if (key === "dom") schedule.dom = field;
    else if (key === "minute") schedule.minute = field;
    else if (key === "hour") schedule.hour = field;
    else if (key === "month") schedule.month = field;
    else schedule.dow = field;
  });
  return schedule;
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const domMatches = schedule.dom.values.has(date.getUTCDate());
  const dowMatches = schedule.dow.values.has(date.getUTCDay());
  const domRestricted = schedule.dom.restricted;
  const dowRestricted = schedule.dow.restricted;
  if (domRestricted && dowRestricted) return domMatches || dowMatches;
  if (domRestricted) return domMatches;
  if (dowRestricted) return dowMatches;
  return true;
}

/** First moment strictly after `from` (in UTC minutes) that matches, or null. */
export function nextRunAt(scheduleOrExpression: CronSchedule | string, from: Date = new Date()): Date | null {
  const schedule = typeof scheduleOrExpression === "string" ? parseCron(scheduleOrExpression) : scheduleOrExpression;
  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  // Search forward up to 3 years — enough for any valid expression; prevents
  // infinite loops on impossible schedules (e.g. 31 Feb-like combos).
  const deadline = cursor.getTime() + 3 * 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= deadline) {
    if (
      schedule.month.values.has(cursor.getUTCMonth() + 1) &&
      dayMatches(schedule, cursor) &&
      schedule.hour.values.has(cursor.getUTCHours()) &&
      schedule.minute.values.has(cursor.getUTCMinutes())
    ) {
      return cursor;
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

/** Human-readable next-run hint (used by the scheduled reports UI). */
export function describeCron(expression: string): string {
  try {
    const s = parseCron(expression);
    const fmt = (f: CronField) => (f.restricted ? [...f.values].slice(0, 3).join(",") : "*");
    return `${fmt(s.minute)} ${fmt(s.hour)} ${fmt(s.dom)} ${fmt(s.month)} ${fmt(s.dow)}`;
  } catch {
    return expression;
  }
}
