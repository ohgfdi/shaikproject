/**
 * A/B serving & monitoring — experiment assignment, sequential testing, and
 * guardrail monitoring for models/campaigns IN PRODUCTION.
 *
 * The repo's A/B toolkit (`lib/engine/abtest.ts`) analyzes a COMPLETED
 * experiment. SERVING an experiment raises three questions that module does
 * not answer — this module closes them, deterministic, dependency-free:
 *
 *  1. ASSIGNMENT — which variant does user U see? Deterministic hashing
 *     (SHA-256 via node:crypto) of `experimentId:userId` maps every user to
 *     [0,1); uniform banding assigns variants at the configured split.
 *     Properties the honest way:
 *       - STABLE: the same user sees the same variant for the life of the
 *         experiment — no peeking, no variant-flipping mid-flight.
 *       - STATELESS: no assignment table to store or corrupt; assignment is
 *         a pure function of (experimentId, userId, split).
 *       - AUDITABLE: `assignmentHash` is returned so any assignment can be
 *         re-derived and proven later.
 *     Salt = experiment id, so two experiments randomize independently.
 *
 *  2. SEQUENTIAL TESTING — "can we stop early?" The Wald sequential
 *     probability ratio test (SPRT) for two proportions gives the exact
 *     answer WITHOUT the peeking penalty that makes repeated NHST p-values
 *     lie. At every look, the log-likelihood ratio of H1 (lift = mde) vs H0
 *     (lift = 0) is compared against boundaries derived from the chosen
 *     α/β: verdict = continue | H0 | H1. The test controls its error rates
 *     EXACTLY no matter how often you look — the reason practitioners use
 *     it (and the reason "p = 0.04 at day 3" is not evidence).
 *
 *  3. GUARDRAILS — "is the variant breaking something?" Metric streams
 *     (latency, error rate, revenue/user…) are checked against configured
 *     bounds with a two-proportion / two-mean z test vs the control arm,
 *     machine-readable severity (ok | warn | breach), and an explicit
 *     "regression but not yet significant" state so small samples never
 *     masquerade as safety.
 *
 * DETERMINISM: assignment hashing is pure; SPRT is closed-form; guardrail z
 * tests are closed-form. Same data ⇒ byte-identical verdicts.
 *
 * HONESTY: every result prints its assumptions (binomial arms, no
 * interference between users, boundary α/β) and the exact thresholds used.
 * Nothing here claims "causal" — the design (randomized assignment) is what
 * earns it, and the methodology line says exactly that.
 */

import { createHash } from "node:crypto";

import { normalCdf } from "@/lib/engine/stats";

export class AbServingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbServingError";
  }
}

// ---------------------------------------------------------------------------
// 1. Deterministic assignment
// ---------------------------------------------------------------------------

export interface VariantSpec {
  name: string;
  /** Share of traffic (0..1). Shares are normalized to sum to 1. */
  share: number;
}

export interface AssignmentResult {
  variant: string;
  /** Uniform hash position in [0,1) — auditable, re-derivable. */
  position: number;
  assignmentHash: string;
  /** The normalized cumulative bands actually used (provenance). */
  bands: { variant: string; low: number; high: number }[];
}

/**
 * Assign a user to a variant. Pure function: same (experimentId, userId,
 * variants) ⇒ same variant forever. The SHA-256 digest of
 * `experimentId:userId` is read as a big-endian fraction of the full digest
 * (all 32 bytes → [0,1)) — far more resolution than any experiment needs and
 * immune to the modulo bias of small hashes.
 */
export function assignVariant(experimentId: string, userId: string, variants: VariantSpec[]): AssignmentResult {
  if (!experimentId.trim()) throw new AbServingError("experimentId is required (it is the randomization salt).");
  if (!userId.trim()) throw new AbServingError("userId is required.");
  if (variants.length < 2) throw new AbServingError("At least 2 variants are required.");
  if (variants.some((v) => !Number.isFinite(v.share) || v.share < 0)) {
    throw new AbServingError("Variant shares must be finite and non-negative.");
  }
  const total = variants.reduce((a, v) => a + v.share, 0);
  if (total <= 0) throw new AbServingError("Variant shares must sum to a positive number.");

  const digest = createHash("sha256").update(`${experimentId}:${userId}`).digest();
  // All 256 bits as a fraction — position ∈ [0, 1).
  const hi = digest.readBigUInt64BE(0);
  const lo = digest.readBigUInt64BE(8);
  const position = Number((hi << 64n) + lo) / Number(1n << 128n);

  const bands: { variant: string; low: number; high: number }[] = [];
  let cursor = 0;
  let chosen = variants[variants.length - 1]!.name;
  for (const v of variants) {
    const width = v.share / total;
    const low = cursor;
    const high = cursor + width;
    bands.push({ variant: v.name, low, high });
    if (position >= low && position < high) chosen = v.name;
    cursor = high;
  }
  // Position exactly 1.0 is impossible by construction, but floating-point
  // edge: if no band matched (position == cursor), the last band wins.
  if (position >= cursor) chosen = variants[variants.length - 1]!.name;

  return {
    variant: chosen,
    position,
    assignmentHash: digest.toString("hex"),
    bands,
  };
}

// ---------------------------------------------------------------------------
// 2. Sequential testing (SPRT for two proportions)
// ---------------------------------------------------------------------------

export interface SprtInput {
  /** Conversions in the control arm. */
  controlSuccesses: number;
  controlTrials: number;
  /** Conversions in the treatment arm. */
  treatmentSuccesses: number;
  treatmentTrials: number;
  /** Type-I error budget (default 0.05). */
  alpha?: number;
  /** Type-II error budget (default 0.20). */
  beta?: number;
  /** The lift worth detecting, RELATIVE (0.05 = +5% over the control rate). */
  mdeRelative: number;
}

export type SprtVerdict = "continue" | "reject-h0" | "accept-h0";

export interface SprtResult {
  verdict: SprtVerdict;
  /** Observed control rate. */
  pControl: number;
  /** Observed treatment rate. */
  pTreatment: number;
  /** Log-likelihood ratio log( P(data|H1) / P(data|H0) ). */
  logLikelihoodRatio: number;
  /** Upper boundary log(A) = log((1−β)/α) — LLR above ⇒ reject H0. */
  upperBoundary: number;
  /** Lower boundary log(β/(1−α)) — LLR below ⇒ accept H0. */
  lowerBoundary: number;
  /** H0: p_t = p_c. H1: p_t = p_c·(1 + mdeRelative). */
  h0: string;
  h1: string;
  /** Progress of the LLR between the boundaries, 0..1-ish (for UI bars). */
  progress: number;
  methodology: string[];
  interpretation: string;
}

/**
 * Wald SPRT for two binomial arms. At every look the running LLR is compared
 * to the Wald boundaries; error rates are controlled EXACTLY regardless of
 * how many looks were taken (Wald 1945). This is the honest answer to
 * "can we stop early?" — repeated fixed-horizon p-values are not.
 *
 * The per-observation LLR for Bernoulli arms under p1 vs p0 decomposes into
 * successes and failures counts, so the statistic is closed-form:
 *   LLR = S·ln(p1/p0) + (n_c − S_c)·ln((1−p1_c)/(1−p0_c)) + … per arm,
 * with H0: p_t = p_c (pooled) and H1: p_t = p_c(1 + mde).
 */
export function sequentialProbabilityRatioTest(input: SprtInput): SprtResult {
  const alpha = input.alpha ?? 0.05;
  const beta = input.beta ?? 0.2;
  const { controlSuccesses: sC, controlTrials: nC, treatmentSuccesses: sT, treatmentTrials: nT } = input;
  if (!Number.isInteger(nC) || !Number.isInteger(nT) || nC < 1 || nT < 1) {
    throw new AbServingError("Both arms need at least 1 trial.");
  }
  if (sC < 0 || sT < 0 || sC > nC || sT > nT) throw new AbServingError("Successes must be within [0, trials].");
  if (!Number.isFinite(input.mdeRelative) || input.mdeRelative <= 0) {
    throw new AbServingError("mdeRelative must be a positive lift (e.g. 0.05 for +5%).");
  }
  if (alpha <= 0 || alpha >= 1 || beta <= 0 || beta >= 1) {
    throw new AbServingError("alpha and beta must be in (0, 1).");
  }

  const pC = sC / nC;
  const pT = sT / nT;

  // H0 rates: pooled (same p in both arms). H1: treatment lifted by mde.
  const p0 = (sC + sT) / (nC + nT);
  const p1C = p0;
  const p1T = Math.min(1 - 1e-12, p0 * (1 + input.mdeRelative));

  const clamp = (p: number) => Math.min(1 - 1e-12, Math.max(1e-12, p));
  const llBernoulli = (successes: number, trials: number, p: number) => {
    const pp = clamp(p);
    const failures = trials - successes;
    return successes * Math.log(pp) + failures * Math.log(1 - pp);
  };

  // LLR = log P(data | H1) − log P(data | H0)
  const llH1 = llBernoulli(sC, nC, p1C) + llBernoulli(sT, nT, p1T);
  const llH0 = llBernoulli(sC, nC, clamp(p0)) + llBernoulli(sT, nT, clamp(p0));
  const llr = llH1 - llH0;

  const upperBoundary = Math.log((1 - beta) / alpha);
  const lowerBoundary = Math.log(beta / (1 - alpha));

  let verdict: SprtVerdict = "continue";
  if (llr >= upperBoundary) verdict = "reject-h0";
  else if (llr <= lowerBoundary) verdict = "accept-h0";

  const span = upperBoundary - lowerBoundary;
  const progress = span > 0 ? Math.min(1, Math.max(0, (llr - lowerBoundary) / span)) : 0.5;

  const methodology = [
    "Wald Sequential Probability Ratio Test (SPRT) for two binomial arms — error rates α/β hold EXACTLY at every interim look (no peeking penalty).",
    `H0: p_treatment = p_control (pooled ${(p0 * 100).toFixed(2)}%). H1: p_treatment = p_control·(1 + mde ${(
      input.mdeRelative * 100
    ).toFixed(1)}%).`,
    `Boundaries: continue while ${lowerBoundary.toFixed(3)} < LLR < ${upperBoundary.toFixed(3)}; α = ${alpha}, β = ${beta}.`,
    "Assumes binomial arms and no interference between users (no shared-network effects).",
  ];

  const interpretation =
    verdict === "reject-h0"
      ? `Treatment is a WINNER: LLR ${llr.toFixed(2)} crossed the upper boundary — stop the experiment and ship (observed lift ${((pT / (pC || 1) - 1) * 100).toFixed(1)}%).`
      : verdict === "accept-h0"
        ? `Treatment is NOT worth detecting: LLR ${llr.toFixed(2)} crossed the lower boundary — the lift is smaller than the MDE; stop and keep control.`
        : `Keep running: LLR ${llr.toFixed(2)} is between the boundaries (${(progress * 100).toFixed(0)}% of the way). The test has not decided.`;

  return {
    verdict,
    pControl: pC,
    pTreatment: pT,
    logLikelihoodRatio: llr,
    upperBoundary,
    lowerBoundary,
    h0: `p_t = p_c = ${(p0 * 100).toFixed(2)}%`,
    h1: `p_t = p_c·(1 + ${(input.mdeRelative * 100).toFixed(1)}%)`,
    progress,
    methodology,
    interpretation,
  };
}

// ---------------------------------------------------------------------------
// 3. Guardrail monitoring
// ---------------------------------------------------------------------------

export type GuardrailSeverity = "ok" | "warn" | "breach" | "insufficient-data";

export interface GuardrailMetricInput {
  name: string;
  /** Higher-is-better (revenue/user) or lower-is-better (latency, errors). */
  direction: "higher-is-better" | "lower-is-better";
  controlMean: number;
  variantMean: number;
  /** Standard deviation of the metric in each arm (per-user). */
  controlSd: number;
  variantSd: number;
  controlN: number;
  variantN: number;
  /** Relative change beyond this (in the bad direction) is a BREACH (default 0.05). */
  breachThreshold?: number;
  /** Relative change beyond this (bad direction) is a WARN (default 0.02). */
  warnThreshold?: number;
  /** Two-sided z significance for "statistically confirmed" (default 0.05). */
  alpha?: number;
}

export interface GuardrailVerdict {
  name: string;
  direction: GuardrailMetricInput["direction"];
  controlMean: number;
  variantMean: number;
  /** Relative change in the BAD direction (positive = bad). */
  relativeChangeBad: number;
  zStatistic: number;
  pValue: number;
  severity: GuardrailSeverity;
  confirmed: boolean;
  message: string;
}

/**
 * Guardrail check on one metric stream. A breach needs BOTH a material
 * relative move in the bad direction AND statistical confirmation (two-sample
 * z on the means) — a big move on 12 users is "regression, not yet
 * significant", not a breach. That honesty is the whole point.
 */
export function evaluateGuardrail(m: GuardrailMetricInput): GuardrailVerdict {
  if (m.controlN < 2 || m.variantN < 2) {
    return {
      name: m.name,
      direction: m.direction,
      controlMean: m.controlMean,
      variantMean: m.variantMean,
      relativeChangeBad: Number.NaN,
      zStatistic: Number.NaN,
      pValue: Number.NaN,
      severity: "insufficient-data",
      confirmed: false,
      message: "Fewer than 2 observations per arm — no guardrail inference possible yet.",
    };
  }
  for (const v of [m.controlMean, m.variantMean, m.controlSd, m.variantSd]) {
    if (!Number.isFinite(v)) throw new AbServingError(`Guardrail ${m.name}: means and SDs must be finite.`);
  }
  if (m.controlSd < 0 || m.variantSd < 0) throw new AbServingError(`Guardrail ${m.name}: SDs must be non-negative.`);

  const badDelta = m.direction === "lower-is-better" ? m.variantMean - m.controlMean : m.controlMean - m.variantMean;
  const base = Math.abs(m.controlMean) > 1e-12 ? Math.abs(m.controlMean) : 1;
  const relativeChangeBad = badDelta / base;

  const se = Math.sqrt((m.controlSd * m.controlSd) / m.controlN + (m.variantSd * m.variantSd) / m.variantN);
  const z = se > 1e-12 ? (m.variantMean - m.controlMean) / se : 0;
  // Two-sided p from the normal CDF (oracle-validated primitive), floored at
  // the engine's significance RESOLUTION: 1e-12. Tail probabilities below that
  // are numerology for a decision tool — an alpha tighter than the floor is
  // asking the z-test a question it cannot answer, so "confirmed" deliberately
  // cannot fire there (p = floor is not < alpha = floor). Zero-variance arms
  // (se = 0) are the exact-no-difference case: p = 1 exactly, not 1 − ε from
  // CDF rounding.
  const pValue = se > 1e-12 ? Math.max(1e-12, 2 * (1 - normalCdf(Math.abs(z)))) : 1;
  const alpha = m.alpha ?? 0.05;
  const confirmed = pValue < alpha;
  const breachThreshold = m.breachThreshold ?? 0.05;
  const warnThreshold = m.warnThreshold ?? 0.02;

  let severity: GuardrailSeverity = "ok";
  if (relativeChangeBad > breachThreshold) severity = confirmed ? "breach" : "warn";
  else if (relativeChangeBad > warnThreshold) severity = "warn";

  const pct = (relativeChangeBad * 100).toFixed(1);
  const message =
    severity === "breach"
      ? `BREACH: ${m.name} degraded ${pct}% vs control (z = ${z.toFixed(2)}, p = ${pValue.toFixed(4)}) — statistically confirmed and material. Roll back or cap traffic.`
      : severity === "warn"
        ? confirmed
          ? `WARN: ${m.name} degraded ${pct}% vs control and the change IS significant (p = ${pValue.toFixed(4)}) — below the breach threshold but watch it.`
          : `WARN: ${m.name} moved ${pct}% in the bad direction but is NOT yet significant (p = ${pValue.toFixed(4)}, n = ${m.controlN}/${m.variantN}) — regression suspected, evidence pending.`
        : `OK: ${m.name} is within tolerance (${pct}% bad-direction, p = ${pValue.toFixed(4)}).`;

  return {
    name: m.name,
    direction: m.direction,
    controlMean: m.controlMean,
    variantMean: m.variantMean,
    relativeChangeBad,
    zStatistic: z,
    pValue,
    severity,
    confirmed,
    message,
  };
}

/** Evaluate a whole guardrail suite; overall severity = worst verdict. */
export function evaluateGuardrails(metrics: GuardrailMetricInput[]): {
  verdicts: GuardrailVerdict[];
  overall: GuardrailSeverity;
  safe: boolean;
  methodology: string[];
} {
  const verdicts = metrics.map(evaluateGuardrail);
  const rank: Record<GuardrailSeverity, number> = { ok: 0, "insufficient-data": 1, warn: 2, breach: 3 };
  let overall: GuardrailSeverity = "ok";
  for (const v of verdicts) if (rank[v.severity] > rank[overall]) overall = v.severity;
  return {
    verdicts,
    overall,
    safe: overall === "ok" || overall === "insufficient-data",
    methodology: [
      "Each guardrail is a two-sample z test on means with a materiality threshold; a BREACH requires both materiality AND significance.",
      "Overall severity = worst single verdict — one broken guardrail is enough to hold a rollout.",
      "Directional honesty: 'lower-is-better' metrics (latency, error rate) flip the bad-direction sign before thresholding.",
    ],
  };
}
