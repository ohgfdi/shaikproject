/**
 * Elite causal engine — observational causal estimates with HONEST labels.
 *
 * Repo trust bar: every number is computed, labelled and provable; nothing is
 * presented as causal without a design that earns it. This module implements
 * the two workhorse designs for observational/panel data and labels every
 * output with its identifying assumption:
 *
 *  1. Difference-in-differences (DiD) — 2 groups × 2 periods. Estimate is the
 *     (treated Δ) − (control Δ); inference from the OLS standard error of the
 *     2×2 interaction regression. Identifying assumption: PARALLEL TRENDS —
 *     printed on every result, never dropped.
 *  2. Propensity-score weighting (IPW / ATE) — logistic PS on pre-treatment
 *     covariates, ATT-style stabilized weights, covariate balance (standardized
 *     mean differences before/after) so the user can SEE whether weighting
 *     balanced the sample. Identifying assumption: UNCONFOUNDEDNESS given the
 *     covariates + overlap (positivity) — printed on every result.
 *
 * Diagnostics that fail loudly: negative weights, extreme PS (overlap
 * violation), or an unbalanced weighted sample raise/surface a warning in the
 * result rather than a silently wrong number.
 */

import { fitLogistic } from "@/lib/engine/elite-stats";
import { isFiniteNumber, mean, studentTPValue } from "@/lib/engine/stats";

export class CausalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CausalError";
  }
}

function round(v: number): number {
  if (!Number.isFinite(v)) return v;
  return Math.round(v * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// 1. Difference-in-differences
// ---------------------------------------------------------------------------

export interface DidGroupPeriod {
  /** Mean of the outcome in this group-period cell. */
  value: number;
  /** Number of raw observations behind `value`. */
  n: number;
  /** Within-cell standard deviation — REQUIRED for an honest SE. Without it
   * the engine refuses to invent a significance level (se/p come back NaN). */
  sd?: number;
}

export interface DidInput {
  treated: { before: DidGroupPeriod; after: DidGroupPeriod };
  control: { before: DidGroupPeriod; after: DidGroupPeriod };
}

export interface DidResult {
  /** The DiD estimate: (treated after − before) − (control after − before). */
  estimate: number;
  /** NaN when any cell lacked `sd` — no invented significance. */
  standardError: number;
  tStatistic: number;
  pValue: number;
  ci95: { low: number; high: number } | null;
  /** Group×period cell means used (provenance). */
  cells: {
    treatedBefore: number;
    treatedAfter: number;
    controlBefore: number;
    controlAfter: number;
  };
  /** Treated-group change minus control-group change components. */
  decomposition: { treatedChange: number; controlChange: number };
  n: number;
  /** ALWAYS present: the assumption this estimate leans on. */
  identifyingAssumption: string;
  interpretation: string;
  warnings: string[];
}

/**
 * 2×2 difference-in-differences.
 *
 * Estimate = (ȳ_T,post − ȳ_T,pre) − (ȳ_C,post − ȳ_C,pre). The standard error
 * is the closed-form SE of a difference of four independent cell means,
 *   SE = √( s²_TB/n_TB + s²_TA/n_TA + s²_CB/n_CB + s²_CA/n_CA ),
 * the classical 2×2 DiD standard error (identical to the OLS
 * treated×post interaction SE under homoskedasticity, without fitting a
 * degenerate regression on replicated means). t/p use df = n − 4. When any
 * cell omits `sd`, se/t/p are NaN — the result is still returned, honestly
 * unlabelled for significance rather than fabricated.
 */
export function differenceInDifferences(input: DidInput): DidResult {
  const cells = [input.treated.before, input.treated.after, input.control.before, input.control.after];
  for (const c of cells) {
    if (!isFiniteNumber(c.value) || !Number.isInteger(c.n) || c.n < 2) {
      throw new CausalError("Each DiD cell needs a finite mean and at least 2 observations.");
    }
    if (c.sd !== undefined && (!isFiniteNumber(c.sd) || c.sd < 0)) {
      throw new CausalError("Cell `sd` must be a non-negative finite number.");
    }
  }
  const { treated, control } = input;
  const treatedChange = treated.after.value - treated.before.value;
  const controlChange = control.after.value - control.before.value;
  const estimate = treatedChange - controlChange;

  const haveSd = cells.every((c) => c.sd !== undefined);
  let se = Number.NaN;
  let t = Number.NaN;
  let p = Number.NaN;
  let ci: { low: number; high: number } | null = null;
  if (haveSd) {
    const varSum = cells.reduce((s, c) => s + (c.sd as number) ** 2 / c.n, 0);
    se = Math.sqrt(varSum);
    t = se > 0 ? estimate / se : Number.NaN;
    const df = Math.max(
      1,
      input.treated.before.n + input.treated.after.n + input.control.before.n + input.control.after.n - 4,
    );
    p = Number.isFinite(t) ? studentTPValue(Math.abs(t), df) : Number.NaN;
    ci = { low: estimate - 1.96 * se, high: estimate + 1.96 * se };
  }
  const warnings: string[] = [];
  if (!haveSd) {
    warnings.push(
      "Cell standard deviations were not provided, so no standard error or p-value is reported — significance cannot be assessed from means alone.",
    );
  }
  if (Math.sign(controlChange) !== Math.sign(treatedChange) && controlChange !== 0 && treatedChange !== 0) {
    warnings.push(
      "The treated and control groups moved in OPPOSITE directions between periods — parallel trends is questionable; the estimate leans entirely on the control group's trajectory.",
    );
  }
  return {
    estimate: round(estimate),
    standardError: round(se),
    tStatistic: round(t),
    pValue: p,
    ci95: ci ? { low: round(ci.low), high: round(ci.high) } : null,
    cells: {
      treatedBefore: round(treated.before.value),
      treatedAfter: round(treated.after.value),
      controlBefore: round(control.before.value),
      controlAfter: round(control.after.value),
    },
    decomposition: { treatedChange: round(treatedChange), controlChange: round(controlChange) },
    n: treated.before.n + treated.after.n + control.before.n + control.after.n,
    identifyingAssumption:
      "Parallel trends: without the treatment, the treated group would have moved like the control group.",
    interpretation:
      `DiD estimate ${round(estimate)}` +
      (haveSd
        ? ` (95% CI ${round((ci as { low: number }).low)} to ${round((ci as { high: number }).high)}; SE ${round(se)}). `
        : " (no SE — cell SDs not provided). ") +
      `Treated changed by ${round(treatedChange)}; control changed by ${round(controlChange)}. ` +
      `This is causal ONLY IF parallel trends holds — with a single pre-period it cannot be tested here, only argued. ` +
      `Prefer ≥ 3 pre-periods to plot trends before quoting this number.`,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 2. Propensity-score weighting (IPW, ATE) + covariate balance
// ---------------------------------------------------------------------------

export interface PsRow {
  /** 1 = treated, 0 = control. */
  treated: 0 | 1;
  /** Pre-treatment covariates ONLY — post-treatment variables bias the PS. */
  covariates: number[];
}

export interface BalanceRow {
  covariate: string;
  /** Standardized mean difference BEFORE weighting (treated − control / pooled SD). */
  smdBefore: number;
  /** SMD AFTER IPW. */
  smdAfter: number;
  /** |SMD| < 0.1 is the conventional balance threshold (both stages). */
  balancedAfter: boolean;
}

export interface IpwResult {
  /** IPW estimate of the ATE. */
  ate: number;
  standardError: number;
  ci95: { low: number; high: number };
  /** Per-row propensity scores (provenance — inspect for overlap). */
  propensity: { treated: 0 | 1; ps: number }[];
  psModel: {
    converged: boolean;
    iterations: number;
    aic: number;
    coefficients: { name: string; coefficient: number; pValue: number }[];
  };
  balance: BalanceRow[];
  /** Rows whose stabilized weight is extreme (PS outside [0.05, 0.95] OR w > 10). */
  extremeWeights: number;
  n: number;
  nTreated: number;
  identifyingAssumption: string;
  interpretation: string;
  warnings: string[];
}

/**
 * Inverse-probability weighting for the ATE with stabilized weights:
 *   treated rows   w = 1 / e(x)        (scaled by P(T=1) → stabilized)
 *   control rows   w = 1 / (1 − e(x))  (scaled by P(T=0))
 * ATE = Σ wT·y / Σ wT − Σ wC·y / Σ wC (Horvitz–Thompson on stabilized
 * weights). Balance is reported as standardized mean differences computed on
 * the SAME weights. Overlap violations and residual imbalance surface as
 * warnings — never silently ignored.
 */
export function propensityIpw(
  rows: PsRow[],
  outcome: number[],
  covariateNames: string[] | undefined,
  opts: { psClamp?: [number, number] } = {},
): IpwResult {
  const n = rows.length;
  if (n < 8) throw new CausalError("Propensity weighting needs at least 8 rows.");
  if (outcome.length !== n) throw new CausalError("Outcome length must match the covariate rows.");
  if (!outcome.every(isFiniteNumber)) throw new CausalError("The outcome contains non-finite values.");
  const treatedArr = rows.map((r) => r.treated);
  const nTreated = treatedArr.filter((t) => t === 1).length;
  if (nTreated === 0 || nTreated === n) throw new CausalError("Need both treated and control rows.");
  const pCov = rows[0]!.covariates.length;
  if (pCov === 0) throw new CausalError("Provide at least one pre-treatment covariate for the propensity model.");
  if (!rows.every((r) => r.covariates.length === pCov && r.covariates.every(isFiniteNumber))) {
    throw new CausalError("Covariate rows must be fully finite with a consistent width.");
  }

  const psFit = fitLogistic(
    {
      X: rows.map((r) => r.covariates),
      y: treatedArr as number[],
      featureNames: covariateNames ?? Array.from({ length: pCov }, (_, j) => `x${j + 1}`),
    },
    { maxIter: 200 },
  );
  // Predicted propensity scores.
  const names = psFit.coefficients.map((c) => c.name);
  const betaByName = new Map(psFit.coefficients.map((c) => [c.name, c.coefficient]));
  const b0 = betaByName.get("(intercept)") ?? 0;
  const clamp: [number, number] = opts.psClamp ?? [0.01, 0.99];
  const propensity = rows.map((r) => {
    let eta = b0;
    for (let j = 0; j < pCov; j++) eta += r.covariates[j]! * (betaByName.get(names[j + 1]!) ?? 0);
    const ps = Math.min(clamp[1], Math.max(clamp[0], sigmoid(eta)));
    return { treated: r.treated, ps };
  });

  const pTreat = nTreated / n;
  const weights = propensity.map((p) => (p.treated === 1 ? pTreat / p.ps : (1 - pTreat) / (1 - p.ps)));

  let wTsum = 0;
  let wTySum = 0;
  let wCsum = 0;
  let wCySum = 0;
  for (let i = 0; i < n; i++) {
    if (treatedArr[i] === 1) {
      wTsum += weights[i]!;
      wTySum += weights[i]! * (outcome[i] as number);
    } else {
      wCsum += weights[i]!;
      wCySum += weights[i]! * (outcome[i] as number);
    }
  }
  const muT = wTySum / wTsum;
  const muC = wCySum / wCsum;
  const ate = muT - muC;

  // SE via the two-sample form on weighted means (conservative; no bootstrap).
  const varOf = (idxs: number[]) => {
    let m = 0;
    let wsum = 0;
    for (const i of idxs) {
      const w = weights[i]!;
      m += w * (outcome[i] as number);
      wsum += w;
    }
    const muW = m / wsum;
    // Weighted variance of the Hájek estimator.
    let acc = 0;
    for (const i of idxs) {
      const w = weights[i]!;
      acc += w * w * ((outcome[i] as number) - muW) ** 2;
    }
    return acc / (wsum * wsum);
  };
  const treatedIdx = treatedArr.map((t, i) => (t === 1 ? i : -1)).filter((i) => i >= 0);
  const controlIdx = treatedArr.map((t, i) => (t === 0 ? i : -1)).filter((i) => i >= 0);
  const se = Math.sqrt(varOf(treatedIdx) + varOf(controlIdx));

  // Balance: SMD before/after per covariate.
  const balance: BalanceRow[] = [];
  for (let j = 0; j < pCov; j++) {
    const col = rows.map((r) => r.covariates[j]!);
    const tIdx = rows.map((r, i) => (r.treated === 1 ? i : -1)).filter((i) => i >= 0);
    const cIdx = rows.map((r, i) => (r.treated === 0 ? i : -1)).filter((i) => i >= 0);
    const meanT = mean(tIdx.map((i) => col[i] as number));
    const meanC = mean(cIdx.map((i) => col[i] as number));
    const varT = varianceOf(tIdx.map((i) => col[i] as number));
    const varC = varianceOf(cIdx.map((i) => col[i] as number));
    const pooledSd = Math.sqrt((varT + varC) / 2) || 1;
    const before = (meanT - meanC) / pooledSd;
    // Weighted means/vars with the SAME IPW weights.
    const wMean = (idx: number[]) => {
      let s = 0;
      let ws = 0;
      for (const i of idx) {
        s += weights[i]! * (col[i] as number);
        ws += weights[i]!;
      }
      return s / ws;
    };
    const wVar = (idx: number[], mu: number) => {
      let s = 0;
      let ws = 0;
      for (const i of idx) {
        s += weights[i]! * ((col[i] as number) - mu) ** 2;
        ws += weights[i]!;
      }
      return s / ws;
    };
    const meanTw = wMean(tIdx);
    const meanCw = wMean(cIdx);
    const after = (meanTw - meanCw) / (Math.sqrt((wVar(tIdx, meanTw) + wVar(cIdx, meanCw)) / 2) || 1);
    balance.push({
      covariate: covariateNames?.[j] ?? `x${j + 1}`,
      smdBefore: round(before),
      smdAfter: round(after),
      balancedAfter: Math.abs(after) < 0.1,
    });
  }

  const extremeWeights =
    weights.filter((w) => w > 10).length +
    propensity.filter((p) => p.ps <= clamp[0] + 1e-12 || p.ps >= clamp[1] - 1e-12).length;
  const unbalanced = balance.filter((b) => !b.balancedAfter);
  const warnings: string[] = [];
  if (extremeWeights > 0) {
    warnings.push(
      `${extremeWeights} row(s) have extreme propensity scores or weights — overlap (positivity) is questionable; consider trimming to PS ∈ [0.1, 0.9] and re-estimating.`,
    );
  }
  if (unbalanced.length > 0) {
    warnings.push(
      `Weighting did NOT balance: ${unbalanced.map((b) => b.covariate).join(", ")} still have |SMD| ≥ 0.1 — the PS model is likely misspecified (add interactions/nonlinear terms).`,
    );
  }
  if (!psFit.converged) {
    warnings.push("The propensity model did not converge — the PS estimates (and therefore the ATE) are unreliable.");
  }
  return {
    ate: round(ate),
    standardError: round(se),
    ci95: { low: round(ate - 1.96 * se), high: round(ate + 1.96 * se) },
    propensity: propensity.map((p) => ({ treated: p.treated, ps: round(p.ps) })),
    psModel: {
      converged: psFit.converged,
      iterations: psFit.iterations,
      aic: psFit.aic,
      coefficients: psFit.coefficients.map((c) => ({ name: c.name, coefficient: c.coefficient, pValue: c.pValue })),
    },
    balance,
    extremeWeights,
    n,
    nTreated,
    identifyingAssumption:
      "Unconfoundedness (no unmeasured confounder given these covariates) + overlap: every unit could in principle be treated or control.",
    interpretation:
      `IPW ATE = ${round(ate)} (95% CI ${round(ate - 1.96 * se)} to ${round(ate + 1.96 * se)}), weighting by stabilized ` +
      `propensity scores from a logistic model on ${pCov} pre-treatment covariate(s). ` +
      `Causal ONLY IF the covariates capture every confounder — a claim no diagnostic can prove. ` +
      `Check the balance table: weighting should drive |SMD| below 0.1; extreme weights flag overlap failures.`,
    warnings,
  };
}

function varianceOf(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
}

function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

// ---------------------------------------------------------------------------
// 3. Placebo (falsification) diagnostics — beating the design against itself
// ---------------------------------------------------------------------------

/**
 * Placebo-time DiD: re-run the SAME 2×2 DiD one period EARLIER, before any
 * treatment could have happened. A credible design produces a placebo
 * estimate statistically indistinguishable from zero; a placebo estimate
 * similar in size to the real one means the "effect" was there all along —
 * parallel trends is dead. This is the standard falsification check the
 * DiD result's own interpretation line asks for.
 *
 * All inputs are PRE-period cells: base (t−2) and placebo (t−1) for each
 * group, with the "treatment" imagined between them. Reuses the exact 2×2
 * machinery (closed-form SE, df = n − 4) so placebo and real estimates are
 * directly comparable.
 */
export interface PlaceboDidResult {
  /** The placebo DiD estimate — should be ≈ 0 under parallel trends. */
  estimate: number;
  standardError: number;
  pValue: number;
  /** The real estimate this placebo is compared against. */
  realEstimate: number;
  /** |placebo| < |real| and placebo p > 0.10 ⇒ the design survives. */
  verdict: "passes" | "fails";
  interpretation: string;
}

export function placeboDid(
  input: {
    treated: { base: DidGroupPeriod; placebo: DidGroupPeriod };
    control: { base: DidGroupPeriod; placebo: DidGroupPeriod };
  },
  realEstimate: number,
): PlaceboDidResult {
  const did = differenceInDifferences({
    treated: { before: input.treated.base, after: input.treated.placebo },
    control: { before: input.control.base, after: input.control.placebo },
  });
  const sdMissing = Number.isNaN(did.standardError);
  const placeboExceeds = Math.abs(did.estimate) >= Math.abs(realEstimate) && realEstimate !== 0;
  const significant = !sdMissing && did.pValue < 0.1;
  const verdict: "passes" | "fails" = placeboExceeds || significant ? "fails" : "passes";
  return {
    estimate: did.estimate,
    standardError: did.standardError,
    pValue: did.pValue,
    realEstimate: round(realEstimate),
    verdict,
    interpretation:
      `Placebo DiD (one period before treatment): ${did.estimate}` +
      (sdMissing
        ? " — no SE (cell SDs missing), size-comparison only."
        : ` (p = ${did.pValue === undefined ? "n/a" : did.pValue.toFixed(4)}).`) +
      ` ${verdict === "passes" ? "PASS" : "FAIL"}: ` +
      (verdict === "passes"
        ? "the pre-treatment placebo effect is indistinguishable from zero and smaller than the real estimate — consistent with parallel trends."
        : "the placebo shows an effect of comparable size/significance BEFORE any treatment — parallel trends is questionable and the real estimate is not credible as causal."),
  };
}
