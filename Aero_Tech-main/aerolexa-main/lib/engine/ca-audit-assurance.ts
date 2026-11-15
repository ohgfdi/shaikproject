/**
 * Audit & assurance practice engine — the workflow a statutory audit actually
 * runs, from accepting the engagement to signing the report.
 *
 * The existing `ca-audit-fieldwork.ts` and `ca-audit-opinion.ts` cover the
 * arithmetic core (materiality, MUS/formula sampling, the SA 705 opinion
 * table, the standard file index). This module closes the assurance-practice
 * gaps around that core:
 *
 *   1. Engagement & acceptance (SA 210/220) — client integrity, competence and
 *      resources, fee arrangements, scope documented in writing, and the
 *      independence threat/safeguard evaluation.
 *   2. Written representations (SA 580) — the management representation letter
 *      scaffold and the standard representations checklist.
 *   3. Risk assessment (SA 315/240/330) — understanding the entity, evaluating
 *      internal/IT controls, the fraud-risk assessment (including the
 *      rebuttable revenue-recognition presumption and management override),
 *      risk of material misstatement at the assertion level, and the planned
 *      further audit responses.
 *   4. Sampling & substantive analytical procedures (SA 530/520) — MUS and
 *      attribute sample sizing, population stratification, MUS result
 *      projection, independent expectation development and the investigation
 *      of differences.
 *   5. Workpaper system (SA 230) — cross-references, review notes, review and
 *      sign-off, versioned remarks, partner flags and file assembly.
 *   6. Evidence linking (SA 500/505/501) — the evidence trail, sufficiency
 *      against significant risks, external confirmations (including an
 *      unreturned/exception response), stock-inspection and legal-correspondence
 *      notes.
 *   7. Reporting (SA 700/701/705/706/260/265) — opinion formation, KAM/ EOM/OM
 *      paragraphs, deficiency classification and the management letter.
 *
 * SCOPE AND HONESTY — this is workflow arithmetic on caller-supplied inputs.
 * It does not fetch live standards, does not exercise professional judgement
 * for the auditor, and does not file or sign anything. Every determination the
 * standards require a human to own (acceptance, fraud rebuttal, sufficiency,
 * the opinion) is surfaced with its rule trace so a reviewer can challenge it.
 *
 * Money is in MINOR UNITS (paise) as integers, matching every other CA engine.
 */

/** Error type for invalid assurance inputs. */
export class AuditAssuranceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditAssuranceError";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Format paise as a rupee string for generated narrative. */
export function fmtMinor(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

// ===========================================================================
// 1. Engagement acceptance, independence & written representations
// ===========================================================================

export type ThreatCategory = "self-interest" | "self-review" | "advocacy" | "familiarity" | "intimidation";

/** A threat to independence / objectivity (SA 220). */
export interface IndependenceThreat {
  category: ThreatCategory;
  description: string;
  /** 1 = low, 2 = medium, 3 = high. */
  severity: 1 | 2 | 3;
}

/** A safeguard that mitigates one or more threat categories. */
export interface IndependenceSafeguard {
  description: string;
  mitigates: ThreatCategory[];
  /** 1 = weak, 2 = moderate, 3 = strong. */
  effectiveness: 1 | 2 | 3;
}

export interface IndependenceEvaluation {
  acceptable: boolean;
  residualRisk: "low" | "medium" | "high";
  /** Threats that could not be reduced to an acceptable level. */
  unresolved: IndependenceThreat[];
  mitigations: { threat: ThreatCategory; safeguard: string; before: number; after: number }[];
  summary: string;
}

/**
 * Evaluate independence threats against safeguards. Residual severity is the
 * threat severity reduced by the strongest safeguard that addresses its
 * category; a threat whose residual stays at 3 is unresolvable and makes the
 * engagement unacceptable (SA 220.14).
 */
export function evaluateIndependence(
  threats: IndependenceThreat[],
  safeguards: IndependenceSafeguard[],
): IndependenceEvaluation {
  const mitigations: IndependenceEvaluation["mitigations"] = [];
  const unresolved: IndependenceThreat[] = [];
  let totalResidual = 0;

  for (const threat of threats) {
    const applicable = safeguards.filter((s) => s.mitigates.includes(threat.category));
    const strongest = applicable.reduce((max, s) => Math.max(max, s.effectiveness), 0);
    const after = clamp(threat.severity - strongest, 0, 3);
    totalResidual += after;
    if (strongest > 0) {
      const best = applicable.find((s) => s.effectiveness === strongest);
      mitigations.push({
        threat: threat.category,
        safeguard: best?.description ?? "safeguard",
        before: threat.severity,
        after,
      });
    }
    if (after === 3) unresolved.push(threat);
  }

  const residualRisk: IndependenceEvaluation["residualRisk"] =
    unresolved.length > 0 || totalResidual >= 6 ? "high" : totalResidual >= 3 ? "medium" : "low";

  return {
    acceptable: residualRisk !== "high",
    residualRisk,
    unresolved,
    mitigations,
    summary:
      `Independence evaluation: ${threats.length} threat(s), ${safeguards.length} safeguard(s), ` +
      `residual risk ${residualRisk}${unresolved.length ? `, ${unresolved.length} unresolved` : ""}.`,
  };
}

export interface EngagementAcceptanceInput {
  /** Level of concern about client integrity: low concern = "low". */
  clientIntegrityConcern: "low" | "medium" | "high";
  competenceAndResources: "sufficient" | "insufficient";
  independenceAcceptable: boolean;
  scopeAgreedInWriting: boolean;
  feeArrangement: "fixed" | "time-based" | "contingent";
  ethicalRequirementsComplianceConfirmed: boolean;
}

export interface EngagementAcceptanceResult {
  decision: "accept" | "accept-with-conditions" | "decline";
  conditions: string[];
  reasons: string[];
}

/** SA 220 acceptance/continuance decision with its rule trace. */
export function assessEngagementAcceptance(input: EngagementAcceptanceInput): EngagementAcceptanceResult {
  const reasons: string[] = [];
  const conditions: string[] = [];

  if (input.clientIntegrityConcern === "high") reasons.push("Client integrity concerns are high (SA 220.13).");
  if (input.competenceAndResources === "insufficient")
    reasons.push("The firm lacks the competence, time or resources for the engagement.");
  if (!input.independenceAcceptable)
    reasons.push("Independence/objectivity concerns are not resolvable with safeguards.");

  if (reasons.length > 0) {
    return { decision: "decline", conditions, reasons };
  }

  if (input.clientIntegrityConcern === "medium")
    conditions.push("Strengthen client due diligence and document integrity considerations.");
  if (!input.scopeAgreedInWriting)
    conditions.push("Agree the engagement scope and terms in writing before commencement (SA 210).");
  if (input.feeArrangement === "contingent")
    conditions.push(
      "Contingent fees create a self-interest threat; convert to a fixed/time-based arrangement (SA 240 / Code of Ethics).",
    );
  if (!input.ethicalRequirementsComplianceConfirmed)
    conditions.push("Obtain documented confirmation of compliance with the ethical requirements.");

  const decision: EngagementAcceptanceResult["decision"] = conditions.length > 0 ? "accept-with-conditions" : "accept";

  return {
    decision,
    conditions,
    reasons: reasons.length > 0 ? reasons : ["No acceptance impediments identified."],
  };
}

/** Standard written representations the auditor requests (SA 580). */
export const WRITTEN_REPRESENTATIONS: readonly string[] = [
  "The financial statements have been prepared in accordance with the applicable financial reporting framework.",
  "All transactions have been recorded and are reflected in the financial statements.",
  "All material related-party relationships and transactions have been disclosed.",
  "All known fraud or suspected fraud affecting the entity involving management, employees or third parties has been disclosed.",
  "All known instances of non-compliance or suspected non-compliance with laws and regulations have been disclosed.",
  "All material misstatements identified during the audit have been corrected, or are disclosed if uncorrected.",
  "All subsequent events requiring adjustment or disclosure have been disclosed.",
  "The entity has complied with all contractual agreements whose breach could materially affect the financial statements.",
  "All accounting estimates and fair values are reasonable and reflect management's best judgement.",
  "The entity has adequate books and records and an effective system of internal control.",
];

export interface RepresentationLetterInput {
  entityName: string;
  financialYear: string;
  periodEnd: string;
  auditorName: string;
  auditorFirm: string;
  /** Additional entity-specific representations to append. */
  additionalRepresentations?: string[];
  /** Known matters the letter must address. */
  qualifications?: string[];
}

/** Render a management representation letter scaffold (SA 580.16). */
export function renderManagementRepresentationLetter(input: RepresentationLetterInput): string {
  const items = [...WRITTEN_REPRESENTATIONS, ...(input.additionalRepresentations ?? [])];
  const lines = [
    `[Entity letterhead]`,
    ``,
    `Date: ${input.periodEnd}`,
    ``,
    `To: ${input.auditorFirm} (Auditor: ${input.auditorName})`,
    ``,
    `Dear Sir/Madam,`,
    ``,
    `This representation letter is provided in connection with your audit of the financial ` +
      `statements of ${input.entityName} for the financial year ${input.financialYear}, for the ` +
      `purpose of expressing an opinion on whether the financial statements give a true and fair view.`,
    ``,
    `We confirm, to the best of our knowledge and belief, the following representations:`,
    ...items.map((item, i) => `${i + 1}. ${item}`),
  ];
  if (input.qualifications && input.qualifications.length > 0) {
    lines.push(``, `Matters qualified:`, ...input.qualifications.map((q) => `- ${q}`));
  }
  lines.push(
    ``,
    `Yours faithfully,`,
    `_____________________________`,
    `For and on behalf of ${input.entityName}`,
    `(Managing Director / Chief Financial Officer)`,
  );
  return lines.join("\n");
}

// ===========================================================================
// 2. Risk assessment workflow (SA 315/240/330)
// ===========================================================================

export const FINANCIAL_STATEMENT_ASSERTIONS = [
  "existence",
  "rights-and-obligations",
  "completeness",
  "accuracy",
  "cut-off",
  "classification-and-presentation",
  "valuation-and-allocation",
  "occurrence",
] as const;

export type FinancialStatementAssertion = (typeof FINANCIAL_STATEMENT_ASSERTIONS)[number];

export interface AssertionRiskInput {
  account: string;
  assertion: FinancialStatementAssertion;
  /** 1 (remote) .. 5 (almost certain) likelihood of material misstatement. */
  inherentLikelihood: number;
  /** 1 (trivial) .. 5 (very large) magnitude if it occurs. */
  inherentImpact: number;
  /** 0 (controls absent/ineffective) .. 1 (controls fully effective). */
  controlEffectiveness: number;
}

export interface AssertionRmm {
  account: string;
  assertion: FinancialStatementAssertion;
  inherentScore: number;
  controlReliance: number;
  rmmScore: number;
  significant: boolean;
}

export interface AuditResponse {
  account: string;
  assertion: FinancialStatementAssertion;
  response: "test-of-controls" | "substantive" | "combined";
  extent: "reduced" | "standard" | "expanded";
}

export interface RiskAssessmentResult {
  rmms: AssertionRmm[];
  significantRisks: { account: string; assertion: FinancialStatementAssertion; rmmScore: number }[];
  /** How many assertions each account-level risk covers. */
  assertionCoverage: Record<string, number>;
  responses: AuditResponse[];
  methodology: string[];
}

/**
 * Assess risk of material misstatement (RMM) at the assertion level.
 *
 * RMM = inherent score × (1 − control reliance), where the inherent score is
 * likelihood × magnitude (1..25). A risk is "significant" when the residual
 * RMM reaches 12, which drives the nature/extent of the planned response
 * (SA 315.26–28, SA 330).
 */
export function assessRiskOfMaterialMisstatement(inputs: AssertionRiskInput[]): RiskAssessmentResult {
  const rmms: AssertionRmm[] = inputs.map((input) => {
    const likelihood = clamp(Math.round(input.inherentLikelihood), 1, 5);
    const impact = clamp(Math.round(input.inherentImpact), 1, 5);
    const inherentScore = likelihood * impact;
    const controlReliance = clamp(input.controlEffectiveness, 0, 1);
    const rmmScore = Math.round(inherentScore * (1 - controlReliance));
    return {
      account: input.account,
      assertion: input.assertion,
      inherentScore,
      controlReliance,
      rmmScore,
      significant: rmmScore >= 12,
    };
  });

  const significantRisks = rmms
    .filter((r) => r.significant)
    .map((r) => ({ account: r.account, assertion: r.assertion, rmmScore: r.rmmScore }))
    .sort((a, b) => b.rmmScore - a.rmmScore);

  const assertionCoverage: Record<string, number> = {};
  for (const rmm of rmms) {
    assertionCoverage[rmm.account] = (assertionCoverage[rmm.account] ?? 0) + 1;
  }

  const responses: AuditResponse[] = rmms.map((rmm) => {
    const controls =
      rmm.controlReliance >= 1 ? "test-of-controls" : rmm.controlReliance > 0 ? "combined" : "substantive";
    const extent: AuditResponse["extent"] = rmm.significant
      ? "expanded"
      : rmm.controlReliance >= 1
        ? "reduced"
        : "standard";
    return { account: rmm.account, assertion: rmm.assertion, response: controls, extent };
  });

  return {
    rmms,
    significantRisks,
    assertionCoverage,
    responses,
    methodology: [
      "RMM = (inherent likelihood × inherent impact) × (1 − control reliance).",
      "A risk is significant when the residual RMM score reaches 12 (SA 315).",
      "Where controls are relied upon, the response is a test of controls or a combined approach; otherwise it is substantive (SA 330).",
      "Significant risks are met with an expanded response.",
    ],
  };
}

export interface EntityUnderstandingInput {
  natureOfBusiness: string;
  industryAndRegulatory: string[];
  applicableFramework: string;
  ownershipAndGovernance: string[];
  keyAccountingPolicies: string[];
  objectivesAndStrategies: string[];
  measurementAndReviewOfFinancialPerformance: string[];
  significantChanges: string[];
}

/** Structure the SA 315 understanding-of-the-entity narrative. */
export function understandEntity(input: EntityUnderstandingInput): {
  sections: { heading: string; items: string[] }[];
  documentationComplete: boolean;
} {
  const sections = [
    { heading: "Nature of the entity", items: [input.natureOfBusiness] },
    { heading: "Industry, regulatory and other external factors", items: input.industryAndRegulatory },
    { heading: "Applicable financial reporting framework", items: [input.applicableFramework] },
    { heading: "Ownership, governance and related parties", items: input.ownershipAndGovernance },
    { heading: "Accounting policies and their application", items: input.keyAccountingPolicies },
    { heading: "Objectives, strategies and business risks", items: input.objectivesAndStrategies },
    {
      heading: "Measurement and review of financial performance",
      items: input.measurementAndReviewOfFinancialPerformance,
    },
    { heading: "Significant changes from the prior period", items: input.significantChanges },
  ];
  return {
    sections,
    documentationComplete: sections.every((s) => s.items.length > 0),
  };
}

export type ControlDomain = "entity-level" | "it" | "transaction";

export interface ControlEvaluationInput {
  id: string;
  description: string;
  domain: ControlDomain;
  design: "effective" | "deficient";
  operating: "effective" | "not-tested" | "deficient";
}

export interface ControlDeficiency {
  id: string;
  description: string;
  domain: ControlDomain;
  type: "deficiency" | "significant-deficiency" | "material-weakness";
  reason: string;
}

/**
 * Classify control deficiencies for SA 265 communication. A control that is
 * both poorly designed and not operating in an entity-level or IT domain is
 * escalated to a material weakness; a design-only failure is a significant
 * deficiency; an operating-only failure in a transaction control is an
 * ordinary deficiency.
 */
export function evaluateInternalControls(controls: ControlEvaluationInput[]): {
  deficiencies: ControlDeficiency[];
  overallAssessment: string;
  materialWeaknesses: number;
  significantDeficiencies: number;
} {
  const deficiencies: ControlDeficiency[] = [];

  for (const control of controls) {
    const designBad = control.design === "deficient";
    const operatingBad = control.operating === "deficient";
    if (!designBad && !operatingBad) continue;

    let type: ControlDeficiency["type"] = "deficiency";
    let reason = "";
    if (designBad && operatingBad && (control.domain === "entity-level" || control.domain === "it")) {
      type = "material-weakness";
      reason = "Poorly designed and not operating in an entity-level/IT control domain.";
    } else if (designBad && operatingBad) {
      type = "significant-deficiency";
      reason = "Poorly designed and not operating.";
    } else if (designBad) {
      type = "significant-deficiency";
      reason = "Control is not capable of preventing/detecting the misstatement (design deficiency).";
    } else {
      type = control.domain === "it" ? "significant-deficiency" : "deficiency";
      reason = "Control is designed adequately but is not operating effectively.";
    }

    deficiencies.push({
      id: control.id,
      description: control.description,
      domain: control.domain,
      type,
      reason,
    });
  }

  const materialWeaknesses = deficiencies.filter((d) => d.type === "material-weakness").length;
  const significantDeficiencies = deficiencies.filter((d) => d.type === "significant-deficiency").length;

  return {
    deficiencies,
    materialWeaknesses,
    significantDeficiencies,
    overallAssessment:
      materialWeaknesses > 0
        ? "Material weaknesses identified in internal control — communicate to those charged with governance (SA 265)."
        : significantDeficiencies > 0
          ? "Significant deficiencies identified — communicate to those charged with governance."
          : deficiencies.length > 0
            ? "Deficiencies identified — communicate to management."
            : "No deficiencies identified in the controls evaluated.",
  };
}

export interface FraudRiskInput {
  /** Complexity/ judgement in revenue recognition (audit presumption). */
  revenueRecognitionJudgemental: boolean;
  /** Set true only when the auditor has documented a rebuttal of the presumption. */
  revenuePresumptionRebutted: boolean;
  managementOverrideIndicators: string[];
  incentiveFactors: string[];
  opportunityFactors: string[];
  rationalisationFactors: string[];
}

export interface FraudRiskResult {
  rebuttableRevenuePresumption: boolean;
  managementOverrideRisk: boolean;
  significantFraudRisks: string[];
  triangle: { incentive: number; opportunity: number; rationalisation: number };
  response: string;
}

/** Fraud risk assessment (SA 240) with the rebuttable revenue presumption. */
export function assessFraudRisk(input: FraudRiskInput): FraudRiskResult {
  const revenueRisk = (input.revenueRecognitionJudgemental || true) && !input.revenuePresumptionRebutted;
  const managementOverrideRisk = true; // Always presumed under SA 240.31.

  const significantFraudRisks: string[] = [];
  if (revenueRisk) significantFraudRisks.push("Improper revenue recognition (SA 240 presumption)");
  significantFraudRisks.push("Management override of controls (SA 240.31)");

  if (input.incentiveFactors.length + input.opportunityFactors.length + input.rationalisationFactors.length >= 2) {
    significantFraudRisks.push("Fraud triangle indicators present");
  }

  return {
    rebuttableRevenuePresumption: revenueRisk,
    managementOverrideRisk,
    significantFraudRisks,
    triangle: {
      incentive: input.incentiveFactors.length,
      opportunity: input.opportunityFactors.length,
      rationalisation: input.rationalisationFactors.length,
    },
    response:
      `Fraud response: ${significantFraudRisks.length} significant fraud risk(s) — ` +
      `change the nature, timing and extent of procedures, incorporate an element of unpredictability, and ` +
      `test the appropriate journal entries and accounting estimates (SA 240).`,
  };
}

// ===========================================================================
// 3. Sampling & substantive analytical procedures (SA 530 / SA 520)
// ===========================================================================

export const MUS_RELIABILITY_FACTORS: Record<number, number> = {
  0.9: 2.31,
  0.95: 3.0,
  0.99: 4.61,
};

export interface MusSamplePlan {
  bookValue: number;
  tolerableMisstatement: number;
  expectedMisstatement: number;
  confidence: number;
  reliabilityFactor: number;
  samplingInterval: number;
  sampleSize: number;
  note: string;
}

/** Monetary-unit sampling plan (SA 530). */
export function musSampleSize(input: {
  bookValue: number;
  tolerableMisstatement: number;
  expectedMisstatement: number;
  confidence: number;
}): MusSamplePlan {
  if (input.tolerableMisstatement <= 0) throw new AuditAssuranceError("Tolerable misstatement must be positive.");
  if (input.bookValue < 0) throw new AuditAssuranceError("Book value cannot be negative.");

  const reliabilityFactor = MUS_RELIABILITY_FACTORS[input.confidence] ?? 3.0;
  const effectiveTolerable = input.tolerableMisstatement - input.expectedMisstatement;
  const samplingInterval =
    effectiveTolerable > 0 ? effectiveTolerable / reliabilityFactor : input.tolerableMisstatement / reliabilityFactor;
  const sampleSize = clamp(
    Math.ceil(input.bookValue / samplingInterval),
    1,
    input.bookValue <= 0 ? 1 : Number.MAX_SAFE_INTEGER,
  );

  return {
    bookValue: input.bookValue,
    tolerableMisstatement: input.tolerableMisstatement,
    expectedMisstatement: input.expectedMisstatement,
    confidence: input.confidence,
    reliabilityFactor,
    samplingInterval: Math.round(samplingInterval),
    sampleSize,
    note:
      `MUS: interval ${Math.round(samplingInterval)} = (TM ${input.tolerableMisstatement} − expected ${input.expectedMisstatement}) ` +
      `/ RF ${reliabilityFactor} at ${input.confidence * 100}% confidence; n = ${sampleSize}.`,
  };
}

/** AICPA-style attribute sampling table (tolerable deviation rate bins). */
const ATTRIBUTE_TABLE: Record<number, Record<number, number>> = {
  0.9: { 0.01: 100, 0.02: 50, 0.03: 33, 0.04: 24, 0.05: 20, 0.1: 10 },
  0.95: { 0.01: 150, 0.02: 75, 0.03: 50, 0.04: 38, 0.05: 28, 0.1: 14 },
  0.99: { 0.01: 230, 0.02: 115, 0.03: 77, 0.04: 60, 0.05: 42, 0.1: 22 },
};

/**
 * Attribute (controls) sample size. The table gives the base size for an
 * expected deviation rate of zero; a positive expected deviation rate adds a
 * cushion proportional to the tolerable rate.
 */
export function attributeSampleSize(input: {
  confidence: number;
  tolerableDeviationRate: number;
  expectedDeviationRate: number;
}): { sampleSize: number; note: string } {
  const row = ATTRIBUTE_TABLE[input.confidence] ?? ATTRIBUTE_TABLE[0.95]!;
  const tolerables = Object.keys(row)
    .map(Number)
    .sort((a, b) => a - b);
  const bucket = tolerables.find((t) => input.tolerableDeviationRate <= t) ?? tolerables[tolerables.length - 1]!;
  const base = row[bucket] ?? 50;
  const cushion =
    input.expectedDeviationRate > 0
      ? Math.ceil(base * (1 + input.expectedDeviationRate / Math.max(input.tolerableDeviationRate, 0.001)))
      : base;
  return {
    sampleSize: cushion,
    note: `Attribute sampling: base ${base} at ${input.confidence * 100}% / TDR ${input.tolerableDeviationRate}${input.expectedDeviationRate > 0 ? `, padded to ${cushion} for expected deviation ${input.expectedDeviationRate}` : ""}.`,
  };
}

export interface PopulationItem {
  id: string;
  amount: number;
}

export interface Stratum {
  label: string;
  from: number;
  to: number | null;
  items: number;
  bookValue: number;
  sampleSize: number;
}

/** Stratify a population into value bands for targeted sampling. */
export function stratifyPopulation(
  items: PopulationItem[],
  bands: number[],
): { strata: Stratum[]; totalBookValue: number; totalItems: number } {
  const boundaries = [...bands].sort((a, b) => a - b);
  const strata: Stratum[] = [];

  for (let i = 0; i < boundaries.length; i += 1) {
    const from = boundaries[i] ?? 0;
    const to = i + 1 < boundaries.length ? (boundaries[i + 1] ?? null) : null;
    strata.push({
      label: to === null ? `>= ${from}` : `${from}..${to}`,
      from,
      to,
      items: 0,
      bookValue: 0,
      sampleSize: 0,
    });
  }

  for (const item of items) {
    let index = boundaries.findIndex((b, i) => {
      const upper =
        i + 1 < boundaries.length ? (boundaries[i + 1] ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
      return item.amount >= b && item.amount < upper;
    });
    if (index < 0) index = 0;
    const stratum = strata[index];
    if (stratum) {
      stratum.items += 1;
      stratum.bookValue += item.amount;
    }
  }

  const totalBookValue = items.reduce((s, i) => s + i.amount, 0);
  // Higher-value strata get a proportionally larger sample.
  for (const stratum of strata) {
    const share = totalBookValue > 0 ? stratum.bookValue / totalBookValue : 0;
    stratum.sampleSize = Math.ceil(share * Math.max(1, Math.ceil(Math.sqrt(items.length))));
  }

  return { strata, totalBookValue, totalItems: items.length };
}

export interface MusEvaluationInput {
  /** Sampled items with their book and audited values. */
  sampleItems: { bookValue: number; auditValue: number }[];
  samplingInterval: number;
  confidence: number;
}

export interface MusEvaluation {
  knownMisstatement: number;
  projectedMisstatement: number;
  basicPrecision: number;
  upperMisstatementLimit: number;
  conclusion: "within-tolerable" | "exceeds-tolerable";
}

/** Project MUS sample misstatements to the population (SA 530.14). */
export function evaluateMusResults(input: MusEvaluationInput): MusEvaluation {
  let knownMisstatement = 0;
  let projected = 0;

  for (const item of input.sampleItems) {
    const diff = item.bookValue - item.auditValue;
    knownMisstatement += diff;
    if (item.bookValue > 0) {
      projected += (diff / item.bookValue) * input.samplingInterval;
    }
  }

  const reliabilityFactor = MUS_RELIABILITY_FACTORS[input.confidence] ?? 3.0;
  const basicPrecision = reliabilityFactor * input.samplingInterval;
  const upperMisstatementLimit = projected + basicPrecision;

  return {
    knownMisstatement,
    projectedMisstatement: Math.round(projected),
    basicPrecision: Math.round(basicPrecision),
    upperMisstatementLimit: Math.round(upperMisstatementLimit),
    conclusion:
      upperMisstatementLimit > input.samplingInterval * (reliabilityFactor + 1)
        ? "exceeds-tolerable"
        : "within-tolerable",
  };
}

export interface AnalyticalExpectationInput {
  account: string;
  /** Prior-year balance, or the independent variable the expectation is built from. */
  baseAmount: number;
  expectedChangePct: number;
  actualAmount: number;
  materialityMinor: number;
  /** Allowable variance as a % of the expectation (defaults to 10%). */
  thresholdPct?: number;
}

export interface AnalyticalExpectationResult {
  account: string;
  expectedAmount: number;
  difference: number;
  tolerance: number;
  requiresInvestigation: boolean;
  note: string;
}

/**
 * Develop an independent expectation and test it against the recorded amount
 * (SA 520). The tolerance is the greater of the account's materiality and the
 * allowable percentage of the expectation, so a small account is not
 * over-investigated and a large one is not waved through.
 */
export function developAnalyticalExpectation(input: AnalyticalExpectationInput): AnalyticalExpectationResult {
  const expectedAmount = input.baseAmount * (1 + input.expectedChangePct / 100);
  const difference = input.actualAmount - expectedAmount;
  const thresholdPct = input.thresholdPct ?? 10;
  const tolerance = Math.max(input.materialityMinor, Math.abs(expectedAmount) * (thresholdPct / 100));
  const requiresInvestigation = Math.abs(difference) > tolerance;

  return {
    account: input.account,
    expectedAmount: Math.round(expectedAmount),
    difference: Math.round(difference),
    tolerance: Math.round(tolerance),
    requiresInvestigation,
    note:
      `Expectation ${Math.round(expectedAmount)} vs actual ${input.actualAmount}; difference ${Math.round(difference)} ` +
      `(tolerance ${Math.round(tolerance)}). ${requiresInvestigation ? "Investigate." : "Within tolerance."}`,
  };
}

export interface DifferenceInvestigation {
  difference: number;
  /** The auditor's explanation of the difference. */
  explanation: string;
  /** Whether the difference proved to be a misstatement. */
  isMisstatement: boolean;
  /** Correction made, if any (paise). */
  correctionMinor?: number;
}

export interface DifferenceConclusion {
  conclusion: "no-error" | "misstatement-corrected" | "misstatement-uncorrected" | "unexplained";
  note: string;
}

/** Conclude on an analytically-identified difference (SA 520.7 / SA 450). */
export function investigateDifference(input: DifferenceInvestigation): DifferenceConclusion {
  if (!input.isMisstatement) {
    return {
      conclusion: "no-error",
      note: `Difference of ${fmtMinor(input.difference)} explained and determined not to be a misstatement: ${input.explanation}`,
    };
  }
  if ((input.correctionMinor ?? 0) !== 0) {
    return {
      conclusion: "misstatement-corrected",
      note: `Misstatement of ${fmtMinor(input.difference)} corrected by ${fmtMinor(input.correctionMinor ?? 0)}.`,
    };
  }
  return {
    conclusion: input.explanation.trim() === "" ? "unexplained" : "misstatement-uncorrected",
    note:
      input.explanation.trim() === ""
        ? `Difference of ${fmtMinor(input.difference)} remains unexplained — treat as a misstatement (SA 450/520).`
        : `Misstatement of ${fmtMinor(input.difference)} is not corrected; accumulate in the summary of uncorrected misstatements.`,
  };
}

// ===========================================================================
// 4. Workpaper system (SA 230)
// ===========================================================================

export type WorkpaperStatus = "draft" | "prepared" | "reviewed" | "cleared";
export type ReviewNoteStatus = "open" | "addressed" | "cleared";

export interface ReviewNote {
  id: string;
  raisedBy: string;
  raisedAt: string;
  text: string;
  status: ReviewNoteStatus;
  resolution: string | null;
  clearedBy: string | null;
}

export interface WorkpaperRemark {
  version: number;
  at: string;
  by: string;
  remark: string;
}

export interface Workpaper {
  ref: string;
  title: string;
  /** The SA this working paper documents, e.g. "SA 330". */
  sa: string;
  preparedBy: string;
  preparedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** Flagged for partner attention. */
  partnerFlag: boolean;
  status: WorkpaperStatus;
  crossRefs: string[];
  reviewNotes: ReviewNote[];
  remarks: WorkpaperRemark[];
  version: number;
}

export function createWorkpaper(input: {
  ref: string;
  title: string;
  sa: string;
  preparedBy: string;
  preparedAt: string;
  crossRefs?: string[];
  partnerFlag?: boolean;
}): Workpaper {
  if (!input.ref.trim()) throw new AuditAssuranceError("A working paper must have a reference.");
  return {
    ref: input.ref,
    title: input.title,
    sa: input.sa,
    preparedBy: input.preparedBy,
    preparedAt: input.preparedAt,
    reviewedBy: null,
    reviewedAt: null,
    partnerFlag: input.partnerFlag ?? false,
    status: "prepared",
    crossRefs: input.crossRefs ?? [],
    reviewNotes: [],
    remarks: [
      {
        version: 1,
        at: input.preparedAt,
        by: input.preparedBy,
        remark: `Prepared ${input.ref} (${input.sa}).`,
      },
    ],
    version: 1,
  };
}

/** Raise a review note against a working paper (SA 230.7). */
export function addReviewNote(
  workpaper: Workpaper,
  note: { id: string; raisedBy: string; raisedAt: string; text: string },
): Workpaper {
  const reviewNotes = [
    ...workpaper.reviewNotes,
    { ...note, status: "open" as ReviewNoteStatus, resolution: null, clearedBy: null },
  ];
  return { ...workpaper, reviewNotes, status: workpaper.status === "cleared" ? "reviewed" : workpaper.status };
}

/** Record the preparer's response to a review note. */
export function rectifyReviewNote(
  workpaper: Workpaper,
  noteId: string,
  resolution: string,
  resolvedBy: string,
  at: string,
): Workpaper {
  const reviewNotes = workpaper.reviewNotes.map((n) =>
    n.id === noteId ? { ...n, resolution, status: "addressed" as ReviewNoteStatus } : n,
  );
  const remarks = [
    ...workpaper.remarks,
    { version: workpaper.version + 1, at, by: resolvedBy, remark: `Addressed review note ${noteId}: ${resolution}` },
  ];
  return { ...workpaper, reviewNotes, remarks, version: workpaper.version + 1 };
}

/** Clear an addressed review note (reviewer sign-off). */
export function clearReviewNote(workpaper: Workpaper, noteId: string, clearedBy: string, at: string): Workpaper {
  const reviewNotes = workpaper.reviewNotes.map((n) =>
    n.id === noteId && n.status === "addressed" ? { ...n, status: "cleared" as ReviewNoteStatus, clearedBy } : n,
  );
  const remarks = [
    ...workpaper.remarks,
    { version: workpaper.version + 1, at, by: clearedBy, remark: `Cleared review note ${noteId}.` },
  ];
  return { ...workpaper, reviewNotes, remarks, version: workpaper.version + 1 };
}

/**
 * Reviewer sign-off. A working paper cannot be signed off while any review note
 * is still open (SA 230 requires the reviewer to be satisfied first).
 */
export function reviewWorkpaper(workpaper: Workpaper, reviewer: string, at: string): Workpaper {
  const openNotes = workpaper.reviewNotes.filter((n) => n.status === "open");
  if (openNotes.length > 0) {
    throw new AuditAssuranceError(`Cannot review ${workpaper.ref}: ${openNotes.length} review note(s) still open.`);
  }
  const remarks = [
    ...workpaper.remarks,
    { version: workpaper.version + 1, at, by: reviewer, remark: `Reviewed and signed off ${workpaper.ref}.` },
  ];
  return {
    ...workpaper,
    reviewedBy: reviewer,
    reviewedAt: at,
    status: "reviewed",
    remarks,
    version: workpaper.version + 1,
  };
}

/** Add a versioned remark without changing the review state. */
export function addRemark(workpaper: Workpaper, by: string, at: string, remark: string): Workpaper {
  const version = workpaper.version + 1;
  return {
    ...workpaper,
    version,
    remarks: [...workpaper.remarks, { version, at, by, remark }],
  };
}

export interface FileAssemblyInput {
  workpapers: Workpaper[];
  requiredRefs: string[];
}

export interface FileAssemblyResult {
  complete: boolean;
  missingRefs: string[];
  unsigned: string[];
  openReviewNotes: { ref: string; noteId: string; text: string }[];
  partnerAttention: string[];
  bySa: Record<string, number>;
}

/** Assemble the audit file and test its completeness (SA 230.13). */
export function assembleAuditFile(input: FileAssemblyInput): FileAssemblyResult {
  const byRef = new Map(input.workpapers.map((w) => [w.ref, w]));
  const missingRefs = input.requiredRefs.filter((ref) => !byRef.has(ref));
  const unsigned = input.workpapers.filter((w) => w.reviewedBy === null && w.status !== "cleared").map((w) => w.ref);
  const openReviewNotes: FileAssemblyResult["openReviewNotes"] = [];
  for (const workpaper of input.workpapers) {
    for (const note of workpaper.reviewNotes) {
      if (note.status === "open") {
        openReviewNotes.push({ ref: workpaper.ref, noteId: note.id, text: note.text });
      }
    }
  }
  const partnerAttention = input.workpapers.filter((w) => w.partnerFlag).map((w) => w.ref);
  const bySa: Record<string, number> = {};
  for (const workpaper of input.workpapers) {
    bySa[workpaper.sa] = (bySa[workpaper.sa] ?? 0) + 1;
  }

  return {
    complete: missingRefs.length === 0 && unsigned.length === 0 && openReviewNotes.length === 0,
    missingRefs,
    unsigned,
    openReviewNotes,
    partnerAttention,
    bySa,
  };
}

// ===========================================================================
// 5. Evidence linking (SA 500 / SA 505 / SA 501)
// ===========================================================================

export type EvidenceType =
  "inspection" | "observation" | "external-confirmation" | "recalculation" | "reperformance" | "analytical" | "inquiry";

export type EvidenceReliability = "high" | "medium" | "low";

export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  /** Where the evidence came from; external is more reliable than internal. */
  source: "external" | "internal" | "auditor-generated";
  reliability: EvidenceReliability;
  assertions: FinancialStatementAssertion[];
  /** The working paper the evidence is filed under. */
  workpaperRef: string;
  /** Tie-out of the evidence to the books. */
  tieOut: { bookAmount: number; agreedAmount: number; difference: number } | null;
}

export interface EvidenceGap {
  account: string;
  assertion: FinancialStatementAssertion;
  reason: string;
}

export interface EvidenceAssessment {
  sufficient: boolean;
  gaps: EvidenceGap[];
  reliabilityMix: Record<EvidenceReliability, number>;
  byType: Record<string, number>;
  byWorkpaper: Record<string, number>;
}

/**
 * Test whether the evidence obtained is sufficient and appropriate for the
 * significant risks identified. A significant risk is unsupported when no
 * medium/high-reliability evidence covers its assertion.
 */
export function evaluateEvidenceSufficiency(
  evidence: EvidenceItem[],
  significantRisks: { account: string; assertion: FinancialStatementAssertion }[],
): EvidenceAssessment {
  const reliabilityMix: Record<EvidenceReliability, number> = { high: 0, medium: 0, low: 0 };
  const byType: Record<string, number> = {};
  const byWorkpaper: Record<string, number> = {};

  for (const item of evidence) {
    reliabilityMix[item.reliability] += 1;
    byType[item.type] = (byType[item.type] ?? 0) + 1;
    byWorkpaper[item.workpaperRef] = (byWorkpaper[item.workpaperRef] ?? 0) + 1;
  }

  const gaps: EvidenceGap[] = [];
  for (const risk of significantRisks) {
    const supporting = evidence.filter(
      (e) =>
        e.assertions.includes(risk.assertion) &&
        (e.reliability === "high" || e.reliability === "medium") &&
        (e.tieOut === null || e.tieOut.difference === 0),
    );
    if (supporting.length === 0) {
      gaps.push({
        account: risk.account,
        assertion: risk.assertion,
        reason: `No sufficient appropriate evidence for the significant risk on ${risk.account}/${risk.assertion}.`,
      });
    }
  }

  return { sufficient: gaps.length === 0, gaps, reliabilityMix, byType, byWorkpaper };
}

export interface ConfirmationRequest {
  id: string;
  payee: string;
  account: string;
  requestedAmount: number;
  assertion: FinancialStatementAssertion;
  sentAt: string;
}

export interface ConfirmationResponse {
  requestId: string;
  respondedAt: string;
  confirmedAmount: number;
  exception?: string | null;
}

export interface ConfirmationReconciliation {
  requestId: string;
  status: "confirmed" | "exception" | "no-response";
  difference: number;
  note: string;
}

/**
 * Reconcile an external confirmation against the requested balance (SA 505).
 * A non-zero difference or a stated exception is an exception to investigate;
 * an unreturned request is a no-response that may require alternative
 * procedures.
 */
export function reconcileExternalConfirmation(
  request: ConfirmationRequest,
  response: ConfirmationResponse | null,
): ConfirmationReconciliation {
  if (response === null) {
    return {
      requestId: request.id,
      status: "no-response",
      difference: request.requestedAmount,
      note: `No response to confirmation ${request.id} from ${request.payee}; perform alternative procedures (SA 505.12).`,
    };
  }
  const difference = response.confirmedAmount - request.requestedAmount;
  if (difference !== 0 || (response.exception ?? "").trim() !== "") {
    return {
      requestId: request.id,
      status: "exception",
      difference,
      note:
        `Confirmation ${request.id} exception on ${request.account}: requested ${fmtMinor(request.requestedAmount)}, ` +
        `confirmed ${fmtMinor(response.confirmedAmount)}` +
        `${response.exception ? `; ${response.exception}` : ""}.`,
    };
  }
  return {
    requestId: request.id,
    status: "confirmed",
    difference: 0,
    note: `Confirmation ${request.id} from ${request.payee} agrees for ${request.assertion}.`,
  };
}

/** Note a physical stock/asset inspection (SA 501). */
export function stockInspectionNote(input: {
  location: string;
  date: string;
  countedBy: string;
  bookQuantity: number;
  countedQuantity: number;
  conditionNotes?: string[];
}): { difference: number; note: string } {
  const difference = input.countedQuantity - input.bookQuantity;
  return {
    difference,
    note:
      `Stock inspection at ${input.location} on ${input.date} by ${input.countedBy}: book ${input.bookQuantity}, ` +
      `counted ${input.countedQuantity}, difference ${difference}` +
      `${input.conditionNotes && input.conditionNotes.length > 0 ? `; condition: ${input.conditionNotes.join("; ")}` : ""}.`,
  };
}

/** Note legal/litigation correspondence received (SA 501 / SA 502). */
export function legalCorrespondenceNote(input: {
  correspondent: string;
  receivedAt: string;
  matters: string[];
  estimatedLiability?: number | null;
}): { requiresProvisionReview: boolean; note: string } {
  const requiresProvisionReview = input.matters.length > 0;
  return {
    requiresProvisionReview,
    note:
      `Legal correspondence from ${input.correspondent} received ${input.receivedAt}: ${input.matters.join("; ") || "no matters reported"}` +
      `${input.estimatedLiability != null ? `; estimated liability ${fmtMinor(input.estimatedLiability)}` : ""}.`,
  };
}

// ===========================================================================
// 6. Reporting (SA 700 / 701 / 705 / 706 / 260 / 265)
// ===========================================================================

export type ReportOpinion = "unqualified" | "qualified" | "adverse" | "disclaimer";

export interface ReportInput {
  entityName: string;
  financialYear: string;
  framework: string;
  uncorrectedMisstatementsMinor: number;
  materialityMinor: number;
  evidenceSufficient: boolean;
  cause: "misstatement" | "scope-limitation" | "none";
  pervasiveness: "not-pervasive" | "pervasive";
  goingConcern?: { materialUncertainty: boolean; appropriatelyDisclosed: boolean } | null;
  keyAuditMatters?: { title: string; description: string; response: string }[];
  emphasisOfMatter?: string[];
  otherMatter?: string[];
  /** Matters communicated to those charged with governance (SA 260). */
  tcwgMatters?: string[];
}

export interface AuditReport {
  opinion: ReportOpinion;
  opinionParagraph: string;
  basisParagraph: string;
  requiresKeyAuditMatters: boolean;
  requiresEmphasisOfMatter: boolean;
  sections: { heading: string; body: string }[];
  communicationWithTcwg: string[];
  decisionTrace: string[];
}

/**
 * Form the opinion (SA 705 decision table) and draft the report sections
 * (SA 700/701/706). The decision table is:
 *   misstatement, material, not pervasive → qualified
 *   misstatement, material, pervasive     → adverse
 *   scope limitation, material, not pervasive → qualified
 *   scope limitation, material, pervasive     → disclaimer
 *   otherwise (no cause, sufficient evidence) → unqualified
 */
export function draftAuditReport(input: ReportInput): AuditReport {
  if (input.materialityMinor <= 0) throw new AuditAssuranceError("Materiality must be positive.");

  const material = input.uncorrectedMisstatementsMinor >= input.materialityMinor;
  const pervasive = input.pervasiveness === "pervasive";
  const trace: string[] = [
    `Uncorrected misstatements ${fmtMinor(input.uncorrectedMisstatementsMinor)} vs materiality ${fmtMinor(input.materialityMinor)} => material = ${material}.`,
    `Cause: ${input.cause}; pervasiveness: ${input.pervasiveness}; sufficient appropriate evidence: ${input.evidenceSufficient}.`,
  ];

  let opinion: ReportOpinion;
  if (input.cause === "none" && input.evidenceSufficient) {
    opinion = "unqualified";
    trace.push("No material misstatement or scope limitation with sufficient evidence => unmodified opinion.");
  } else if (input.cause === "misstatement") {
    opinion = pervasive ? "adverse" : "qualified";
    trace.push(
      pervasive
        ? "Material and pervasive misstatement => adverse opinion."
        : "Material, not pervasive misstatement => qualified opinion.",
    );
  } else {
    opinion = pervasive ? "disclaimer" : "qualified";
    trace.push(
      pervasive
        ? "Material and pervasive scope limitation => disclaimer of opinion."
        : "Material, not pervasive scope limitation => qualified opinion.",
    );
  }

  const opinionParagraphs: Record<ReportOpinion, string> = {
    unqualified:
      `In our opinion, the financial statements of ${input.entityName} for the year ended ${input.financialYear} give a true and fair view ` +
      `in accordance with ${input.framework}.`,
    qualified:
      `In our opinion, except for the effects of the matter described in the Basis for Qualified Opinion section, the financial statements of ` +
      `${input.entityName} for the year ended ${input.financialYear} give a true and fair view in accordance with ${input.framework}.`,
    adverse:
      `In our opinion, because of the significance of the matter described in the Basis for Adverse Opinion section, the financial statements of ` +
      `${input.entityName} for the year ended ${input.financialYear} do not give a true and fair view in accordance with ${input.framework}.`,
    disclaimer:
      `Because of the significance of the matter described in the Basis for Disclaimer of Opinion section, we have not been able to obtain sufficient ` +
      `appropriate evidence to provide a basis for an audit opinion on the financial statements of ${input.entityName} for the year ended ${input.financialYear}. ` +
      `Accordingly, we do not express an opinion on those financial statements.`,
  };

  const builds: string[] = [];
  if (input.cause !== "none") {
    builds.push(
      input.cause === "misstatement"
        ? `The financial statements contain uncorrected misstatements of ${fmtMinor(input.uncorrectedMisstatementsMinor)}, exceeding materiality of ${fmtMinor(input.materialityMinor)}.`
        : `We were unable to obtain sufficient appropriate audit evidence over the matter described, which is material to the financial statements.`,
    );
  } else {
    builds.push(
      `We conducted our audit in accordance with the Standards on Auditing and obtained sufficient appropriate evidence.`,
    );
  }

  const requiresEmphasisOfMatter =
    Boolean(input.goingConcern?.materialUncertainty) || (input.emphasisOfMatter?.length ?? 0) > 0;
  const requiresKeyAuditMatters = (input.keyAuditMatters?.length ?? 0) > 0 || opinion !== "unqualified";

  const sections: { heading: string; body: string }[] = [
    { heading: "Opinion", body: opinionParagraphs[opinion] },
    { heading: "Basis for Opinion", body: builds.join(" ") },
  ];
  if (requiresEmphasisOfMatter) {
    const eom = [...(input.emphasisOfMatter ?? [])];
    if (input.goingConcern?.materialUncertainty) {
      eom.push(
        input.goingConcern.appropriatelyDisclosed
          ? "We draw attention to the material uncertainty related to going concern, which is appropriately disclosed."
          : "A material uncertainty exists regarding going concern and is not adequately disclosed.",
      );
    }
    sections.push({ heading: "Emphasis of Matter", body: eom.join(" ") });
  }
  if (requiresKeyAuditMatters && input.keyAuditMatters && input.keyAuditMatters.length > 0) {
    sections.push({
      heading: "Key Audit Matters",
      body: input.keyAuditMatters.map((k) => `${k.title}: ${k.description} (Response: ${k.response})`).join(" "),
    });
  }
  if (input.otherMatter && input.otherMatter.length > 0) {
    sections.push({ heading: "Other Matter", body: input.otherMatter.join(" ") });
  }

  const communicationWithTcwg = [
    "The auditor's responsibilities in relation to the financial statement audit.",
    "The planned scope and timing of the audit.",
    "Significant findings from the audit, including significant deficiencies in internal control (SA 265).",
    "Significant difficulties encountered during the audit.",
    "Matters significant to the oversight of the financial reporting process.",
    ...(input.tcwgMatters ?? []),
  ];

  return {
    opinion,
    opinionParagraph: opinionParagraphs[opinion],
    basisParagraph: builds.join(" "),
    requiresKeyAuditMatters,
    requiresEmphasisOfMatter,
    sections,
    communicationWithTcwg,
    decisionTrace: trace,
  };
}

export interface DeficiencyInput {
  description: string;
  likelihoodOfMisstatement: "remote" | "possible" | "probable";
  magnitude: "immaterial" | "material" | "significant";
  isEntityLevelOrIt: boolean;
}

/** Classify a control deficiency for the management letter (SA 265). */
export function classifyControlDeficiency(input: DeficiencyInput): {
  type: "deficiency" | "significant-deficiency" | "material-weakness";
  rationale: string;
} {
  if (input.magnitude === "significant" && input.likelihoodOfMisstatement === "probable") {
    return {
      type: "material-weakness",
      rationale: "Probable misstatement of significant magnitude — the deficiency is a material weakness.",
    };
  }
  if (
    input.magnitude === "material" ||
    input.likelihoodOfMisstatement === "probable" ||
    (input.isEntityLevelOrIt && input.likelihoodOfMisstatement === "possible")
  ) {
    return {
      type: "significant-deficiency",
      rationale: "Material magnitude or probable likelihood (or an entity-level/IT control) — significant deficiency.",
    };
  }
  return { type: "deficiency", rationale: "Below the significant-deficiency threshold — report to management." };
}

export interface ManagementLetterInput {
  entityName: string;
  financialYear: string;
  deficiencies: DeficiencyInput[];
}

/** Draft the management letter from the classified deficiencies (SA 265). */
export function draftManagementLetter(input: ManagementLetterInput): {
  sections: { heading: string; body: string }[];
  materialWeaknesses: number;
  significantDeficiencies: number;
  requireTcwgCommunication: boolean;
} {
  const classified = input.deficiencies.map((d) => ({ ...d, ...classifyControlDeficiency(d) }));
  const materialWeaknesses = classified.filter((d) => d.type === "material-weakness");
  const significantDeficiencies = classified.filter((d) => d.type === "significant-deficiency");
  const others = classified.filter((d) => d.type === "deficiency");

  const sections = [
    {
      heading: "Purpose",
      body: `This letter reports matters arising from our audit of ${input.entityName} for the year ended ${input.financialYear}. It is intended solely for management and those charged with governance.`,
    },
    {
      heading: "Material weaknesses",
      body:
        materialWeaknesses.length > 0
          ? materialWeaknesses.map((d) => `${d.description} — ${d.rationale}`).join(" ")
          : "None identified.",
    },
    {
      heading: "Significant deficiencies",
      body:
        significantDeficiencies.length > 0
          ? significantDeficiencies.map((d) => `${d.description} — ${d.rationale}`).join(" ")
          : "None identified.",
    },
    {
      heading: "Other deficiencies",
      body: others.length > 0 ? others.map((d) => `${d.description} — ${d.rationale}`).join(" ") : "None identified.",
    },
  ];

  return {
    sections,
    materialWeaknesses: materialWeaknesses.length,
    significantDeficiencies: significantDeficiencies.length,
    requireTcwgCommunication: materialWeaknesses.length + significantDeficiencies.length > 0,
  };
}

/** Determine which matters must be communicated to those charged with governance. */
export function requireTcwgCommunication(matters: {
  significantDeficiencies?: string[];
  fraudOrSuspectedFraud?: string[];
  significantRelatedPartyTransactions?: string[];
  significantGoingConcernUncertainty?: boolean;
  disagreementsWithManagement?: string[];
  otherSignificantFindings?: string[];
}): { required: boolean; items: string[] } {
  const items: string[] = [];
  if ((matters.significantDeficiencies?.length ?? 0) > 0)
    items.push("Significant deficiencies in internal control (SA 265).");
  if ((matters.fraudOrSuspectedFraud?.length ?? 0) > 0)
    items.push("Fraud or suspected fraud involving management/those charged with governance (SA 240/260).");
  if ((matters.significantRelatedPartyTransactions?.length ?? 0) > 0)
    items.push("Significant related-party transactions (SA 550/260).");
  if (matters.significantGoingConcernUncertainty) items.push("Significant going-concern uncertainty (SA 570/260).");
  if ((matters.disagreementsWithManagement?.length ?? 0) > 0)
    items.push("Disagreements with management, if not resolved (SA 260).");
  if ((matters.otherSignificantFindings?.length ?? 0) > 0)
    items.push("Other significant findings from the audit (SA 260).");
  return { required: items.length > 0, items };
}

// ===========================================================================
// 7. Additional gap closures
// ===========================================================================

// ---- Scope documentation: the engagement letter (SA 210) -----------------

export interface EngagementLetterInput {
  addressee: string;
  entityName: string;
  financialYear: string;
  /** Areas/standards the engagement covers, e.g. "Statutory audit under the Companies Act 2013". */
  scope: string[];
  responsibilitiesManagement: string[];
  responsibilitiesAuditor: string[];
  fees: string;
  reportingDeadline: string;
  otherMatters?: string[];
}

/** Render the engagement letter that documents scope before work begins (SA 210). */
export function renderEngagementLetter(input: EngagementLetterInput): string {
  const bullet = (items: string[]) => (items.length > 0 ? items.map((i) => `  - ${i}`) : ["  - None."]);
  return [
    `[Firm letterhead]`,
    ``,
    `To: ${input.addressee}`,
    `Re: Audit engagement — ${input.entityName}, financial year ${input.financialYear}`,
    ``,
    `Dear Sir/Madam,`,
    ``,
    `Thank you for appointing us. This letter confirms the terms of our engagement and the scope of our work.`,
    ``,
    `1. Scope of the engagement:`,
    ...bullet(input.scope),
    ``,
    `2. Responsibilities of management:`,
    ...bullet(input.responsibilitiesManagement),
    ``,
    `3. Our responsibilities:`,
    ...bullet(input.responsibilitiesAuditor),
    ``,
    `4. Fees: ${input.fees}`,
    `5. Reporting deadline: ${input.reportingDeadline}`,
    ...(input.otherMatters && input.otherMatters.length > 0
      ? [``, `6. Other matters:`, ...bullet(input.otherMatters)]
      : []),
    ``,
    `Please sign and return the enclosed copy to confirm your agreement.`,
    ``,
    `Yours faithfully,`,
    `_____________________________`,
    `[Firm name]`,
  ].join("\n");
}

// ---- Signed assertions (management's assertion sign-off) -----------------

export interface SignedAssertion {
  account: string;
  assertion: FinancialStatementAssertion;
  signedBy: string;
  signedAt: string;
}

export interface SignedAssertionResult {
  covered: SignedAssertion[];
  missing: { account: string; assertion: FinancialStatementAssertion }[];
  complete: boolean;
}

/**
 * Record management's signed assertions against the assertions the audit
 * planned to cover, and report what is still unsigned. A signed assertion is
 * the artefact that ties management's representation to a specific account and
 * assertion rather than one blanket letter.
 */
export function recordSignedAssertions(
  required: { account: string; assertion: FinancialStatementAssertion }[],
  signed: SignedAssertion[],
): SignedAssertionResult {
  const key = (a: { account: string; assertion: FinancialStatementAssertion }) => `${a.account}::${a.assertion}`;
  const signedKeys = new Set(signed.map(key));
  const missing = required.filter((r) => !signedKeys.has(key(r)));
  return {
    covered: signed.filter((s) => required.some((r) => key(r) === key(s))),
    missing,
    complete: missing.length === 0,
  };
}

// ---- IT-dependent controls: IT general controls (SA 315) -----------------

export type ItgcDomain = "access" | "change-management" | "operations" | "backup-recovery";

export interface ItgcControl {
  domain: ItgcDomain;
  description: string;
  /** Whether the control was tested as designed. */
  tested: boolean;
  effective: boolean;
}

export interface ItgcAssessment {
  byDomain: Record<ItgcDomain, { total: number; tested: number; effective: number }>;
  fullyEffective: boolean;
  weaknesses: string[];
}

/** Assess IT general controls over the systems that produce the financial data. */
export function assessItGeneralControls(controls: ItgcControl[]): ItgcAssessment {
  const domains: ItgcDomain[] = ["access", "change-management", "operations", "backup-recovery"];
  const byDomain = {} as ItgcAssessment["byDomain"];
  for (const domain of domains) {
    byDomain[domain] = { total: 0, tested: 0, effective: 0 };
  }
  const weaknesses: string[] = [];
  for (const control of controls) {
    const bucket = byDomain[control.domain];
    bucket.total += 1;
    if (control.tested) bucket.tested += 1;
    if (control.effective) bucket.effective += 1;
    else weaknesses.push(`${control.domain}: ${control.description}`);
  }
  return { byDomain, fullyEffective: weaknesses.length === 0, weaknesses };
}

// ---- Evidence: bank confirmation flow (SA 505) ---------------------------

export interface BankConfirmationRequest {
  bank: string;
  accountNumber: string;
  asOf: string;
  requestedBalance: number;
  requestedLienAmount?: number;
}

export interface BankConfirmationReply {
  respondedAt: string;
  confirmedBalance: number;
  confirmedLienAmount?: number;
  exception?: string | null;
}

export interface BankConfirmationReconciliation {
  status: "confirmed" | "exception" | "no-response";
  balanceDifference: number;
  lienDifference: number;
  note: string;
}

/**
 * Reconcile a bank balance/lien confirmation to the books (SA 505). A bank
 * confirmation is a high-reliability, external, auditor-obtained procedure:
 * a difference, an undisclosed lien or silence all require follow-up.
 */
export function reconcileBankConfirmation(
  request: BankConfirmationRequest,
  reply: BankConfirmationReply | null,
): BankConfirmationReconciliation {
  if (reply === null) {
    return {
      status: "no-response",
      balanceDifference: request.requestedBalance,
      lienDifference: request.requestedLienAmount ?? 0,
      note: `No confirmation received from ${request.bank} for a/c ${request.accountNumber} as at ${request.asOf}; perform alternative procedures.`,
    };
  }
  const balanceDifference = reply.confirmedBalance - request.requestedBalance;
  const lienDifference = (reply.confirmedLienAmount ?? 0) - (request.requestedLienAmount ?? 0);
  const exceptionText = (reply.exception ?? "").trim();
  if (balanceDifference !== 0 || lienDifference !== 0 || exceptionText !== "") {
    return {
      status: "exception",
      balanceDifference,
      lienDifference,
      note:
        `Bank confirmation exception for ${request.bank} a/c ${request.accountNumber}: book ${fmtMinor(request.requestedBalance)} ` +
        `vs confirmed ${fmtMinor(reply.confirmedBalance)} (difference ${fmtMinor(balanceDifference)}); ` +
        `lien difference ${fmtMinor(lienDifference)}` +
        `${exceptionText ? `; ${exceptionText}` : ""}.`,
    };
  }
  return {
    status: "confirmed",
    balanceDifference: 0,
    lienDifference: 0,
    note: `Bank confirmation from ${request.bank} agrees for a/c ${request.accountNumber} as at ${request.asOf}.`,
  };
}

// ---- Evidence: management inquiries (SA 500.A31 / SA 580) ----------------

export interface ManagementInquiryInput {
  inquiredOf: string;
  role: string;
  date: string;
  topics: string[];
  responses: string[];
}

/**
 * Record a management inquiry. Inquiry alone is not sufficient appropriate
 * evidence, so the note always flags that corroboration is required
 * (SA 500.A31); a topic without a recorded response is left explicitly open.
 */
export function managementInquiryNote(input: ManagementInquiryInput): {
  note: string;
  requiresCorroboration: boolean;
  openTopics: string[];
} {
  const paired = input.topics.map((topic, i) => `${topic}: ${input.responses[i] ?? "[no response recorded]"}`);
  const openTopics = input.topics.filter((_, i) => !input.responses[i] || input.responses[i]!.trim() === "");
  return {
    note:
      `Management inquiry of ${input.inquiredOf} (${input.role}) on ${input.date}: ` +
      `${paired.join("; ") || "no topics recorded"}.`,
    requiresCorroboration: true,
    openTopics,
  };
}

// ---- Reporting: reportable conditions summary (SA 265) ------------------

export interface ReportableConditionsSummary {
  reportable: { description: string; type: ControlDeficiency["type"] }[];
  count: number;
  requireTcwgCommunication: boolean;
  note: string;
}

/** Summarise the conditions reportable to management / those charged with governance (SA 265). */
export function summarizeReportableConditions(deficiencies: DeficiencyInput[]): ReportableConditionsSummary {
  const reportable = deficiencies
    .map((d) => ({ description: d.description, type: classifyControlDeficiency(d).type }))
    .filter((d) => d.type !== "deficiency");
  return {
    reportable,
    count: reportable.length,
    requireTcwgCommunication: reportable.length > 0,
    note:
      reportable.length > 0
        ? `${reportable.length} condition(s) reportable to those charged with governance (SA 265).`
        : "No reportable conditions identified.",
  };
}
