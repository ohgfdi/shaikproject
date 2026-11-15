/**
 * Data alerts — pure evaluation engine.
 *
 * An alert rule watches one column of one dataset. On every evaluation the
 * engine recomputes the column's live aggregate from real dataset rows and
 * compares it against the rule's target. Three rule kinds ship:
 *
 *  - threshold  : aggregate vs a fixed value (e.g. sum(revenue) < ₹50,000)
 *  - anomaly    : today's value vs the historical baseline of the same
 *                 column (robust z-score via median/MAD — a spike to 3.5σ
 *                 above the median of the last 30 days fires, 6σ noise floor)
 *  - staleness  : dataset too old (sync/refresh older than N hours) — fires
 *                 when the source stopped updating, the classic silent
 *                 failure of ETL that nobody notices for weeks
 *
 * This module is PURE: it takes numbers in and returns a verdict out. No
 * Prisma, no fetch, no clock — the orchestrator (lib/server/alerts.ts)
 * supplies `now` and `baseline`. That keeps the oracle tests hand-computable
 * and the behaviour identical in dev, CI and production.
 */

import type { ColType } from "@/lib/types";

export type AlertRuleKind = "threshold" | "anomaly" | "staleness";
export type AlertAggregate = "sum" | "avg" | "min" | "max" | "count";
export type AlertOperator = "lt" | "lte" | "gt" | "gte";
export type AlertSeverity = "info" | "warning" | "critical";
export type AlertEvalOutcome = "fired" | "resolved" | "none";

/** Numeric cell coercion mirroring lib/engine/dataset.ts `cellNumber`. */
export function alertCellNumber(cell: unknown): number {
  if (cell === null || cell === undefined || cell === "") return Number.NaN;
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : Number.NaN;
  if (typeof cell === "boolean") return cell ? 1 : 0;
  const n = Number(String(cell).replace(/[,$\s%€£]/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

/** One aggregate over an already-extracted numeric column vector. */
export function alertAggregate(values: number[], agg: AlertAggregate): { value: number; count: number } {
  const finite = values.filter((v) => Number.isFinite(v));
  if (agg === "count") return { value: finite.length, count: finite.length };
  if (finite.length === 0) return { value: Number.NaN, count: 0 };
  switch (agg) {
    case "sum":
      return { value: finite.reduce((s, v) => s + v, 0), count: finite.length };
    case "avg":
      return { value: finite.reduce((s, v) => s + v, 0) / finite.length, count: finite.length };
    case "min":
      return { value: Math.min(...finite), count: finite.length };
    case "max":
      return { value: Math.max(...finite), count: finite.length };
  }
}

/**
 * Robust z-score using median and MAD (median absolute deviation).
 * Returns the modified z-score of `value` against the baseline sample, or
 * null when the baseline cannot support a decision (too few points or
 * zero dispersion — a constant baseline carries no anomaly information).
 */
export function robustZScore(value: number, baseline: number[]): number | null {
  const sample = baseline.filter((v) => Number.isFinite(v));
  if (sample.length < 4 || !Number.isFinite(value)) return null;
  const sorted = [...sample].sort((a, b) => a - b);
  const median = sampleMedian(sorted);
  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = sampleMedian(deviations);
  if (mad === 0) {
    // Zero MAD: the baseline is constant. Any non-trivial move is signal,
    // not noise — treat ≥5% relative deviation as an anomaly.
    if (median === 0) return null;
    return Math.abs(value - median) / (Math.abs(median) * 0.05) >= 1 ? 3.6 : 0;
  }
  // 0.6745 = 75th percentile of the standard normal; the standard MAD→σ scale.
  return (0.6745 * (value - median)) / mad;
}

function sampleMedian(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? (sorted[mid] ?? Number.NaN)
    : ((sorted[mid - 1] ?? Number.NaN) + (sorted[mid] ?? Number.NaN)) / 2;
}

/** Direction-agnostic anomaly test: fires on |z| ≥ 3.5 (≡ ~2-in-10,000 two-sided). */
export function isAnomaly(value: number, baseline: number[]): boolean {
  const z = robustZScore(value, baseline);
  return z !== null && Math.abs(z) >= 3.5;
}

/* ------------------------------------------------------------------ */
/* Rule config                                                         */
/* ------------------------------------------------------------------ */

export const thresholdConfigSchema = {
  operator: ["lt", "lte", "gt", "gte"] as const,
  aggregates: ["sum", "avg", "min", "max", "count"] as const,
};

/** Discriminated rule config — validated shape for each rule kind. */
export type AlertRuleConfig =
  | { kind: "threshold"; aggregate: AlertAggregate; operator: AlertOperator; value: number }
  | { kind: "anomaly"; aggregate: AlertAggregate; windowPoints: number }
  | { kind: "staleness"; maxAgeHours: number };

/** Runtime guard for the JSON stored in the DB (validated on API entry). */
export function isAlertRuleConfig(raw: unknown): raw is AlertRuleConfig {
  if (raw === null || typeof raw !== "object") return false;
  const c = raw as Record<string, unknown>;
  if (c.kind === "threshold") {
    return (
      thresholdConfigSchema.aggregates.includes(c.aggregate as AlertAggregate) &&
      thresholdConfigSchema.operator.includes(c.operator as AlertOperator) &&
      typeof c.value === "number" &&
      Number.isFinite(c.value)
    );
  }
  if (c.kind === "anomaly") {
    return (
      thresholdConfigSchema.aggregates.includes(c.aggregate as AlertAggregate) &&
      typeof c.windowPoints === "number" &&
      Number.isInteger(c.windowPoints) &&
      (c.windowPoints as number) >= 4 &&
      (c.windowPoints as number) <= 90
    );
  }
  if (c.kind === "staleness") {
    return typeof c.maxAgeHours === "number" && Number.isFinite(c.maxAgeHours) && c.maxAgeHours > 0;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

export interface AlertEvalInput {
  rule: AlertRuleConfig;
  /** Evaluated column values from the dataset's live rows ([] = no rows). */
  columnValues: unknown[];
  /** Column's declared type — staleness ignores it, others need numeric. */
  columnType: ColType;
  /** Dataset freshness for staleness rules (epoch ms). */
  datasetUpdatedAtMs: number | null;
  /** Baseline of the SAME aggregate computed over prior windows. */
  baseline: number[];
  /** Epoch ms — supplied by the caller for pure-testability. */
  nowMs: number;
}

export interface AlertVerdict {
  outcome: AlertEvalOutcome;
  severity: AlertSeverity;
  /** Human-readable evidence: always shows the real numbers, never hides them. */
  message: string;
  /** The computed aggregate value (null for staleness/missing data). */
  value: number | null;
  /** Details for the audit trail / UI evidence line. */
  evidence: Record<string, unknown>;
}

const HOUR_MS = 3_600_000;

/**
 * Evaluate a rule against live data. `outcome` is one of:
 *  - "fired":    the condition is TRUE (needs action)
 *  - "resolved": the condition is FALSE but was previously firing
 *  - "none":     condition false and nothing previously firing
 */
export function evaluateAlert(input: AlertEvalInput): AlertVerdict {
  const { rule, nowMs } = input;

  if (rule.kind === "staleness") {
    const ageHours = input.datasetUpdatedAtMs === null ? null : (nowMs - input.datasetUpdatedAtMs) / HOUR_MS;
    const stale = ageHours === null || ageHours > rule.maxAgeHours;
    return {
      outcome: stale ? "fired" : "none",
      severity: stale ? "warning" : "info",
      message: stale
        ? ageHours === null
          ? "The dataset has never been refreshed — staleness alert armed but no timestamp exists."
          : `Dataset last refreshed ${ageHours.toFixed(1)}h ago (limit ${rule.maxAgeHours}h). The source may have stopped updating.`
        : `Dataset refreshed ${ageHours === null ? "never" : `${ageHours.toFixed(1)}h ago`} — within the ${rule.maxAgeHours}h limit.`,
      value: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      evidence: { kind: "staleness", ageHours, maxAgeHours: rule.maxAgeHours },
    };
  }

  const values = input.columnValues.map(alertCellNumber);
  const { value, count } = alertAggregate(values, rule.aggregate);

  if (rule.kind === "threshold") {
    const comparison = Number.isFinite(value) ? compareOp(rule.operator, value, rule.value) : false;
    const missing = values.length - count;
    return {
      outcome: comparison ? "fired" : "none",
      severity: comparison ? severityFor(rule.operator, rule.value, value) : "info",
      message: comparison
        ? `${rule.aggregate}(${pluralCells(count)}) = ${fmt(value)} — ${opPhrase(rule.operator)} ${fmt(rule.value)}`
        : `${rule.aggregate} = ${Number.isFinite(value) ? fmt(value) : "no numeric data"} — within threshold`,
      value: Number.isFinite(value) ? value : null,
      evidence: {
        kind: "threshold",
        aggregate: rule.aggregate,
        operator: rule.operator,
        threshold: rule.value,
        rows: values.length,
        nonNumeric: missing,
        value: Number.isFinite(value) ? value : null,
      },
    };
  }

  // anomaly
  const z = robustZScore(value, input.baseline);
  const fired = z !== null && Math.abs(z) >= 3.5;
  const baselineMedian = medianOf(input.baseline);
  const zAbs = z === null ? 0 : Math.abs(z);
  return {
    outcome: fired ? "fired" : "none",
    severity: fired && zAbs >= 6 ? "critical" : fired ? "warning" : "info",
    message: fired
      ? `${rule.aggregate} = ${fmt(value)} deviates ${Math.abs(z ?? 0).toFixed(1)}σ from the recent baseline (median ${fmt(baselineMedian)})`
      : `${rule.aggregate} = ${fmt(value)} — within the recent baseline (|z| = ${z === null ? "n/a" : Math.abs(z).toFixed(1)})`,
    value: Number.isFinite(value) ? value : null,
    evidence: {
      kind: "anomaly",
      aggregate: rule.aggregate,
      z: z === null ? null : Math.round(z * 100) / 100,
      baselineMedian,
      baselinePoints: input.baseline.length,
      value: Number.isFinite(value) ? value : null,
    },
  };
}

function compareOp(op: AlertOperator, a: number, b: number): boolean {
  switch (op) {
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
  }
}

function opPhrase(op: AlertOperator): string {
  switch (op) {
    case "lt":
      return "below";
    case "lte":
      return "at or below";
    case "gt":
      return "above";
    case "gte":
      return "at or above";
  }
}

function severityFor(op: AlertOperator, threshold: number, value: number): AlertSeverity {
  // Beyond 2× the threshold distance → critical; otherwise warning.
  const distance = Math.abs(value - threshold);
  const reference = Math.max(Math.abs(threshold), 1e-9);
  if (distance >= reference) return "critical";
  return "warning";
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sampleMedian(sorted);
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n);
}

function pluralCells(n: number): string {
  return `${new Intl.NumberFormat("en-IN").format(n)} value${n === 1 ? "" : "s"}`;
}
