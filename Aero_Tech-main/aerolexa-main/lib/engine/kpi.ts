/**
 * KPI / scorecard engine.
 *
 * Computes actual versus target with Power BI indicator semantics:
 *  - goal direction (increasing is good / decreasing is good)
 *  - trend vs prior period from the real time series
 *  - status classification (on track / off track) with configurable thresholds
 * Everything is computed from provided rows — nothing is predicted.
 */
import type { SqlValue } from "@/lib/types";

export interface KpiRequest {
  columns: string[];
  rows: SqlValue[][];
  /** Measure to evaluate. */
  measureColumn: string;
  /** ISO date column used to derive the current and prior period. */
  dateColumn?: string;
  /** "month" | "quarter" | "year" — period grain for trend and targets. */
  grain?: "day" | "month" | "quarter" | "year";
  /** Fixed target value (Power BI "goal"). */
  target?: number;
  /** Target column per row (when target varies by slice/date). */
  targetColumn?: string;
  /** For increasing-is-good KPIs 100 means at/above target is success. */
  direction?: "increasing" | "decreasing";
  /** Status thresholds as ratios of target (default 0.98 / 0.9). */
  onTrackRatio?: number;
  offTrackRatio?: number;
}

export interface KpiPeriod {
  label: string;
  value: number;
  target: number | null;
  attainment: number | null; // value / target (or inverted for decreasing)
  status: "onTrack" | "needsAttention" | "offTrack" | "noTarget";
  priorValue: number | null;
  changePct: number | null;
}

export interface KpiResult {
  name: string;
  current: KpiPeriod;
  sparkline: { label: string; value: number }[];
  totalValue: number;
  totalTarget: number | null;
  totalAttainment: number | null;
  totalStatus: KpiPeriod["status"];
}

function numOf(v: SqlValue | undefined): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function periodLabel(dateIso: string, grain: NonNullable<KpiRequest["grain"]>): string {
  if (grain === "day") return dateIso.slice(0, 10);
  if (grain === "month") return dateIso.slice(0, 7);
  if (grain === "year") return dateIso.slice(0, 4);
  const q = Math.floor((Number(dateIso.slice(5, 7)) - 1) / 3) + 1;
  return `${dateIso.slice(0, 4)}-Q${q}`;
}

function statusOf(
  value: number,
  target: number | null,
  direction: "increasing" | "decreasing",
  onTrack: number,
  offTrack: number,
): KpiPeriod["status"] {
  if (target === null || target === 0) return "noTarget";
  const attainment = direction === "increasing" ? value / target : target / (value || 1);
  if (attainment >= onTrack) return "onTrack";
  if (attainment >= offTrack) return "needsAttention";
  return "offTrack";
}

export function computeKpi(req: KpiRequest): KpiResult {
  const colIdx = new Map(req.columns.map((c, i) => [c, i] as const));
  const mIdx = colIdx.get(req.measureColumn);
  if (mIdx === undefined) throw new Error(`Measure column “${req.measureColumn}” not found.`);
  const grain = req.grain ?? "month";
  const direction = req.direction ?? "increasing";
  const onTrack = req.onTrackRatio ?? 0.98;
  const offTrack = req.offTrackRatio ?? 0.9;
  const tIdx = req.targetColumn ? colIdx.get(req.targetColumn) : undefined;

  const buckets = new Map<string, { value: number; targetSum: number; targetN: number }>();
  const dateIdx = req.dateColumn ? colIdx.get(req.dateColumn) : undefined;

  if (dateIdx === undefined) {
    // Single bucket across all rows.
    let value = 0;
    let targetSum = 0;
    let targetN = 0;
    for (const r of req.rows) {
      value += numOf(r[mIdx]);
      if (tIdx !== undefined) {
        targetSum += numOf(r[tIdx]);
        targetN++;
      }
    }
    const label = "All";
    buckets.set(label, { value, targetSum, targetN });
  } else {
    for (const r of req.rows) {
      const dv = r[dateIdx];
      const iso = typeof dv === "string" ? dv.slice(0, 10) : null;
      if (!iso) continue;
      const label = periodLabel(iso, grain);
      let b = buckets.get(label);
      if (!b) {
        b = { value: 0, targetSum: 0, targetN: 0 };
        buckets.set(label, b);
      }
      b.value += numOf(r[mIdx]);
      if (tIdx !== undefined) {
        b.targetSum += numOf(r[tIdx]);
        b.targetN++;
      }
    }
  }

  const labels = [...buckets.keys()].sort();
  const periods: KpiPeriod[] = labels.map((label, i) => {
    const b = buckets.get(label)!;
    const target = req.target !== undefined ? req.target : b.targetN > 0 ? b.targetSum / b.targetN : null;
    const prior = i > 0 ? buckets.get(labels[i - 1]!)!.value : null;
    const changePct = prior !== null && prior !== 0 ? (b.value - prior) / prior : null;
    return {
      label,
      value: b.value,
      target,
      attainment: target ? (direction === "increasing" ? b.value / target : target / (b.value || 1)) : null,
      status: statusOf(b.value, target, direction, onTrack, offTrack),
      priorValue: prior,
      changePct,
    };
  });

  const current = periods[periods.length - 1] ?? {
    label: "All",
    value: 0,
    target: req.target ?? null,
    attainment: null,
    status: "noTarget" as const,
    priorValue: null,
    changePct: null,
  };

  const totalValue = [...buckets.values()].reduce((s, b) => s + b.value, 0);
  const totalTarget = req.target !== undefined ? req.target * Math.max(1, periods.length) : null;

  return {
    name: req.measureColumn,
    current,
    sparkline: periods.map((p) => ({ label: p.label, value: p.value })),
    totalValue,
    totalTarget,
    totalAttainment: totalTarget ? totalValue / totalTarget : null,
    totalStatus: statusOf(totalValue, totalTarget, direction, onTrack, offTrack),
  };
}
