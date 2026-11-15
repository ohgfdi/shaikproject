/**
 * Survival analysis: time-to-event data with right censoring.
 *
 * Three layers, each oracle-tested in __tests__/unit/survival-oracle.test.ts
 * against scipy/lifelines shapes:
 *
 *   1. Kaplan–Meier product-limit estimator with Greenwood variance — reuses
 *      the tested engine in lib/engine/elite-stats.ts.
 *   2. Log-rank test (two groups) — also reused from elite-stats.
 *   3. Cox proportional hazards regression: Breslow ties, Newton–Raphson on
 *      the exact partial likelihood, Wald/LR inference, concordance index and
 *      a Grambsch–Therneau-style PH check (scaled Schoenfeld residuals vs
 *      time). Implemented here because elite-stats has no Cox; the partial
 *      likelihood, score and information are standard textbook formulas
 *      (Klein & Moeschberger), not approximations.
 *
 * PH diagnostics are reported honestly: a non-significant Schoenfeld-time
 * association does NOT prove proportional hazards — it only fails to refute
 * it. The result carries that caveat.
 */

import {
  kaplanMeier,
  logRankTest,
  StatsError,
  type KaplanMeierCurve,
  type SurvivalObservation,
} from "@/lib/engine/elite-stats";
import { normalCdf, studentTPValue, studentTCriticalTwoSided } from "@/lib/engine/stats";

export class SurvivalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurvivalError";
  }
}

export interface CoxInput {
  time: number[];
  event: (0 | 1)[];
  X: number[][];
  names?: string[];
  maxIter?: number;
  tol?: number;
}

export interface CoxTerm {
  name: string;
  coefficient: number;
  hazardRatio: number;
  stdError: number;
  z: number;
  pValue: number;
  ci95: { low: number; high: number };
}

export interface CoxResult {
  coefficients: CoxTerm[];
  logPartialLikelihood: number;
  nullLogPartialLikelihood: number;
  likelihoodRatio: number;
  lrPValue: number;
  concordance: number;
  n: number;
  events: number;
  iterations: number;
  converged: boolean;
  /** Per-covariate Grambsch–Therneau-style PH check (scaled Schoenfeld). */
  phCheck: {
    name: string;
    correlation: number;
    pValue: number;
    passed: boolean;
  }[];
  phVerdict: string;
  interpretation: string;
  warnings: string[];
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Newton–Raphson for the Cox partial likelihood with Breslow ties. */
export function coxProportionalHazards(input: CoxInput): CoxResult {
  const { time, event, X } = input;
  const n = time.length;
  const p = X[0]?.length ?? 0;
  if (n < 5) throw new SurvivalError(`Cox regression needs at least 5 observations; got ${n}.`);
  if (p === 0) throw new SurvivalError("Cox regression needs at least one covariate.");
  if (X.length !== n || event.length !== n || time.length !== n) {
    throw new SurvivalError("time, event and X must all have the same length.");
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(time[i] as number) || (time[i] as number) <= 0) {
      throw new SurvivalError(`Time at row ${i} must be finite and positive.`);
    }
    if (event[i] !== 0 && event[i] !== 1) throw new SurvivalError(`Event flag at row ${i} must be 0 or 1.`);
  }
  const names = input.names ?? X[0]!.map((_, j) => `x${j + 1}`);
  const warnings: string[] = [];
  const totalEvents = event.reduce<number>((a, b) => a + b, 0);
  if (totalEvents < 5) {
    throw new SurvivalError(`Cox regression needs at least 5 observed events (uncensored rows); got ${totalEvents}.`);
  }
  if (totalEvents < p * 3) {
    warnings.push(
      `Only ${totalEvents} events for ${p} covariate(s) — coefficients are unstable (roughly < 10 events per parameter is the working rule).`,
    );
  }

  // Distinct failure times in ascending order; Breslow: ties share a risk set
  // and split the likelihood contribution.
  const failureTimes: number[] = [];
  for (let i = 0; i < n; i++) if (event[i] === 1) failureTimes.push(time[i] as number);
  failureTimes.sort((a, b) => a - b);

  const expScore = (beta: number[]): number[] =>
    X.map((row) => {
      let s = 0;
      for (let j = 0; j < p; j++) s += (row[j] as number) * (beta[j] as number);
      return Math.exp(s);
    });

  const logLik = (beta: number[]): number => {
    const e = expScore(beta);
    let ll = 0;
    for (const t of failureTimes) {
      let num = 0;
      let den = 0;
      let d = 0;
      for (let i = 0; i < n; i++) {
        if ((time[i] as number) < t) continue;
        if (event[i] === 1 && time[i] === t) d++;
        if ((time[i] as number) >= t) den += e[i] as number;
      }
      for (let i = 0; i < n; i++) {
        if (event[i] === 1 && time[i] === t) {
          let s = 0;
          for (let j = 0; j < p; j++) s += (X[i]![j] as number) * (beta[j] as number);
          num += s;
        }
      }
      if (den <= 0) continue;
      ll += num - d * Math.log(den);
    }
    return ll;
  };

  const scoreAndInfo = (beta: number[]): { U: number[]; I: number[][] } => {
    const e = expScore(beta);
    const U = new Array<number>(p).fill(0);
    const I = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    for (const t of failureTimes) {
      let d = 0;
      const s1 = new Array<number>(p).fill(0);
      const s2 = Array.from({ length: p }, () => new Array<number>(p).fill(0));
      let w1 = 0;
      for (let i = 0; i < n; i++) {
        if ((time[i] as number) < t) continue;
        const w = e[i] as number;
        w1 += w;
        if (event[i] === 1 && time[i] === t) {
          d++;
          for (let j = 0; j < p; j++) U[j] = U[j]! + (X[i]![j] as number);
        }
        for (let j = 0; j < p; j++) {
          s1[j] = s1[j]! + w * (X[i]![j] as number);
          for (let k = 0; k < p; k++) s2[j]![k] = s2[j]![k]! + w * (X[i]![j] as number) * (X[i]![k] as number);
        }
      }
      if (w1 <= 0 || d === 0) continue;
      for (let j = 0; j < p; j++) U[j] = U[j]! - (d * (s1[j] as number)) / w1;
      for (let j = 0; j < p; j++) {
        for (let k = 0; k < p; k++) {
          I[j]![k] = I[j]![k]! + (d * (s2[j]![k]! - (s1[j]! * s1[k]!) / w1)) / w1;
        }
      }
    }
    return { U, I };
  };

  const invert = (M: number[][]): number[][] | null => {
    const dim = M.length;
    const A = M.map((r, i) => [...r, ...Array.from({ length: dim }, (_, j) => (i === j ? 1 : 0))]);
    for (let col = 0; col < dim; col++) {
      let pivot = col;
      for (let r = col + 1; r < dim; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[pivot]![col]!)) pivot = r;
      if (Math.abs(A[pivot]![col]!) < 1e-14) return null;
      [A[col], A[pivot]] = [A[pivot] as number[], A[col] as number[]];
      const div = A[col]![col]!;
      for (let j = 0; j < 2 * dim; j++) A[col]![j] = A[col]![j]! / div;
      for (let r = 0; r < dim; r++) {
        if (r === col) continue;
        const f = A[r]![col]!;
        if (f === 0) continue;
        for (let j = 0; j < 2 * dim; j++) A[r]![j] = A[r]![j]! - f * A[col]![j]!;
      }
    }
    return A.map((r) => r.slice(dim));
  };

  const beta = new Array<number>(p).fill(0);
  let converged = false;
  let iterations = 0;
  const maxIter = input.maxIter ?? 25;
  const tol = input.tol ?? 1e-7;
  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    const { U, I } = scoreAndInfo(beta);
    const inv = invert(I);
    if (!inv) {
      warnings.push(
        "The observed information matrix is singular — coefficients may be unidentified (collinear covariates).",
      );
      break;
    }
    const step = inv.map((row) => row.reduce((acc, v, j) => acc + v * (U[j] as number), 0));
    let maxAbs = 0;
    for (let j = 0; j < p; j++) {
      beta[j] = beta[j]! + (step[j] as number);
      maxAbs = Math.max(maxAbs, Math.abs(step[j] as number));
    }
    if (maxAbs < tol) {
      converged = true;
      break;
    }
  }

  const { I } = scoreAndInfo(beta);
  const invI = invert(I);
  if (!invI) throw new SurvivalError("The information matrix could not be inverted — check for collinear covariates.");

  const ll = logLik(beta);
  const llNull = logLik(new Array<number>(p).fill(0));
  const lr = 2 * (ll - llNull);
  const lrPValue = Number.isFinite(lr) && lr > 0 ? Number(Math.exp(-lr / 2)) : 1;

  const coefficients: CoxTerm[] = beta.map((b, j) => {
    const se = Math.sqrt(Math.max(0, invI[j]![j] as number));
    const z = se > 0 ? b / se : Number.NaN;
    const pValue = Number.isFinite(z) ? Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))) : 1;
    return {
      name: names[j] ?? `x${j + 1}`,
      coefficient: round(b),
      hazardRatio: round(Math.exp(b)),
      stdError: round(se),
      z: round(z),
      pValue,
      ci95: { low: round(Math.exp(b - 1.96 * se)), high: round(Math.exp(b + 1.96 * se)) },
    };
  });

  // Concordance: among comparable pairs (the earlier one failed), does the
  // model's linear predictor order them the same way? Ties in the predictor
  // count 0.5.
  const eta = X.map((row) => row.reduce((acc, v, j) => acc + (v as number) * (beta[j] as number), 0));
  let concordant = 0;
  let comparable = 0;
  for (let i = 0; i < n; i++) {
    if (event[i] !== 1) continue;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if ((time[j] as number) < (time[i] as number)) continue;
      if (time[j] === time[i] && event[j] === 1 && j < i) continue;
      comparable++;
      if ((eta[j] as number) < (eta[i] as number)) concordant++;
      else if (eta[j] === eta[i]) concordant += 0.5;
    }
  }
  const concordance = comparable > 0 ? concordant / comparable : Number.NaN;

  // PH check: for each covariate, Spearman-like association between scaled
  // Schoenfeld residuals and event time (Grambsch–Therneau in spirit; here
  // the scaled residual is x_ij − mean(x at risk weighted by exp score) and
  // the association is Pearson on the event-time ordering). Reported with
  // the honest caveat that a non-significant p does NOT confirm PH.
  const phCheck: CoxResult["phCheck"] = beta.map((_, j) => {
    const residuals: { t: number; r: number }[] = [];
    for (const t of failureTimes) {
      let w1 = 0;
      let meanX = 0;
      for (let i = 0; i < n; i++) {
        if ((time[i] as number) < t) continue;
        const w = Math.exp(X[i]!.reduce((acc, v, k) => acc + (v as number) * (beta[k] as number), 0));
        w1 += w;
        meanX += w * (X[i]![j] as number);
      }
      if (w1 <= 0) continue;
      meanX /= w1;
      for (let i = 0; i < n; i++) {
        if (event[i] === 1 && time[i] === t) residuals.push({ t, r: (X[i]![j] as number) - meanX });
      }
    }
    if (residuals.length < 5) {
      return { name: names[j] ?? `x${j + 1}`, correlation: Number.NaN, pValue: Number.NaN, passed: true };
    }
    const ts = residuals.map((r) => r.t);
    const rs = residuals.map((r) => r.r);
    const mt = ts.reduce((a, b) => a + b, 0) / ts.length;
    const mr = rs.reduce((a, b) => a + b, 0) / rs.length;
    let num = 0;
    let dt = 0;
    let dr = 0;
    for (let i = 0; i < ts.length; i++) {
      num += (ts[i]! - mt) * (rs[i]! - mr);
      dt += (ts[i]! - mt) ** 2;
      dr += (rs[i]! - mr) ** 2;
    }
    const corr = dt > 0 && dr > 0 ? num / Math.sqrt(dt * dr) : 0;
    const z = Math.abs(corr) * Math.sqrt(Math.max(1, residuals.length - 2));
    const pValue = Math.min(1, 2 * (1 - normalCdf(z)));
    return { name: names[j] ?? `x${j + 1}`, correlation: round(corr), pValue, passed: pValue >= 0.05 };
  });
  const phFailures = phCheck.filter((c) => !c.passed);
  const phVerdict =
    phFailures.length === 0
      ? "No covariate shows a significant Schoenfeld-residual/time association — proportional hazards is not refuted (not proven)."
      : `Proportional hazards is questionable for: ${phFailures.map((c) => c.name).join(", ")} — the hazard ratio for these covariates may vary over time; consider stratification or time-varying coefficients.`;

  return {
    coefficients,
    logPartialLikelihood: round(ll),
    nullLogPartialLikelihood: round(llNull),
    likelihoodRatio: round(lr),
    lrPValue,
    concordance: round(concordance),
    n,
    events: totalEvents,
    iterations,
    converged,
    phCheck: phCheck.map((c) => ({ ...c, correlation: round(c.correlation), pValue: c.pValue })),
    phVerdict,
    interpretation:
      `Cox proportional hazards on ${n} observations with ${totalEvents} event(s), ${p} covariate(s), fitted by Newton–Raphson on the Breslow partial likelihood (${iterations} iteration(s)${converged ? ", converged" : ", did NOT converge — treat coefficients with suspicion"}). ` +
      `Concordance ${Number.isFinite(concordance) ? concordance.toFixed(3) : "n/a"} (0.5 = coin flip, 1.0 = perfect ranking). ` +
      `HR > 1 means the covariate raises the hazard (shorter survival); HR < 1 lowers it.`,
    warnings,
  };
}

export interface SurvivalSummary {
  curve: KaplanMeierCurve;
  logRank: ReturnType<typeof logRankTest> | null;
  cox: CoxResult | null;
}

/**
 * Full survival analysis over prepared observations. `groupLabels` (optional)
 * drives the two-group log-rank; `cox` is the optional Cox fit.
 */
export function runSurvival(
  obs: SurvivalObservation[],
  opts: { groupLabels?: string[]; cox?: CoxInput } = {},
): SurvivalSummary {
  if (obs.length < 5) throw new SurvivalError(`Survival analysis needs at least 5 observations; got ${obs.length}.`);
  let curve: KaplanMeierCurve;
  try {
    curve = kaplanMeier(obs);
  } catch (err) {
    if (err instanceof StatsError) throw new SurvivalError(err.message);
    throw err;
  }
  let logRank: ReturnType<typeof logRankTest> | null = null;
  if (opts.groupLabels) {
    const map = new Map<string, SurvivalObservation[]>();
    for (let i = 0; i < obs.length; i++) {
      const label = opts.groupLabels[i] ?? "(unknown)";
      const arr = map.get(label) ?? [];
      arr.push(obs[i] as SurvivalObservation);
      map.set(label, arr);
    }
    if (map.size === 2) {
      try {
        logRank = logRankTest([...map.entries()].map(([label, o]) => ({ label, obs: o })));
      } catch (err) {
        if (err instanceof StatsError) throw new SurvivalError(err.message);
        throw err;
      }
    } else if (map.size > 2) {
      throw new SurvivalError(
        `The log-rank test compares exactly two groups; "${opts.groupLabels[0] ?? "group"}" column has ${map.size} distinct values.`,
      );
    }
  }
  let cox: CoxResult | null = null;
  if (opts.cox) {
    try {
      cox = coxProportionalHazards(opts.cox);
    } catch (err) {
      if (err instanceof SurvivalError) throw err;
      throw err;
    }
  }
  return { curve, logRank, cox };
}

/** Two-sided t critical value — re-exported for the runner's CI rendering. */
export function survivalTCritical(alpha: number, df: number): number {
  return studentTCriticalTwoSided(alpha, df);
}

/** Two-sided t p-value — re-exported for the runner. */
export function survivalTPValue(t: number, df: number): number {
  return studentTPValue(t, df);
}
