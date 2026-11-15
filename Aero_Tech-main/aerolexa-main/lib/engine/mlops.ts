/**
 * MLOps engine — model registry semantics, evaluation gates, champion/
 * challenger promotion and production drift monitoring.
 *
 * Pure layer over the `ModelVersion` Prisma model: the API route owns
 * persistence; this module owns the DECISIONS:
 *
 *  - `evaluateGate`   — does a candidate beat the incumbent under the chosen
 *                       primary metric with the required margin? Gate rules
 *                       (minImprovement, maxAllowedDegradation per guardrail
 *                       metric) are explicit, so promotion is never vibes.
 *  - `compareModels`  — champion/challenger comparison with per-metric verdicts
 *                       and an overall promote / hold / reject verdict.
 *  - `detectDrift`    — PSI (population stability index) per feature and
 *                       KS-style max CDF gap for numeric drift; WoE-style PSI
 *                       for categoricals. PSI ≥ 0.25 = major shift (industry
 *                       convention), 0.1–0.25 = moderate — surfaced as
 *                       machine-readable severity, not a silent pass.
 *
 * Deterministic, dependency-free, oracle-testable.
 */

export class MlopsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MlopsError";
  }
}

// ---------------------------------------------------------------------------
// Model registry records (mirrors ModelVersion rows, JSON columns decoded)
// ---------------------------------------------------------------------------

export type ModelStatus = "TRAINING" | "READY" | "ERROR" | "CANDIDATE" | "CHAMPION" | "RETIRED";
export type ModelTask2 = "classification" | "regression" | "clustering" | "binary-classification";

export interface RegistryModel {
  id: string;
  name: string;
  /** Unique within (name, version) — the registry line. */
  version: number;
  task: ModelTask2;
  algorithm: string;
  status: ModelStatus;
  targetColumn: string | null;
  featureNames: string[];
  /** Decoded metrics JSON, e.g. { rocAuc: 0.81, rmse: 3.2 } or CV summary. */
  metrics: Record<string, number>;
  /** Serialized artifact (aerolexa.ml.v1 JSON) or legacy trainer card. */
  artifactJson: string | null;
  createdById: string;
  createdAt: string;
  /** Promotion metadata. */
  promotedAt: string | null;
  promotedBy: string | null;
  /** Human note — why promoted/retired (audit trail). */
  note: string | null;
}

/** Which metric decides the gate, per task. */
export const PRIMARY_METRIC: Record<ModelTask2, string> = {
  "binary-classification": "rocAuc",
  classification: "rocAuc",
  regression: "rmse",
  clustering: "silhouette",
};

/** Metrics where LOWER is better. */
const LOWER_IS_BETTER = new Set(["rmse", "mae", "logloss", "brier"]);

export function isLowerBetter(metric: string): boolean {
  return LOWER_IS_BETTER.has(metric);
}

// ---------------------------------------------------------------------------
// 1. Evaluation gates + champion/challenger
// ---------------------------------------------------------------------------

export interface GatePolicy {
  /** Metric the gate compares (defaults to the task's primary). */
  metric?: string;
  /** Challenger must beat champion by at least this much (absolute). Default 0. */
  minImprovement: number;
  /** Guardrail metrics that must not degrade more than `tolerance` each. */
  guardrails?: { metric: string; tolerance: number }[];
  /** Reject the candidate outright when its primary metric is worse by more than this. */
  maxRegression?: number;
}

export type GateVerdict = "promote" | "hold" | "reject";

export interface GateResult {
  verdict: GateVerdict;
  metric: string;
  challengerValue: number;
  championValue: number | null;
  /** challenger − champion (positive = better only when higher-is-better). */
  delta: number;
  better: boolean;
  guardrailResults: { metric: string; challenger: number; champion: number; degradedBy: number; passed: boolean }[];
  reasons: string[];
}

/** Resolve the comparison metric with per-task defaults. */
function resolveMetric(task: ModelTask2, requested?: string): string {
  return requested ?? PRIMARY_METRIC[task] ?? "rocAuc";
}

/**
 * Champion/challenger gate. Semantics:
 *  - no champion → promote (the first model is always registered).
 *  - challenger improves by ≥ minImprovement AND every guardrail passes → promote.
 *  - challenger is worse than champion − maxRegression (or a guardrail fails
 *    beyond 2× tolerance) → reject.
 *  - anything else → hold (keep serving the champion).
 */
export function evaluateGate(
  champion: RegistryModel | null,
  challenger: RegistryModel,
  policy: GatePolicy,
): GateResult {
  const metric = resolveMetric(challenger.task, policy.metric);
  const challengerValue = challenger.metrics[metric];
  if (!Number.isFinite(challengerValue)) {
    throw new MlopsError(`Challenger has no finite “${metric}” metric — train it fully before gating.`);
  }
  const challengerValueN = challengerValue as number;
  if (!champion) {
    return {
      verdict: "promote",
      metric,
      challengerValue: challengerValueN,
      championValue: null,
      delta: 0,
      better: true,
      guardrailResults: [],
      reasons: ["No incumbent champion — first model for this line is promoted automatically."],
    };
  }
  if (champion.task !== challenger.task) {
    throw new MlopsError("Champion and challenger must have the same task to be compared.");
  }
  const championValue = champion.metrics[metric];
  if (!Number.isFinite(championValue)) {
    throw new MlopsError(`Champion has no finite “${metric}” — re-evaluate or retire it.`);
  }
  const championValueN = championValue as number;
  const lower = isLowerBetter(metric);
  const delta = lower ? championValueN - challengerValueN : challengerValueN - championValueN;
  const reasons: string[] = [];
  const guardrailResults: GateResult["guardrailResults"] = [];
  let guardrailsOk = true;
  let guardrailHardFail = false;
  for (const g of policy.guardrails ?? []) {
    const cv2 = champion.metrics[g.metric];
    const dv = challenger.metrics[g.metric];
    if (!Number.isFinite(cv2) || !Number.isFinite(dv)) {
      throw new MlopsError(`Guardrail metric “${g.metric}” missing from a model.`);
    }
    const cvN = cv2 as number;
    const dvN = dv as number;
    const degradedBy = isLowerBetter(g.metric) ? dvN - cvN : cvN - dvN;
    const passed = degradedBy <= g.tolerance;
    if (!passed) guardrailsOk = false;
    if (degradedBy > 2 * g.tolerance) guardrailHardFail = true;
    guardrailResults.push({ metric: g.metric, challenger: dvN, champion: cvN, degradedBy, passed });
    reasons.push(
      `Guardrail ${g.metric}: ${dvN} vs champion ${cvN} (${degradedBy >= 0 ? "+" : ""}${degradedBy}) — ${passed ? "within" : "OUTSIDE"} tolerance ${g.tolerance}.`,
    );
  }
  const better = delta >= policy.minImprovement;
  if (policy.maxRegression !== undefined) {
    const regression = -delta;
    if (regression > policy.maxRegression) {
      return {
        verdict: "reject",
        metric,
        challengerValue: challengerValueN,
        championValue: championValueN,
        delta,
        better: false,
        guardrailResults,
        reasons: [
          ...reasons,
          `Challenger is worse by ${regression} on ${metric} — beyond maxRegression ${policy.maxRegression}.`,
        ],
      };
    }
  }
  if (guardrailHardFail) {
    reasons.push("At least one guardrail degraded beyond 2× tolerance — automatic reject.");
    return {
      verdict: "reject",
      metric,
      challengerValue: challengerValueN,
      championValue: championValueN,
      delta,
      better,
      guardrailResults,
      reasons,
    };
  }
  if (better && guardrailsOk) {
    reasons.push(
      `Challenger improves ${metric} by ${delta} (≥ required ${policy.minImprovement}) and all guardrails pass.`,
    );
    return {
      verdict: "promote",
      metric,
      challengerValue: challengerValueN,
      championValue: championValueN,
      delta,
      better: true,
      guardrailResults,
      reasons,
    };
  }
  reasons.push(
    better
      ? `Challenger improves ${metric} but guardrails degraded — holding.`
      : `Challenger does not improve ${metric} by the required ${policy.minImprovement} — holding.`,
  );
  return {
    verdict: "hold",
    metric,
    challengerValue: challengerValueN,
    championValue: championValueN,
    delta,
    better,
    guardrailResults,
    reasons,
  };
}

export interface ChallengerComparison {
  champion: { id: string; version: number; metrics: Record<string, number> };
  challenger: { id: string; version: number; metrics: Record<string, number> };
  /** Per shared-metric deltas (challenger − champion, sign-normalized to "positive = better"). */
  metrics: { name: string; champion: number; challenger: number; delta: number; better: boolean }[];
  verdict: "promote" | "hold" | "reject";
  gate: GateResult;
}

/** Full comparison row for the challenger UI: every shared metric + gate verdict. */
export function compareModels(
  champion: RegistryModel,
  challenger: RegistryModel,
  policy: GatePolicy,
): ChallengerComparison {
  const shared = [...new Set([...Object.keys(champion.metrics), ...Object.keys(challenger.metrics)])].filter(
    (m) => Number.isFinite(champion.metrics[m]) && Number.isFinite(challenger.metrics[m]),
  );
  const metrics = shared.map((m) => {
    const c = champion.metrics[m] as number;
    const d = challenger.metrics[m] as number;
    const delta = isLowerBetter(m) ? c - d : d - c;
    return { name: m, champion: c, challenger: d, delta, better: delta > 0 };
  });
  const gate = evaluateGate(champion, challenger, policy);
  return {
    champion: { id: champion.id, version: champion.version, metrics: champion.metrics },
    challenger: { id: challenger.id, version: challenger.version, metrics: challenger.metrics },
    metrics,
    verdict: gate.verdict,
    gate,
  };
}

// ---------------------------------------------------------------------------
// 2. Drift monitoring
// ---------------------------------------------------------------------------

export interface DriftColumnResult {
  column: string;
  kind: "numeric" | "categorical";
  /** Population stability index (binned for numeric, per-level for categorical). */
  psi: number;
  /** For numeric: Kolmogorov–Smirnov max CDF gap (0–1). Null for categorical. */
  ksStatistic: number | null;
  severity: "ok" | "moderate" | "major";
  /** Bins/levels contributing the largest PSI share (top contributors). */
  topBin: string | null;
  n: number;
}

export interface DriftReport {
  columns: DriftColumnResult[];
  overall: "ok" | "moderate" | "major";
  /** The PSI thresholds used — printed so the report is self-describing. */
  thresholds: { moderate: number; major: number };
  nReference: number;
  nCurrent: number;
  interpretation: string;
}

/** PSI severity bands (industry convention: <0.1 stable, 0.1–0.25 moderate, ≥0.25 major). */
export const PSI_THRESHOLDS = { moderate: 0.1, major: 0.25 } as const;

function severityFor(psi: number): DriftColumnResult["severity"] {
  if (psi >= PSI_THRESHOLDS.major) return "major";
  if (psi >= PSI_THRESHOLDS.moderate) return "moderate";
  return "ok";
}

/**
 * Drift between the model's reference (training) distribution and current
 * traffic, per column:
 *  - numeric: decile bins fitted on the REFERENCE data (equal-frequency, the
 *    standard PSI setup; empty-bin epsilon 1e-6) + exact KS statistic.
 *  - categorical: per-level shares with an "ε-other" bucket for unseen levels.
 */
export function detectDrift(
  reference: Record<string, (string | number | boolean | null)[]>,
  current: Record<string, (string | number | boolean | null)[]>,
  columnTypes: Record<string, "numeric" | "categorical">,
): DriftReport {
  const columnsShared = Object.keys(columnTypes).filter((c) => reference[c]?.length && current[c]?.length);
  if (!columnsShared.length) throw new MlopsError("No columns with data in both reference and current windows.");
  // The ≥ 20-row floor applies PER COLUMN (columns with less are skipped, not
  // fatal — a missing sparse column must not block the whole report).
  const nRef = Math.max(...columnsShared.map((c) => reference[c]!.length));
  const nCur = Math.max(...columnsShared.map((c) => current[c]!.length));
  if (nRef < 20 || nCur < 20) throw new MlopsError("Drift needs at least 20 rows in each window.");
  const EPS = 1e-6;

  const columns: DriftColumnResult[] = [];
  for (const col of columnsShared) {
    const kind = columnTypes[col]!;
    if (kind === "numeric") {
      const ref = reference[col]!.map(Number).filter(Number.isFinite);
      const cur = current[col]!.map(Number).filter(Number.isFinite);
      if (ref.length < 20 || cur.length < 20) continue;
      // Equal-frequency reference deciles, de-duplicated (constant columns).
      const sortedRef = [...ref].sort((a, b) => a - b);
      const bins = 10;
      const edges: number[] = [];
      for (let b = 0; b <= bins; b++) {
        const pos = Math.min(sortedRef.length - 1, Math.floor((b / bins) * sortedRef.length));
        edges.push(sortedRef[pos] as number);
      }
      const uniqEdges = [...new Set(edges)];
      const binOf = (v: number): number => {
        let b = 0;
        while (b < uniqEdges.length - 1 && v > (uniqEdges[b + 1] as number)) b++;
        return b;
      };
      const nBins = uniqEdges.length;
      const refCounts = new Array<number>(nBins).fill(0);
      const curCounts = new Array<number>(nBins).fill(0);
      for (const v of ref) refCounts[binOf(v)]!++;
      for (const v of cur) curCounts[binOf(v)]!++;
      let psi = 0;
      let topBin: string | null = null;
      let topShare = 0;
      for (let b = 0; b < nBins; b++) {
        const pr = Math.max(EPS, refCounts[b]! / ref.length);
        const pc = Math.max(EPS, curCounts[b]! / cur.length);
        const contrib = (pc - pr) * Math.log(pc / pr);
        psi += contrib;
        if (contrib > topShare) {
          topShare = contrib;
          const lo = b === 0 ? "−∞" : String(uniqEdges[b] ?? "");
          topBin = `(${lo}, ${uniqEdges[b + 1] ?? "+∞"}]`;
        }
      }
      // Exact KS statistic: sup |F_ref − F_cur| evaluated at every distinct
      // value with BOTH CDFs fully advanced through tie blocks (a merged walk
      // that advances one array at a time mis-reads ties: identical samples
      // scored 0.1). O(n log n) via sorted arrays + pointer advancement.
      const a = [...ref].sort((x, y) => x - y);
      const b2 = [...cur].sort((x, y) => x - y);
      const values = [...new Set([...a, ...b2])].sort((x, y) => x - y);
      let ks = 0;
      let ia = 0;
      let ib = 0;
      for (const v of values) {
        while (ia < a.length && (a[ia] as number) <= v) ia++;
        while (ib < b2.length && (b2[ib] as number) <= v) ib++;
        ks = Math.max(ks, Math.abs(ia / a.length - ib / b2.length));
      }
      columns.push({ column: col, kind, psi, ksStatistic: ks, severity: severityFor(psi), topBin, n: cur.length });
    } else {
      const ref = reference[col]!.filter((v) => v !== null && v !== "").map(String);
      const cur = current[col]!.filter((v) => v !== null && v !== "").map(String);
      if (ref.length < 20 || cur.length < 20) continue;
      const refShare = new Map<string, number>();
      for (const v of ref) refShare.set(v, (refShare.get(v) ?? 0) + 1);
      const curShare = new Map<string, number>();
      for (const v of cur) curShare.set(v, (curShare.get(v) ?? 0) + 1);
      const levels = new Set([...refShare.keys(), ...curShare.keys()]);
      let psi = 0;
      let topBin: string | null = null;
      let topShare = 0;
      for (const lv of levels) {
        const pr = Math.max(EPS, (refShare.get(lv) ?? 0) / ref.length);
        const pc = Math.max(EPS, (curShare.get(lv) ?? 0) / cur.length);
        const contrib = (pc - pr) * Math.log(pc / pr);
        psi += contrib;
        if (contrib > topShare) {
          topShare = contrib;
          topBin = lv;
        }
      }
      columns.push({ column: col, kind, psi, ksStatistic: null, severity: severityFor(psi), topBin, n: cur.length });
    }
  }
  if (!columns.length) throw new MlopsError("No column had enough usable rows (≥ 20) in both windows.");
  const overall = columns.some((c) => c.severity === "major")
    ? "major"
    : columns.some((c) => c.severity === "moderate")
      ? "moderate"
      : "ok";
  const drifted = columns.filter((c) => c.severity !== "ok").map((c) => c.column);
  return {
    columns: columns.map((c) => ({
      ...c,
      psi: round6(c.psi),
      ksStatistic: c.ksStatistic === null ? null : round6(c.ksStatistic),
    })),
    overall,
    thresholds: { ...PSI_THRESHOLDS },
    nReference: nRef,
    nCurrent: nCur,
    interpretation:
      overall === "ok"
        ? `No material drift: every monitored column's PSI < ${PSI_THRESHOLDS.moderate}.`
        : `Drift detected in ${drifted.length} column(s): ${drifted.join(", ")}. The model was trained on a distribution that no longer matches current data — retrain on recent rows before trusting its predictions.`,
  };
}

function round6(v: number): number {
  if (!Number.isFinite(v)) return v;
  return Math.round(v * 1e6) / 1e6;
}
