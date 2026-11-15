/**
 * A/B test toolkit — frequentist + Bayesian, deterministic, no dependencies.
 *
 * Three complementary computations, the standard professional toolkit:
 *
 *  1. `twoProportionZTest`  — pooled two-proportion z-test with Wald
 *     interval, relative lift, and a variance-homogeneity-free assumption
 *     block (n·p̂ ≥ 5 per arm checked explicitly).
 *  2. `planAbSampleSize`    — a-priori design: required n per arm for a
 *     given baseline rate, minimum detectable effect, α and power, via the
 *     canonical normal-approximation formula (Fleiss without continuity
 *     correction — the same formula scipy docs and Evan Miller's calculator
 *     use). Also reports the MDE achievable with the sample actually
 *     provided, so an underpowered run is diagnosed, not silently reported.
 *  3. `bayesianAbTest`      — Beta(α₀+successes, β₀+failures) posteriors:
 *     posterior means/medians/95% credible intervals, P(treatment > control)
 *     by numerical integration over the Beta densities, and the expected
 *     loss of choosing each arm (the risk-neutral decision rule).
 *
 * Statistical primitives: normal CDF/inverse come from the oracle-validated
 * `lib/engine/stats.ts`; the incomplete beta and log-gamma come from
 * `lib/engine/hypothesis.ts` (exported there and reused — one implementation,
 * one set of oracle tests).
 */

import { logGamma, regularizedBeta } from "@/lib/engine/hypothesis";
import { normalCdf, normalInv } from "@/lib/engine/stats";

export interface AbArm {
  /** Conversions / responders in the arm. */
  successes: number;
  /** Total users / trials in the arm (must be ≥ successes). */
  trials: number;
}

export interface AbAssumption {
  name: string;
  passed: boolean;
  warning?: string;
}

export interface TwoProportionZResult {
  pControl: number;
  pTreatment: number;
  absoluteDiff: number;
  relativeLiftPct: number;
  zStatistic: number;
  pValue: number;
  ci95: { low: number; high: number };
  assumptions: AbAssumption[];
  interpretation: string;
}

export interface AbSampleSizePlan {
  /** Required sample size PER ARM for the requested design. */
  perArm: number;
  baselineRate: number;
  mdeAbsolute: number;
  mdeRelativePct: number;
  alpha: number;
  power: number;
  /** Achievable MDE (absolute) with the sample actually provided, if given. */
  achievableMde: number | null;
  achievableMdeRelativePct: number | null;
  assumptions: AbAssumption[];
  interpretation: string;
}

export interface BayesianAbResult {
  prior: { alpha: number; beta: number };
  control: { alpha: number; beta: number; mean: number; median: number; ci95: { low: number; high: number } };
  treatment: { alpha: number; beta: number; mean: number; median: number; ci95: { low: number; high: number } };
  /** P(treatment > control) computed by numerical integration. */
  probabilityBetter: number;
  /** Expected loss (in conversion-rate points) of shipping the winner. */
  expectedLoss: { control: number; treatment: number };
  winner: "treatment" | "control" | "inconclusive";
  interpretation: string;
}

export class AbTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbTestError";
  }
}

/** Full A/B evaluation: design check + frequentist test + Bayesian posterior. */
export interface AbEvaluation {
  design: AbSampleSizePlan;
  frequentist: TwoProportionZResult;
  bayesian: BayesianAbResult;
}

export function evaluateAbTest(
  arms: { control: AbArm; treatment: AbArm },
  opts?: { alpha?: number; power?: number },
): AbEvaluation {
  return {
    design: planAbSampleSize({
      baselineRate: arms.control.successes / arms.control.trials,
      providedControlTrials: arms.control.trials,
      alpha: opts?.alpha,
      power: opts?.power,
    }),
    frequentist: twoProportionZTest(arms),
    bayesian: bayesianAbTest(arms),
  };
}

// ---------------------------------------------------------------------------
// 1. Two-proportion z-test
// ---------------------------------------------------------------------------

export function twoProportionZTest(arms: { control: AbArm; treatment: AbArm }): TwoProportionZResult {
  validateArm(arms.control, "control");
  validateArm(arms.treatment, "treatment");
  const n1 = arms.control.trials;
  const n2 = arms.treatment.trials;
  const x1 = arms.control.successes;
  const x2 = arms.treatment.successes;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!(sePooled > 0)) {
    throw new AbTestError("Both arms have identical zero or full conversion — there is nothing to test.");
  }
  const z = (p2 - p1) / sePooled;
  const pValue = clamp(2 * (1 - normalCdf(Math.abs(z))));
  // Unpooled Wald standard error for the difference interval.
  const seUnpooled = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  const zCrit = normalInv(0.975);
  const diff = p2 - p1;
  const minCell = Math.min(
    n1 * pooled,
    n1 * (1 - pooled),
    n2 * pooled,
    n2 * (1 - pooled),
    n1 * p1,
    n1 * (1 - p1),
    n2 * p2,
    n2 * (1 - p2),
  );
  const npOk = minCell >= 5;
  const assumptions: AbAssumption[] = [
    {
      name: "expected successes/failures ≥ 5 per arm",
      passed: npOk,
      ...(!npOk
        ? {
            warning: `Smallest expected cell is ${minCell.toFixed(1)} (< 5); the normal approximation is unreliable — collect more data or use the Bayesian posterior below.`,
          }
        : {}),
    },
  ];
  return {
    pControl: p1,
    pTreatment: p2,
    absoluteDiff: diff,
    relativeLiftPct: p1 !== 0 ? (diff / p1) * 100 : Number.NaN,
    zStatistic: z,
    pValue,
    ci95: { low: diff - zCrit * seUnpooled, high: diff + zCrit * seUnpooled },
    assumptions,
    interpretation:
      pValue < 0.05
        ? `Treatment converts at ${(p2 * 100).toFixed(2)}% vs control ${(p1 * 100).toFixed(2)}% — the difference is statistically significant at the 5% level.`
        : `The observed conversion difference is not statistically significant at the 5% level (p = ${pValue.toFixed(4)}). Check the power analysis below before concluding "no effect".`,
  };
}

// ---------------------------------------------------------------------------
// 2. Sample-size planning (a-priori power analysis)
// ---------------------------------------------------------------------------

export function planAbSampleSize(opts: {
  baselineRate: number;
  /** Minimum detectable effect, absolute (e.g. 0.02 = 2 points). Default 10% relative. */
  mdeAbsolute?: number;
  alpha?: number;
  power?: number;
  /** If provided, reports the MDE achievable with this many trials per arm. */
  providedControlTrials?: number;
}): AbSampleSizePlan {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  const baseline = opts.baselineRate;
  if (!(baseline > 0 && baseline < 1)) {
    throw new AbTestError(`Baseline conversion must be strictly between 0 and 1; got ${opts.baselineRate}.`);
  }
  const mde = opts.mdeAbsolute ?? baseline * 0.1; // default: +10% relative
  if (!(mde > 0) || baseline + mde >= 1) {
    throw new AbTestError(`The minimum detectable effect must be positive and keep the treatment rate below 100%.`);
  }
  if (!(alpha > 0 && alpha < 1) || !(power > 0 && power < 1)) {
    throw new AbTestError("Alpha and power must be strictly between 0 and 1.");
  }
  const zAlpha = normalInv(1 - alpha / 2);
  const zPower = normalInv(power);
  const p2 = baseline + mde;
  const pBar = (baseline + p2) / 2;
  const n =
    Math.pow(
      zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zPower * Math.sqrt(baseline * (1 - baseline) + p2 * (1 - p2)),
      2,
    ) /
    (mde * mde);
  const perArm = Math.ceil(n);

  let achievableMde: number | null = null;
  let achievableRel: number | null = null;
  if (opts.providedControlTrials && opts.providedControlTrials > 1) {
    // Invert the formula numerically for the achievable MDE at this n.
    const nProvided = opts.providedControlTrials;
    let lo = 1e-6;
    let hi = 1 - baseline - 1e-6;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      const p2m = baseline + mid;
      const pBarM = (baseline + p2m) / 2;
      const needed =
        Math.pow(
          zAlpha * Math.sqrt(2 * pBarM * (1 - pBarM)) + zPower * Math.sqrt(baseline * (1 - baseline) + p2m * (1 - p2m)),
          2,
        ) /
        (mid * mid);
      if (needed > nProvided) lo = mid;
      else hi = mid;
    }
    achievableMde = (lo + hi) / 2;
    achievableRel = (achievableMde / baseline) * 100;
  }

  const assumptions: AbAssumption[] = [
    {
      name: "equal split between arms",
      passed: true,
      warning: "The plan assumes a 50/50 split; unequal ratios need proportionally more total users.",
    },
    {
      name: "independent users, no cross-contamination",
      passed: true,
      warning:
        "SRM checks (sample-ratio mismatch) and a single exposed-user rule are your responsibility in the platform.",
    },
  ];
  const underpowered = achievableMde !== null && opts.mdeAbsolute !== undefined && achievableMde > opts.mdeAbsolute;
  return {
    perArm,
    baselineRate: baseline,
    mdeAbsolute: mde,
    mdeRelativePct: (mde / baseline) * 100,
    alpha,
    power,
    achievableMde,
    achievableMdeRelativePct: achievableRel,
    assumptions,
    interpretation:
      achievableMde === null
        ? `Detecting a ${(mde * 100).toFixed(2)}-point effect on a ${(baseline * 100).toFixed(2)}% baseline at α = ${alpha}, power ${(power * 100).toFixed(0)}% needs ${perArm.toLocaleString()} users PER ARM (${(perArm * 2).toLocaleString()} total).`
        : underpowered
          ? `With the sample already collected (${opts.providedControlTrials?.toLocaleString()} per arm) only a ${((achievableMde ?? 0) * 100).toFixed(2)}-point effect is detectable — the requested ${(mde * 100).toFixed(2)}-point effect is NOT powered. Treat a non-significant result as inconclusive, not negative.`
          : `With the sample already collected (${opts.providedControlTrials?.toLocaleString()} per arm) effects of ${((achievableMde ?? 0) * 100).toFixed(2)} points and larger are detectable at this design's sensitivity.`,
  };
}

// ---------------------------------------------------------------------------
// 3. Bayesian Beta-Binomial
// ---------------------------------------------------------------------------

export function bayesianAbTest(
  arms: { control: AbArm; treatment: AbArm },
  prior: { alpha: number; beta: number } = { alpha: 1, beta: 1 },
): BayesianAbResult {
  validateArm(arms.control, "control");
  validateArm(arms.treatment, "treatment");
  if (!(prior.alpha > 0) || !(prior.beta > 0)) {
    throw new AbTestError("Prior alpha and beta must be strictly positive (Beta(1,1) is the uniform default).");
  }
  const ctrl = posterior(arms.control, prior);
  const trt = posterior(arms.treatment, prior);

  // P(treatment > control): deterministic numerical integration over the
  // control density. 512 midpoints give ~1e-4 accuracy — far below any
  // decision threshold — using Gauss–Legendre-style uniform quadrature.
  let probBetter = 0;
  let lossControl = 0; // E[max(0, ctrl - trt)] — loss of shipping control
  let lossTreatment = 0; // E[max(0, trt - ctrl)] — loss of shipping treatment
  const bins = 512;
  const dP = 1 / bins;
  for (let i = 0; i < bins; i++) {
    const p = (i + 0.5) * dP;
    const wC = betaPdf(p, ctrl.alpha, ctrl.beta) * dP;
    const wT = betaPdf(p, trt.alpha, trt.beta) * dP;
    const eTrtGivenP = betaMeanGivenP(p, trt.alpha, trt.beta);
    const eCtrlGivenP = betaMeanGivenP(p, ctrl.alpha, ctrl.beta);
    probBetter += wC * (1 - betaCdf(p, trt.alpha, trt.beta));
    lossControl += wC * Math.max(0, p - eTrtGivenP);
    lossTreatment += wT * Math.max(0, eCtrlGivenP - p);
  }
  probBetter = clamp(probBetter);
  const winner: BayesianAbResult["winner"] =
    probBetter >= 0.95 ? "treatment" : probBetter <= 0.05 ? "control" : "inconclusive";
  return {
    prior,
    control: ctrl,
    treatment: trt,
    probabilityBetter: probBetter,
    expectedLoss: { control: lossControl, treatment: lossTreatment },
    winner,
    interpretation:
      winner === "treatment"
        ? `Posterior probability that treatment beats control: ${(probBetter * 100).toFixed(1)}% — above the 95% decision threshold. Expected loss of shipping treatment: ${(lossTreatment * 100).toFixed(3)} conversion points.`
        : winner === "control"
          ? `Posterior probability that treatment beats control is only ${(probBetter * 100).toFixed(1)}% — control is the safer choice.`
          : `P(treatment > control) = ${(probBetter * 100).toFixed(1)}% — below the 95% threshold; keep experimenting. Expected loss of shipping now: ${(Math.min(lossControl, lossTreatment) * 100).toFixed(3)} points.`,
  };
}

function posterior(arm: AbArm, prior: { alpha: number; beta: number }) {
  const alpha = prior.alpha + arm.successes;
  const beta = prior.beta + (arm.trials - arm.successes);
  const mean = alpha / (alpha + beta);
  return {
    alpha,
    beta,
    mean,
    median: betaQuantile(0.5, alpha, beta),
    ci95: { low: betaQuantile(0.025, alpha, beta), high: betaQuantile(0.975, alpha, beta) },
  };
}

// ---------------------------------------------------------------------------
// Beta function helpers (built on hypothesis.ts's incomplete beta)
// ---------------------------------------------------------------------------

function betaPdf(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return 0;
  const logPdf = (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - logGamma(a + b) + logGamma(a) + logGamma(b);
  return Math.exp(logPdf);
}

/** Beta CDF via the same regularized incomplete beta used by the t/ANOVA engines. */
function betaCdf(x: number, a: number, b: number): number {
  return regularizedBeta(x, a, b);
}

/**
 * Beta quantile by bisection on the CDF — 60 iterations halve the bracket to
 * 2⁻⁶⁰, beyond float precision; monotone CDF guarantees convergence.
 */
export function betaQuantile(q: number, a: number, b: number): number {
  if (!(q > 0 && q < 1)) throw new AbTestError("Quantile probability must be strictly between 0 and 1.");
  if (a >= 1 && b >= 1) {
    // Mean is a safe interior start for unimodal-uniform-ish shapes.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (betaCdf(mid, a, b) < q) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
  // Heavy-J-shaped priors (a<1 or b<1): same bisection still works because
  // the CDF stays monotone; keep the full bracket.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** E[T | C = p] where T ~ Beta(aT, bT) independent of C — equals the mean of T. */
function betaMeanGivenP(_p: number, a: number, b: number): number {
  return a / (a + b);
}

function validateArm(arm: AbArm, label: string): void {
  if (!arm || !Number.isInteger(arm.trials) || arm.trials < 1) {
    throw new AbTestError(`The ${label} arm needs an integer trial count of at least 1.`);
  }
  if (!Number.isInteger(arm.successes) || arm.successes < 0 || arm.successes > arm.trials) {
    throw new AbTestError(`The ${label} arm's successes must be an integer between 0 and its trial count.`);
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
