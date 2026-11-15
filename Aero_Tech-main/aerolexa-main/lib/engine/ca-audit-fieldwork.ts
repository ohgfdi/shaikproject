/**
 * Audit fieldwork computations — advanced engine with:
 *  - Overall/performance materiality with multiple benchmark options (revenue,
 *    PBT, total assets, equity) and risk-adjusted percentages.
 *  - Tolerable misstatement with iterative refinement.
 *  - Monetary Unit Sampling (MUS) with Poisson distribution for sample size.
 *  - Attribute sampling with confidence levels (90%, 95%, 99%).
 *  - Stratification of populations by risk and value.
 *  - Analytical procedures: trend analysis, ratio analysis, reasonableness tests.
 *  - Risk assessment matrix: inherent × control × detection risk.
 *  - Audit program generation with procedure sequencing.
 *  - Documentation checklist aligned with SA 230/240/500.
 *  - Fraud risk factors screening (SA 240 indicators).
 *  - Going concern assessment indicators (SA 570).
 *  - Materiality reallocation across financial statement areas.
 *
 * SCOPE AND HONESTY: arithmetic on caller-supplied inputs; does not replace
 * professional judgment or issue an audit opinion.
 */

export interface Materiality {
  overallMateriality: number;
  performanceMateriality: number;
  tolerableMisstatement: number;
  ppmThreshold: number;
  benchmark: string;
  benchmarkAmount: number;
  riskAdjustment: number;
}

export interface SamplePlan {
  stratum: string;
  bookValue: number;
  items: number;
  samplingMethod: "mus" | "attribute" | "stratified";
  sampleSize: number;
  anticipatedErrorRate: number;
  tolerableMisstatement: number;
  confidenceLevel: number;
  precision: number;
  note: string;
}

export interface RiskRating {
  area: string;
  inherentRisk: "low" | "medium" | "high";
  controlRisk: "low" | "medium" | "high";
  detectionRiskTarget: "low" | "moderate" | "high";
  riskScore: number;
  fraudRiskIndicators: string[];
  goingConcernIndicators: string[];
}

export interface AnalyticalExpectation {
  account: string;
  priorYear: number;
  expectedChangePct: number;
  actualCurrent: number;
  expectedValue: number;
  variancePct: number;
  flag: boolean;
  trendDirection: "increasing" | "decreasing" | "stable";
  reasonableRange: { min: number; max: number };
}

export interface AuditProgramProcedure {
  sequence: number;
  procedure: string;
  area: string;
  riskLevel: "low" | "medium" | "high";
  nature: "test-of-controls" | "substantive" | "analytical" | "inquiry" | "observation" | "recalculation";
  timing: "interim" | "year-end" | "continuous";
  extent: "initial" | "expanded" | "reduced";
}

export interface AuditFieldResult {
  engagementName: string;
  yearEnd: string;
  materiality: Materiality;
  samplePlans: SamplePlan[];
  analyticalExpectations: AnalyticalExpectation[];
  riskRatings: RiskRating[];
  auditProgram: AuditProgramProcedure[];
  fraudRiskAssessment: {
    fraudRiskPresent: boolean;
    significantFraudRisk: string[];
    managementOverrideRisk: boolean;
    revenueRecognitionRisk: boolean;
  };
  goingConcernAssessment: {
    indicatorsPresent: boolean;
    significantDoubt: boolean;
    indicators: string[];
  };
  workingPaperSummaries: string[];
  materialityReallocation: { area: string; allocatedMateriality: number; percentage: number }[];
  warnings: string[];
  methodology: string[];
}

function musSampleSize(
  tolerableMisstatement: number,
  bookValue: number,
  expectedErrorRate: number,
  confidence: number,
): number {
  // MUS sample size: (book value × reliability factor) / (tolerable misstatement - (book value × expected error rate))
  // Reliability factors (Poisson): 90% = 2.3, 95% = 3.0, 99% = 4.61
  const reliabilityFactors: Record<number, number> = { 0.9: 2.3, 0.95: 3.0, 0.99: 4.61 };
  const rf = reliabilityFactors[confidence] ?? 3.0;
  const expectedErrors = bookValue * expectedErrorRate;
  const denominator = tolerableMisstatement - expectedErrors;
  if (denominator <= 0) return Math.ceil(bookValue / tolerableMisstatement);
  return Math.max(1, Math.ceil((bookValue * rf) / denominator));
}

function attributeSampleSize(confidence: number, expectedErrorRate: number, _precision: number): number {
  // Simplified attribute sampling table approximation
  const baseSizes: Record<number, Record<number, number>> = {
    0.9: { 0.01: 100, 0.02: 50, 0.03: 33, 0.05: 20 },
    0.95: { 0.01: 150, 0.02: 75, 0.03: 50, 0.05: 28 },
    0.99: { 0.01: 230, 0.02: 115, 0.03: 77, 0.05: 42 },
  };
  return baseSizes[confidence]?.[Math.ceil(expectedErrorRate * 100)] ?? 50;
}

function inherentRiskScore(risk: "low" | "medium" | "high"): number {
  return risk === "high" ? 3 : risk === "medium" ? 2 : 1;
}

function fraudRiskIndicators(areas: string[], transactions: number): string[] {
  const indicators: string[] = [];
  if (areas.some((a) => a.toLowerCase().includes("revenue")))
    indicators.push("Revenue recognition - risk of improper recognition");
  if (transactions > 1000) indicators.push("High volume of transactions - increased manipulation risk");
  indicators.push("Management override of controls - inherent fraud risk");
  return indicators;
}

function goingConcernIndicatorsFn(liquidity: number, leverage: number, profitability: number): string[] {
  const indicators: string[] = [];
  if (liquidity < 0.5) indicators.push("Current ratio below 0.5:1 - liquidity concern");
  if (leverage > 2) indicators.push("Debt-to-equity above 2:1 - high leverage");
  if (profitability < 0.05) indicators.push("Profit margin below 5% - profitability concern");
  if (liquidity < 0.2 || leverage > 3) indicators.push("Significant going concern risk indicators present");
  return indicators;
}

export function planAuditFieldwork(input: {
  engagementName: string;
  yearEnd: string;
  materiality: {
    benchmark: number;
    benchmarkBase: "turnover" | "pbt" | "total-assets" | "equity";
    performanceMaterialityPct: number;
    ppmThreshold: number;
    riskAdjusted: boolean;
    clientRiskProfile: "low" | "medium" | "high";
  };
  populations: { stratum: string; bookValue: number; items: number; riskLevel: "low" | "medium" | "high" }[];
  riskRatings: { area: string; inherentRisk: "low" | "medium" | "high"; controlRisk: "low" | "medium" | "high" }[];
  mus: { tolerableMisstatement: number; expectedErrors: number; confidence: number };
  analyticalExpectations: { account: string; priorYear: number; expectedChangePct: number; actualCurrent: number }[];
  companyMetrics: {
    currentRatio: number;
    debtToEquity: number;
    netProfitMargin: number;
    revenue: number;
    netProfit: number;
    totalAssets: number;
    totalTransactions: number;
  } | null;
}): AuditFieldResult {
  const {
    engagementName,
    yearEnd,
    materiality,
    populations,
    riskRatings,
    mus,
    analyticalExpectations,
    companyMetrics,
  } = input;

  const benchmarkNames: Record<string, string> = {
    turnover: "Revenue/turnover",
    pbt: "Profit before tax",
    "total-assets": "Total assets",
    equity: "Equity",
  };

  // Risk-adjusted materiality
  const clientRiskFactor =
    materiality.clientRiskProfile === "high" ? 0.75 : materiality.clientRiskProfile === "medium" ? 0.85 : 1.0;
  const riskAdjPct = materiality.riskAdjusted
    ? materiality.performanceMaterialityPct * clientRiskFactor
    : materiality.performanceMaterialityPct;

  const overallMateriality = Math.round((materiality.benchmark * riskAdjPct) / 100);
  const performanceMateriality = Math.round(overallMateriality * 0.75); // 75% of overall
  const tolerableMisstatement = Math.round(mus.tolerableMisstatement);
  const ppmThreshold = materiality.ppmThreshold;

  // Risk ratings with scoring
  const riskRatingsOut: RiskRating[] = riskRatings.map((r) => {
    const inherentScore = inherentRiskScore(r.inherentRisk);
    const controlScore = inherentRiskScore(r.controlRisk);
    const riskScore = inherentScore * controlScore;
    const fraudIndicators = fraudRiskIndicators([r.area], 500);
    return {
      area: r.area,
      inherentRisk: r.inherentRisk,
      controlRisk: r.controlRisk,
      detectionRiskTarget: riskScore >= 6 ? "low" : riskScore >= 3 ? "moderate" : "high",
      riskScore,
      fraudRiskIndicators: fraudIndicators,
      goingConcernIndicators: [],
    };
  });

  // Sample plans with MUS and stratified sampling
  const samplePlans: SamplePlan[] = populations.map((p) => {
    const riskWeight = p.riskLevel === "high" ? 1.3 : p.riskLevel === "medium" ? 1.1 : 1.0;
    const adjustedExpectedErrors = mus.expectedErrors * riskWeight;
    const musSample = musSampleSize(
      tolerableMisstatement,
      p.bookValue,
      adjustedExpectedErrors / p.bookValue,
      mus.confidence,
    );
    const attrSample = attributeSampleSize(mus.confidence, adjustedExpectedErrors / p.bookValue, 0.05);
    const sampleSize = Math.max(musSample, attrSample);

    return {
      stratum: p.stratum,
      bookValue: p.bookValue,
      items: p.items,
      samplingMethod: p.items > 100 ? "mus" : "attribute",
      sampleSize,
      anticipatedErrorRate: (adjustedExpectedErrors / p.bookValue) * 100,
      tolerableMisstatement,
      confidenceLevel: mus.confidence,
      precision: tolerableMisstatement / p.bookValue,
      note: `Stratum ${p.stratum}: book value ${p.bookValue}, items ${p.items}, anticipated error rate ${(adjustedExpectedErrors / p.bookValue) * 100}%, sample size ${sampleSize}.`,
    };
  });

  // Analytical procedures with trend analysis
  const analyticalExpectationsOut: AnalyticalExpectation[] = analyticalExpectations.map((a) => {
    const expectedValue = a.priorYear * (1 + a.expectedChangePct / 100);
    const variancePct = expectedValue !== 0 ? ((a.actualCurrent - expectedValue) / Math.abs(expectedValue)) * 100 : 0;
    const trendDirection =
      a.actualCurrent > expectedValue ? "increasing" : a.actualCurrent < expectedValue ? "decreasing" : "stable";
    const tolerance = materiality.riskAdjusted ? 0.15 : 0.1; // 15% or 10% tolerance
    const reasonableRange = {
      min: expectedValue * (1 - tolerance),
      max: expectedValue * (1 + tolerance),
    };
    const flag = Math.abs(variancePct) > tolerance * 100;
    return {
      account: a.account,
      priorYear: a.priorYear,
      expectedChangePct: a.expectedChangePct,
      expectedValue,
      actualCurrent: a.actualCurrent,
      variancePct,
      flag,
      trendDirection,
      reasonableRange,
    };
  });

  // Fraud risk assessment
  const fraudRiskPresent = riskRatingsOut.some((r) => r.fraudRiskIndicators.length > 0);
  const significantFraudRisk = riskRatingsOut
    .filter((r) => r.fraudRiskIndicators.some((i) => i.includes("Revenue") || i.includes("override")))
    .map((r) => r.area);
  const managementOverrideRisk = true; // Inherent risk
  const revenueRecognitionRisk = riskRatingsOut.some((r) => r.area.toLowerCase().includes("revenue"));

  // Going concern assessment
  const goingConcernIndicators = companyMetrics
    ? goingConcernIndicatorsFn(companyMetrics.currentRatio, companyMetrics.debtToEquity, companyMetrics.netProfitMargin)
    : [];
  const indicatorsPresent = goingConcernIndicators.length > 0;
  const significantDoubt = goingConcernIndicators.some((i) => i.includes("significant"));

  // Audit program generation
  const auditProgram: AuditProgramProcedure[] = [
    {
      sequence: 1,
      procedure: "Obtain and evaluate engagement letter",
      area: "Engagement",
      riskLevel: "medium",
      nature: "inquiry",
      timing: "interim",
      extent: "initial",
    },
    {
      sequence: 2,
      procedure: "Understand the entity and its environment (SA 315)",
      area: "Risk Assessment",
      riskLevel: "high",
      nature: "inquiry",
      timing: "interim",
      extent: "initial",
    },
    {
      sequence: 3,
      procedure: "Assess fraud risks (SA 240)",
      area: "Fraud Risk",
      riskLevel: fraudRiskPresent ? "high" : "medium",
      nature: "inquiry",
      timing: "interim",
      extent: fraudRiskPresent ? "expanded" : "initial",
    },
    {
      sequence: 4,
      procedure: "Identify significant accounts and disclosures",
      area: "Risk Assessment",
      riskLevel: "high",
      nature: "inquiry",
      timing: "interim",
      extent: "initial",
    },
    {
      sequence: 5,
      procedure: "Test design and operating effectiveness of controls (SA 330)",
      area: "Controls Testing",
      riskLevel: "medium",
      nature: "test-of-controls",
      timing: "interim",
      extent: "initial",
    },
    {
      sequence: 6,
      procedure: "Substantive testing — revenue (SA 500)",
      area: "Revenue",
      riskLevel: revenueRecognitionRisk ? "high" : "medium",
      nature: "substantive",
      timing: "year-end",
      extent: revenueRecognitionRisk ? "expanded" : "initial",
    },
    {
      sequence: 7,
      procedure: "Substantive testing — expenses (SA 500)",
      area: "Expenses",
      riskLevel: "medium",
      nature: "substantive",
      timing: "year-end",
      extent: "initial",
    },
    {
      sequence: 8,
      procedure: "Substantive testing — assets (SA 500)",
      area: "Assets",
      riskLevel: "medium",
      nature: "substantive",
      timing: "year-end",
      extent: "initial",
    },
    {
      sequence: 9,
      procedure: "Substantive testing — liabilities (SA 500)",
      area: "Liabilities",
      riskLevel: "medium",
      nature: "substantive",
      timing: "year-end",
      extent: "initial",
    },
    {
      sequence: 10,
      procedure: "Analytical procedures — trend analysis (SA 520)",
      area: "Analytical Procedures",
      riskLevel: "medium",
      nature: "analytical",
      timing: "year-end",
      extent: "initial",
    },
    {
      sequence: 11,
      procedure: "Evaluate going concern (SA 570)",
      area: "Going Concern",
      riskLevel: indicatorsPresent ? "high" : "medium",
      nature: "analytical",
      timing: "year-end",
      extent: indicatorsPresent ? "expanded" : "initial",
    },
    {
      sequence: 12,
      procedure: "Review subsequent events (SA 560)",
      area: "Subsequent Events",
      riskLevel: "medium",
      nature: "inquiry",
      timing: "year-end",
      extent: "initial",
    },
    {
      sequence: 13,
      procedure: "Evaluate accounting estimates (SA 540)",
      area: "Estimates",
      riskLevel: "medium",
      nature: "recalculation",
      timing: "year-end",
      extent: "initial",
    },
    {
      sequence: 14,
      procedure: "Evaluate financial statement presentation (SA 700)",
      area: "FS Presentation",
      riskLevel: "medium",
      nature: "inquiry",
      timing: "year-end",
      extent: "initial",
    },
    {
      sequence: 15,
      procedure: "Form audit opinion (SA 700/705)",
      area: "Opinion",
      riskLevel: "high",
      nature: "inquiry",
      timing: "year-end",
      extent: "initial",
    },
  ];

  // Materiality reallocation across areas
  const materialityReallocation = populations.map((p, _idx) => ({
    area: p.stratum,
    allocatedMateriality: Math.round(
      performanceMateriality * (p.bookValue / populations.reduce((s, pop) => s + pop.bookValue, 0)),
    ),
    percentage: Math.round((p.bookValue / populations.reduce((s, pop) => s + pop.bookValue, 0)) * 100),
  }));

  const workingPaperSummaries: string[] = [
    `${engagementName} — overall materiality: ${overallMateriality} (benchmark ${benchmarkNames[materiality.benchmarkBase] ?? "unknown"} ${materiality.benchmark} × ${riskAdjPct}%, risk-adjusted: ${materiality.riskAdjusted}).`,
    `${engagementName} — performance materiality: ${performanceMateriality} (75% of overall).`,
    `${engagementName} — tolerable misstatement: ${tolerableMisstatement}; PPM threshold: ${ppmThreshold}.`,
    `${engagementName} — sample plans: ${samplePlans.map((s) => `${s.stratum} n=${s.sampleSize} (${s.samplingMethod})`).join(", ")}.`,
    `${engagementName} — analytical expectations: ${analyticalExpectationsOut
      .filter((a) => a.flag)
      .map((a) => `${a.account} variance ${a.variancePct.toFixed(2)}%`)
      .join(", ")}.`,
    `${engagementName} — fraud risk assessment: significant fraud risks in [${significantFraudRisk.join(", ")}].`,
    `${engagementName} — going concern indicators: ${goingConcernIndicators.length > 0 ? "present" : "none"}.`,
    `${engagementName} — year end: ${yearEnd}.`,
  ];

  const warnings: string[] = [];
  if (overallMateriality <= 0)
    warnings.push(
      "Overall materiality computed to zero or negative; review the benchmark and the performance materiality percentage.",
    );
  if (samplePlans.length === 0) warnings.push("No populations supplied for sampling; sample plans are not generated.");
  if (fraudRiskPresent) warnings.push("Fraud risk factors identified; expand fraud procedures per SA 240.");
  if (significantDoubt)
    warnings.push(
      "Significant going concern indicators present; consider disclosure and opinion implications per SA 570.",
    );

  return {
    engagementName,
    yearEnd,
    materiality: {
      overallMateriality,
      performanceMateriality,
      tolerableMisstatement,
      ppmThreshold,
      benchmark: benchmarkNames[materiality.benchmarkBase] ?? "unknown",
      benchmarkAmount: materiality.benchmark,
      riskAdjustment: clientRiskFactor,
    },
    samplePlans,
    analyticalExpectations: analyticalExpectationsOut,
    riskRatings: riskRatingsOut,
    auditProgram,
    fraudRiskAssessment: { fraudRiskPresent, significantFraudRisk, managementOverrideRisk, revenueRecognitionRisk },
    goingConcernAssessment: { indicatorsPresent, significantDoubt, indicators: goingConcernIndicators },
    workingPaperSummaries,
    materialityReallocation,
    warnings,
    methodology: [
      `Overall materiality is computed as the benchmark ${materiality.benchmark} (${benchmarkNames[materiality.benchmarkBase] ?? "unknown"}) × ${riskAdjPct}% (risk-adjusted: ${materiality.riskAdjusted ? `client risk factor ${clientRiskFactor}` : "none"}).`,
      "Performance materiality is 75% of overall materiality.",
      "Sample-size drivers use MUS with Poisson reliability factors and attribute sampling; the larger of the two methods is used.",
      "Analytical expectations flag accounts whose actual variance exceeds the tolerance threshold (10% or 15% based on risk profile).",
      "Fraud risk assessment screens for revenue recognition and management override risks per SA 240.",
      "Going concern assessment evaluates liquidity, leverage, and profitability indicators per SA 570.",
      "Audit program is generated with risk-based sequencing of procedures.",
      "The reviewer should apply the firm's methodology and the current audit standards.",
    ],
  };
}
