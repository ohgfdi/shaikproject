/**
 * Causal / "What-if" analysis.
 *
 * Answers questions like "what happens to margin if we raise price by 5%?"
 * by fitting a multiple linear-impact model of the outcome on the driver
 * column plus optional control variables, and re-evaluating the outcome at a
 * perturbed driver level with the controls held at their observed means.
 * Controlling matters: without it a driver that merely co-moves with the real
 * cause inherits its effect (omitted-variable bias). Everything is computed
 * deterministically from the user's own rows via Householder-QR OLS
 * (lib/engine/stats.ts → ols) and is explicitly labelled as an associative
 * projection — never a causal claim.
 *
 * When the data has too little signal (too few rows, zero variance in the
 * driver, or a near-zero partial relationship) the engine falls back to a
 * hypothetical proportional projection and says so (`fallback: true`), so the
 * UI never presents a correlation as causation.
 *
 * Dependency-free + unit-tested (__tests__/unit/whatif.test.ts, oracle-checked
 * against statsmodels OLS in __tests__/unit/stats-whatif-oracle.test.ts).
 */

import { CausalError, propensityIpw, type PsRow } from "@/lib/engine/elite-causal";
import { crossValidatedRidge } from "@/lib/engine/ridge";
import { normalCdf, ols, studentTCriticalTwoSided, studentTPValue } from "@/lib/engine/stats";
import type { ColType, WhatIfResult } from "@/lib/types";

export class WhatIfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatIfError";
  }
}

export interface WhatIfSource {
  columns: { name: string; type: ColType }[];
  rows: (string | number | boolean | null)[][];
}

export interface WhatIfInput {
  driverColumn: string;
  outcomeColumn: string;
  /** signed percentage perturbation, e.g. 5 = +5%, -3 = -3% */
  pctChange: number;
  /**
   * Optional control variables held at their observed means while the driver
   * is perturbed — the honest way to damp omitted-variable bias. Unknown or
   * degenerate controls are reported in the methodology, never silently
   * swallowed.
   */
  controlColumns?: string[];
  /**
   * Optional BINARY treatment column (exactly two distinct values). When given,
   * the engine ALSO re-estimates the driver's effect with propensity-score
   * inverse-probability weighting (elite-causal engine) and reports whether the
   * weighted contrast agrees with the OLS slope — a design-robust cross-check
   * that upgrades the projection from a bare associative read.
   */
  treatmentColumn?: string;
}

function toNum(v: string | number | boolean | null | undefined): number {
  if (v === null || v === undefined || v === "") return Number.NaN;
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(String(v).replace(/[,$\s%€£]/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function meanOf(values: number[]): number {
  return values.length ? values.reduce((a, v) => a + v, 0) / values.length : 0;
}

export function runWhatIf(source: WhatIfSource, input: WhatIfInput): WhatIfResult {
  const { driverColumn, outcomeColumn, pctChange } = input;
  if (!driverColumn || !outcomeColumn) throw new WhatIfError("Choose both a driver column and an outcome column.");
  if (!Number.isFinite(pctChange) || pctChange < -100 || pctChange > 1000) {
    throw new WhatIfError("The change must be a percentage between −100 and +1000.");
  }
  const driverIdx = source.columns.findIndex((c) => c.name === driverColumn);
  const outcomeIdx = source.columns.findIndex((c) => c.name === outcomeColumn);
  if (driverIdx < 0) throw new WhatIfError(`Driver column “${driverColumn}” was not found in the dataset.`);
  if (outcomeIdx < 0) throw new WhatIfError(`Outcome column “${outcomeColumn}” was not found in the dataset.`);
  if (driverIdx === outcomeIdx) throw new WhatIfError("Driver and outcome must be different columns.");
  const treatmentIdx = input.treatmentColumn ? source.columns.findIndex((c) => c.name === input.treatmentColumn) : -1;
  if (input.treatmentColumn && treatmentIdx < 0)
    throw new WhatIfError(`Treatment column “${input.treatmentColumn}” was not found in the dataset.`);
  if (input.treatmentColumn && (treatmentIdx === driverIdx || treatmentIdx === outcomeIdx))
    throw new WhatIfError("The treatment column must be different from the driver and outcome columns.");

  // Resolve controls up front: dedupe, drop driver/outcome collisions, and
  // record unknown names so they are reported instead of silently ignored.
  const requestedControls = (input.controlColumns ?? []).filter(
    (name, i, arr) => arr.indexOf(name) === i && name !== driverColumn && name !== outcomeColumn,
  );
  if (input.treatmentColumn) {
    // The treatment enters the IPW propensity model; it must not double-book
    // as a "control" (its rows are used as the PS covariate set, not held at a
    // mean).
    const deduped = requestedControls.filter((name) => name !== input.treatmentColumn);
    requestedControls.length = 0;
    requestedControls.push(...deduped);
  }
  const unknownControls = requestedControls.filter((name) => !source.columns.some((c) => c.name === name));
  const controlIdxs: { name: string; i: number }[] = [];
  for (const name of requestedControls) {
    if (unknownControls.includes(name)) continue;
    const idx = source.columns.findIndex((c) => c.name === name);
    if (idx >= 0) controlIdxs.push({ name, i: idx });
  }
  const controlNames = controlIdxs.map((c) => c.name);

  // Joint complete-case filtering (listwise deletion — the statsmodels/sklearn
  // convention): every regression row must have the driver, the outcome and
  // every accepted control present.
  const design: number[][] = [];
  const outcome: number[] = [];
  const treatmentRaw: (string | number | boolean | null)[] = [];
  let driverOutcomeComplete = 0;
  for (const row of source.rows) {
    const x = toNum(row[driverIdx]);
    const y = toNum(row[outcomeIdx]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    driverOutcomeComplete++;
    const controls = controlIdxs.map((c) => toNum(row[c.i]));
    if (controls.some((v) => !Number.isFinite(v))) continue;
    design.push([x, ...controls]);
    outcome.push(y);
    if (treatmentIdx >= 0) treatmentRaw.push(row[treatmentIdx] ?? null);
  }
  const n = design.length;

  // Notes that always travel with the result — no silent data loss.
  const notes: string[] = [];
  if (unknownControls.length > 0) {
    notes.push(`Unknown control column(s) ignored: ${unknownControls.join(", ")} — not present in the dataset.`);
  }
  if (driverOutcomeComplete - n > 0) {
    notes.push(
      `${(driverOutcomeComplete - n).toLocaleString()} row(s) with missing control values were excluded (listwise deletion over driver, outcome and controls).`,
    );
  }

  const driverMean = meanOf(design.map((r) => r[0] as number));
  const before = meanOf(outcome);

  // Hypothetical proportional projection — too few rows to estimate anything.
  if (n < 8) {
    return tinySampleResult(input, { n, driverMean, before, notes, controlNames });
  }

  let fit = ols(design, outcome);
  let degradationNote: string | null = null;
  if (!fit && controlNames.length > 0) {
    // Rank-deficient WITH controls (a constant or collinear control): degrade
    // honestly to the bivariate fit and say so.
    fit = ols(
      design.map((r) => [r[0] as number]),
      outcome,
    );
    if (fit) {
      degradationNote = `Control column(s) ${controlNames.join(", ")} are constant or collinear with the driver and were dropped — the fitted model is bivariate.`;
    }
  }
  if (!fit) {
    // Zero-variance driver (or non-estimable design): hypothetical fallback.
    return tinySampleResult(
      input,
      { n, driverMean, before, notes, controlNames },
      "The driver column has no variance (or the model is not estimable) — showing a hypothetical proportional projection.",
    );
  }

  // Causal cross-check: propensity-score IPW over the binary treatment, with
  // the driver + controls as the pre-treatment covariate set. Failures degrade
  // to a note — the OLS projection is the primary answer either way.
  const causal =
    treatmentIdx >= 0 && input.treatmentColumn
      ? causalCrossCheck(
          input,
          { design, outcome, treatmentRaw, treatmentColumn: input.treatmentColumn, controlNames },
          fit.coefficients[0] as number,
          notes,
        )
      : undefined;

  return assembleResult(input, fit, {
    n,
    driverMean,
    before,
    controlNames,
    notes,
    degradationNote,
    inFitControls: degradationNote ? [] : controlNames,
    causal,
    design,
    outcome,
  });
}

// ---------------------------------------------------------------------------
// Causal cross-check (propensity-score IPW over a binary treatment)
// ---------------------------------------------------------------------------

interface CausalContext {
  design: number[][];
  outcome: number[];
  treatmentRaw: (string | number | boolean | null)[];
  treatmentColumn: string;
  controlNames: string[];
}

/**
 * Binary-code the treatment column robustly: boolean true/false, numeric 0/1,
 * or any two-distinct-string pair (alphabetically lower value = 0). Returns
 * null (with a reason appended to `notes`) when the column is not usable.
 */
function encodeTreatment(
  raw: (string | number | boolean | null)[],
  notes: string[],
  columnName: string,
): { treated: (0 | 1)[]; levels: [string, string] } | null {
  const present = raw.filter((v) => v !== null && v !== "");
  const distinct = Array.from(new Set(present.map((v) => String(v))));
  if (distinct.length !== 2) {
    notes.push(
      `Causal cross-check skipped: treatment column “${columnName}” has ${distinct.length} distinct value(s) — a binary column is required.`,
    );
    return null;
  }
  // Stable level order: booleans false<true, numbers ascending, strings
  // alphabetical — the documented, deterministic convention.
  const sorted = [...distinct].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const [zeroLevel, oneLevel] = sorted as [string, string];
  const treated = raw.map((v) => (String(v) === oneLevel ? 1 : 0) as 0 | 1);
  return { treated, levels: [zeroLevel, oneLevel] };
}

function causalCrossCheck(
  input: WhatIfInput,
  ctx: CausalContext,
  olsSlope: number,
  notes: string[],
): WhatIfResult["causal"] | undefined {
  const { design, outcome, treatmentRaw, treatmentColumn, controlNames } = ctx;
  const encoded = encodeTreatment(treatmentRaw, notes, treatmentColumn);
  if (!encoded) return undefined;
  const { treated, levels } = encoded;
  const nTreated = treated.filter((t) => t === 1).length;
  const n = treated.length;
  if (nTreated < 4 || n - nTreated < 4) {
    notes.push(
      `Causal cross-check skipped: the treatment column needs ≥ 4 rows in BOTH groups (has ${nTreated} vs ${n - nTreated}).`,
    );
    return undefined;
  }

  // Propensity covariates: the driver + every control that entered the fit —
  // pre-treatment by construction (they are the projection's own regressors).
  const pCov = design[0]?.length ?? 0;
  const covNames = [input.driverColumn, ...controlNames];
  const rows: PsRow[] = design.map((r, i) => ({
    treated: treated[i] as 0 | 1,
    covariates: r.slice(0, pCov),
  }));

  // The IPW contrast needs the outcome; rows with a null treatment were coded
  // 0 — exclude them from BOTH groups to keep every cell honest.
  const usable = treatmentRaw.map((v, i) => (v !== null && v !== "" ? i : -1)).filter((i) => i >= 0);
  const rowsU = usable.map((i) => rows[i] as PsRow);
  const outcomeU = usable.map((i) => outcome[i] as number);

  try {
    const ipw = propensityIpw(rowsU, outcomeU, covNames);
    // Per-unit read: how big is the driver swing the OLS slope prices one unit
    // of? The weighted contrast is a level difference between groups; convert
    // it with the two groups' mean driver gap so the two estimates are
    // comparable per unit of driver.
    const meanDriverTreated = meanOf(rowsU.filter((r) => r.treated === 1).map((r) => r.covariates[0] as number));
    const meanDriverControl = meanOf(rowsU.filter((r) => r.treated === 0).map((r) => r.covariates[0] as number));
    const driverGap = meanDriverTreated - meanDriverControl;
    const estimatePerUnit = driverGap !== 0 ? ipw.ate / Math.abs(driverGap) : Number.NaN;

    // Agreement verdict: does the IPW contrast, priced per driver unit, sit on
    // the OLS slope's side of zero — and inside a loose 2× magnitude band?
    let agreement: "agree" | "disagree" | "inconclusive";
    const ipwSig = ipw.ci95.low > 0 || ipw.ci95.high < 0;
    if (!Number.isFinite(estimatePerUnit) || !ipwSig) {
      agreement = "inconclusive"; // weighting cannot confirm or deny
    } else if (
      Math.sign(estimatePerUnit) === Math.sign(olsSlope) &&
      Math.abs(estimatePerUnit) <= Math.abs(olsSlope) * 2 + 1e-12
    ) {
      agreement = "agree";
    } else {
      agreement = "disagree";
    }
    if (driverGap === 0) {
      notes.push(
        "Causal cross-check: treated and control groups have identical mean driver values, so no per-unit contrast could be formed — the level estimate is reported only.",
      );
    }
    const z = ipw.standardError > 0 ? Math.abs(ipw.ate / ipw.standardError) : Number.NaN;
    return {
      method: "propensity-ipw",
      treatmentColumn,
      estimate: ipw.ate,
      standardError: ipw.standardError,
      ci95: ipw.ci95,
      pValue: Number.isFinite(z) ? Math.min(1, 2 * (1 - normalCdf(z))) : Number.NaN,
      estimatePerUnit: Number.isFinite(estimatePerUnit) ? Math.round(estimatePerUnit * 1e6) / 1e6 : Number.NaN,
      balanceMaxAbsSmdAfter: Math.max(...ipw.balance.map((b) => Math.abs(b.smdAfter)), 0),
      extremeWeights: ipw.extremeWeights,
      n: ipw.n,
      nTreated: ipw.nTreated,
      agreement,
      identifyingAssumption: ipw.identifyingAssumption,
      warnings: [
        ...ipw.warnings,
        `Treatment coded 0 = “${levels[0]}” (${n - nTreated} rows), 1 = “${levels[1]}” (${nTreated} rows).`,
      ],
    };
  } catch (err) {
    if (err instanceof CausalError) {
      notes.push(`Causal cross-check skipped: ${err.message}`);
      return undefined;
    }
    throw err;
  }
}

interface SampleContext {
  n: number;
  driverMean: number;
  before: number;
  notes: string[];
  controlNames: string[];
}

/** Hypothetical proportional projection (1:1 % change) — always fallback:true. */
function tinySampleResult(input: WhatIfInput, ctx: SampleContext, reason?: string): WhatIfResult {
  const { driverColumn, outcomeColumn, pctChange } = input;
  const after = ctx.before * (1 + pctChange / 100);
  const methodology: string[] = [
    `${driverColumn} (driver) and ${outcomeColumn} (outcome) from ${ctx.n.toLocaleString()} complete row(s)${
      ctx.controlNames.length ? `, controls requested: ${ctx.controlNames.join(", ")}` : ""
    }.`,
  ];
  if (reason) methodology.push(reason);
  if (ctx.notes.length) methodology.push(...ctx.notes);
  methodology.push(
    "Too few complete rows for a stable model — showing a hypothetical proportional projection (1:1 % change).",
  );
  methodology.push("This is NOT a causal estimate. Use it only to explore the direction of change.");
  return {
    driverColumn,
    outcomeColumn,
    pctChange,
    beforeValue: round(ctx.before),
    afterValue: round(after),
    delta: round(after - ctx.before),
    deltaPct: ctx.before === 0 ? 0 : round(((after - ctx.before) / Math.abs(ctx.before)) * 100),
    direction: pctChange >= 0 ? "increase" : "decrease",
    driverMean: round(ctx.driverMean),
    model: { slope: 0, intercept: ctx.before, rSquared: 0, points: ctx.n, pValue: 1, confidenceInterval: [0, 0] },
    fallback: true,
    narrative: `Hypothetical: a ${pctChange > 0 ? "+" : ""}${pctChange}% change in ${driverColumn} maps to a proportional ${
      pctChange > 0 ? "+" : ""
    }${pctChange}% change in ${outcomeColumn}. With only ${ctx.n} complete rows no reliable relationship could be estimated — treat these numbers as hypothetical only.`,
    confidenceNote:
      "Hypothetical fallback: there are too few observations for real regression inference. This is not a causal estimate.",
    methodology,
  };
}

interface AssemblyContext extends SampleContext {
  controlNames: string[];
  degradationNote: string | null;
  /** Controls that actually entered the fitted model (empty when degraded). */
  inFitControls: string[];
  /** IPW causal cross-check result, when a treatment column was supplied. */
  causal?: WhatIfResult["causal"];
  /** Complete-case design + outcome — the raw material for the CV-ridge rescue. */
  design: number[][];
  outcome: number[];
}

function assembleResult(
  input: WhatIfInput,
  fit: {
    coefficients: number[];
    intercept: number;
    standardErrors: number[];
    pValues: number[];
    hc1StandardErrors: number[];
    hc1PValues: number[];
    rSquared: number;
    n: number;
  },
  ctx: AssemblyContext,
): WhatIfResult {
  const { driverColumn, outcomeColumn, pctChange } = input;
  const r2 = fit.rSquared;
  const n = fit.n;
  const signalWeak = Math.abs(r2) < 0.12;

  // Weak-signal rescue: BEFORE dropping to the hypothetical 1:1 projection,
  // try a cross-validated ridge fit. L2 shrinkage keeps a real model alive
  // under collinearity and small samples; deterministic k-fold CV decides
  // OUT-OF-FOLD whether it actually beats the mean baseline. cvR² ≤ 0 ⇒ the
  // regularized model is refused and the honest hypothetical fallback stays.
  let regularized: WhatIfResult["regularized"] | undefined;
  // Set when CV refused the rescue on an insignificant out-of-fold fit —
  // surfaced in the result notes so the refusal is auditable, never silent.
  let rescueRefusedNote: string | null = null;
  let slope = fit.coefficients[0] as number;
  let intercept = fit.intercept;
  let slopeSe = fit.standardErrors[0] as number;
  let slopeSeHC1 = fit.hc1StandardErrors[0] as number;
  let pValueHC1 = fit.hc1PValues[0] as number;
  let pValue = fit.pValues[0] as number;
  let df = n - (fit.coefficients.length + 1);
  if (signalWeak) {
    const cv = crossValidatedRidge(ctx.design, ctx.outcome);
    // Promotion gate — the CV ridge must beat the mean baseline out-of-fold
    // with STATISTICAL SIGNIFICANCE, not merely cvR² > 0: a positive but tiny
    // cvR² passes that bar on any dataset (sawtooth/periodic outcomes score
    // cvR² ≈ 0.04 vs the mean predictor while carrying no generalizable
    // signal). The F = R²(n−2)/(1−R²) test of "ridge explains more variance
    // than the mean baseline out-of-fold" at α = 0.05 is the honest bar — the
    // same idea as testing the slope against zero. Without it, noise is
    // promoted to a "calculated" projection and the fallback honesty is lost.
    const nCv = ctx.outcome.length;
    const fStat = cv && cv.cvR2 > 0 ? (cv.cvR2 * (nCv - 2)) / (1 - cv.cvR2) : 0;
    const fSignificant = fStat >= 3.99; // ≈ F(1, ∞) 95th percentile; conservative for df ≥ 30
    if (cv && fSignificant && Number.isFinite(cv.coefficients[0] as number)) {
      slope = cv.coefficients[0] as number;
      intercept = cv.intercept;
      regularized = { method: "ridge", alpha: cv.alpha, cvR2: round(cv.cvR2), folds: cv.folds };
      // Approximate inference for the regularized slope: the classical SE
      // formula on the ridge residuals. Ridge has no exact Student-t theory,
      // so the methodology labels these as approximate — never passed off as
      // exact. NaN only in degenerate cases (guarded below).
      const p = ctx.design[0]?.length ?? 1;
      let sse = 0;
      for (let i = 0; i < n; i++) {
        const row = ctx.design[i] as number[];
        let pred = intercept;
        for (let j = 0; j < row.length; j++) pred += (cv.coefficients[j] as number) * row[j]!;
        const e = (ctx.outcome[i] as number) - pred;
        sse += e * e;
      }
      const driverMeanSq = ctx.design.reduce((acc, r) => acc + ((r[0] as number) - ctx.driverMean) ** 2, 0);
      df = Math.max(1, n - p - 1);
      const s2 = sse / df;
      if (driverMeanSq > 1e-12 && s2 > 0) {
        slopeSe = Math.sqrt(s2 / driverMeanSq);
        pValue = studentTPValue(Math.abs(slope / slopeSe), df);
      } else {
        slopeSe = Number.NaN;
        pValue = 1;
      }
      // HC1 robust inference is an OLS construction — omitted (not faked).
      slopeSeHC1 = Number.NaN;
      pValueHC1 = Number.NaN;
    } else if (cv) {
      rescueRefusedNote = `The cross-validated ridge rescue was attempted and refused: the out-of-fold fit did not beat the mean baseline significantly (CV R² = ${cv.cvR2.toFixed(3)}, F = ${fStat.toFixed(2)}).`;
    }
  }
  const rescued = regularized !== undefined;
  const tCrit = studentTCriticalTwoSided(0.05, df);
  const margin = Number.isFinite(slopeSe) ? tCrit * slopeSe : 0;

  // Projection: perturb the driver's mean, hold every control at its observed
  // mean (the ceteris-paribus interpretation of "only price changes").
  // Because the fitted intercept already evaluates the model at the
  // regressors' means, moving only the driver term is exactly that
  // interpretation — no separate control-mean term is needed.
  const newDriverMean = ctx.driverMean * (1 + pctChange / 100);
  const after = intercept + slope * newDriverMean;
  const delta = after - ctx.before;
  const deltaPct = ctx.before === 0 ? 0 : (delta / Math.abs(ctx.before)) * 100;

  const methodology: string[] = [
    `${driverColumn} (driver) and ${outcomeColumn} (outcome) from ${n.toLocaleString()} complete rows${
      ctx.inFitControls.length ? `, controlling for ${ctx.inFitControls.join(", ")}` : ""
    }.`,
  ];
  if (ctx.degradationNote) methodology.push(ctx.degradationNote);
  if (ctx.notes.length) methodology.push(...ctx.notes);
  if (rescued && regularized) {
    methodology.push(
      `The raw relationship is weak (OLS r² = ${r2.toFixed(3)}), so the slope was re-estimated with L2-regularized (ridge) regression: α = ${fmtNum(
        regularized.alpha,
      )} selected by ${regularized.folds}-fold cross-validation over a deterministic grid, and the regularized model beats the mean baseline out-of-fold (CV R² = ${regularized.cvR2.toFixed(3)}).`,
    );
    methodology.push(
      `Ridge standard errors are approximate (classical formula on ridge residuals) — the interval below is indicative, not exact.`,
    );
    methodology.push("Still an associative projection from your data — never a causal claim.");
  } else if (signalWeak) {
    methodology.push(
      `The relationship between ${driverColumn} and ${outcomeColumn} is weak (r² = ${r2.toFixed(3)}) — the projection below is hypothetical and should not be read as causal.`,
    );
    if (rescueRefusedNote) methodology.push(rescueRefusedNote);
  } else {
    methodology.push(
      `Fitted a linear-impact model: ${outcomeColumn} ≈ ${fmtNum(intercept)} + ${fmtNum(slope)} × ${driverColumn}${
        ctx.inFitControls.length ? ` + control terms (r² = ${r2.toFixed(3)})` : ` (r² = ${r2.toFixed(3)})`
      }.`,
    );
    methodology.push(
      `Applied a ${pctChange > 0 ? "+" : ""}${pctChange}% change to the mean of ${driverColumn} and re-evaluated ${outcomeColumn} at the new level${
        ctx.inFitControls.length ? ", with controls held at their observed means" : ""
      }.`,
    );
    methodology.push("This is an associative projection from your data, not a controlled causal estimate.");
  }

  if (ctx.causal) {
    const c = ctx.causal;
    methodology.push(
      `Causal cross-check: re-estimated the effect with propensity-score inverse-probability weighting on the binary column “${c.treatmentColumn}” — weighted contrast ${fmtNum(c.estimate)} (95% CI ${fmtNum(c.ci95.low)} to ${fmtNum(c.ci95.high)}), ${fmtNum(c.estimatePerUnit)} per unit of ${driverColumn}, vs the OLS slope ${fmtNum(slope)} → the two designs ${c.agreement}.`,
    );
    methodology.push(
      `IPW identifying assumption: ${c.identifyingAssumption} Weighted balance |SMD|max = ${c.balanceMaxAbsSmdAfter.toFixed(3)}; extreme weights: ${c.extremeWeights}.`,
    );
    if (c.warnings.length) methodology.push(...c.warnings.map((w) => `IPW note: ${w}`));
  }

  const direction = pctChange >= 0 ? "increase" : "decrease";
  const causalPhrase = ctx.causal
    ? ctx.causal.agreement === "agree"
      ? ` A design-robust re-estimation (propensity-score weighting) agrees with the linear projection — the strongest evidence this dataset can offer that the number is not an artefact of the model form.`
      : ctx.causal.agreement === "disagree"
        ? ` WARNING: the propensity-score re-estimation DISAGREES with the linear projection — treat the magnitude below as fragile and investigate the treatment column before acting.`
        : ` The propensity-score re-estimation is not precise enough to confirm or refute the projection.`
    : "";
  const narrative =
    rescued && regularized
      ? `A ${pctChange > 0 ? "+" : ""}${pctChange}% ${
          direction === "increase" ? "increase" : "decrease"
        } in ${driverColumn} is projected to move average ${outcomeColumn} from ${fmtNum(ctx.before)} to ${fmtNum(
          after,
        )} under a cross-validated ridge projection (CV R² = ${regularized.cvR2.toFixed(3)} over ${
          regularized.folds
        } folds). The raw relationship is weak (r² = ${r2.toFixed(3)}) — treat the magnitude as indicative and validate with more data or a real experiment.`
      : signalWeak
        ? `A ${pctChange > 0 ? "+" : ""}${pctChange}% ${direction === "increase" ? "increase" : "decrease"} in ${driverColumn} would move average ${outcomeColumn} from ${fmtNum(
            ctx.before,
          )} to ${fmtNum(after)} under a hypothetical linear pass-through. The underlying relationship is too weak (r² = ${r2.toFixed(
            3,
          )}) to trust the magnitude — validate with more data or a real experiment.`
        : `Raising (or lowering) the mean of ${driverColumn} by ${pctChange > 0 ? "+" : ""}${pctChange}% is associated with a ${
            delta >= 0 ? "gain" : "drop"
          } of ${fmtNum(Math.abs(delta))} (${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1)}%) in average ${outcomeColumn}, estimated from the linear relationship in ${n.toLocaleString()} rows${
            ctx.inFitControls.length ? ` with ${ctx.inFitControls.join(", ")} held constant` : ""
          }.${causalPhrase}`;

  return {
    driverColumn,
    outcomeColumn,
    pctChange,
    beforeValue: round(ctx.before),
    afterValue: round(after),
    delta: round(delta),
    deltaPct: round(deltaPct),
    direction,
    driverMean: round(ctx.driverMean),
    model: {
      slope: round(slope),
      intercept: round(intercept),
      rSquared: round(r2),
      points: n,
      pValue: round(Number.isFinite(pValue) ? pValue : 1),
      confidenceInterval: [round(slope - margin), round(slope + margin)],
      ...(Number.isFinite(slopeSe) ? { slopeStandardError: round(slopeSe) } : {}),
      ...(Number.isFinite(slopeSeHC1) ? { slopeStandardErrorHC1: round(slopeSeHC1) } : {}),
      ...(Number.isFinite(pValueHC1) ? { pValueHC1: round(pValueHC1) } : {}),
      controls: ctx.inFitControls,
    },
    ...(ctx.causal ? { causal: ctx.causal } : {}),
    ...(regularized ? { regularized } : {}),
    fallback: signalWeak && !rescued,
    narrative,
    confidenceNote:
      rescued && regularized
        ? `Calculated with a cross-validated ridge (L2-regularized) regression on your rows — α = ${fmtNum(
            regularized.alpha,
          )} chosen out-of-fold over a deterministic grid (${regularized.folds} folds, CV R² = ${regularized.cvR2.toFixed(
            3,
          )} vs the mean baseline); the plain-OLS signal was weak (r² = ${r2.toFixed(3)}). Standard errors are approximate. Association is not causation.`
        : signalWeak
          ? "Hypothetical fallback: the real regression fit is below the r² threshold, so the projection is not presented as reliable."
          : `Calculated with real multiple ordinary least squares regression on your rows (exact 95% coefficient interval via the Student-t distribution; HC1 heteroskedasticity-robust standard errors reported alongside${
              ctx.inFitControls.length ? `, controls: ${ctx.inFitControls.join(", ")}` : ""
            }). Association is not causation.`,
    methodology,
  };
}

export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e6 || (abs > 0 && abs < 1e-4)) return v.toExponential(2);
  if (abs >= 1000) {
    return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return v.toLocaleString("en-US", { maximumFractionDigits: abs >= 100 ? 1 : 3 });
}
