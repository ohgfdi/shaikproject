export class InternalAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalAuditError";
  }
}

/** Refuse a money amount (minor units) that is negative or not a real number. */
function assertNonNegativeMoney(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new InternalAuditError(`${label} must be a non-negative amount in paise.`);
  }
}

/** COSO component (the internal control framework's five components). */
export type CosoComponent =
  | "control-environment"
  | "risk-assessment"
  | "control-activities"
  | "information-and-communication"
  | "monitoring-activities";

export type AuditRating = "effective" | "adequate" | "needs-improvement" | "ineffective";
export type IssueStatus = "open" | "in-progress" | "retested" | "closed" | "overdue";
export type TestingMethod = "inquiry" | "observation" | "inspection" | "reperformance" | "walkthrough";
export type RiskRating = "low" | "medium" | "high" | "critical";

export interface CosoComponentInput {
  component: CosoComponent;
  description: string;
  designRating: AuditRating;
  operatingRating: AuditRating;
  evidenceMethod: TestingMethod;
  notes: string[];
}

export interface ControlTest {
  id: string;
  controlDescription: string;
  testProcedure: string;
  sampleSize: number;
  exceptions: number;
  exceptionDetail: string[];
  conclusion: "operating-effectively" | "exception-noted" | "not-tested";
  tester: string;
  testedAt: string;
}

export interface AuditIssue {
  id: string;
  findingTitle: string;
  processArea: string;
  cosoComponent: CosoComponent;
  riskRating: RiskRating;
  description: string;
  criteria: string;
  condition: string;
  cause: string;
  effect: string;
  recommendation: string;
  managementResponse: string | null;
  managementResponseBy: string | null;
  status: IssueStatus;
  raisedBy: string;
  raisedAt: string;
  targetDate: string | null;
  retestResult?: "passed" | "failed" | "not-retested";
}

export interface InternalAuditPlan {
  engagementName: string;
  entityName: string;
  fiscalYear: string;
  auditObjective: string;
  scopeIn: string[];
  scopeOut: string[];
  materialityMinor: number;
  riskRating: RiskRating;
  cosoComponents: CosoComponentInput[];
  plannedTests: ControlTest[];
  issues: AuditIssue[];
}

export interface InternalAuditResult {
  overallRating: AuditRating;
  cosoSummary: { component: CosoComponent; design: AuditRating; operating: AuditRating; overall: AuditRating }[];
  openIssues: AuditIssue[];
  overdueIssues: AuditIssue[];
  highRiskFindings: AuditIssue[];
  reportReady: boolean;
  reportSections: { heading: string; body: string }[];
  methodology: string[];
}

/** Rate an internal audit engagement and produce the audit committee report scaffold (COSO-based). */
export function assessInternalAudit(input: InternalAuditPlan): InternalAuditResult {
  // A component reported twice would be double-counted when the worst rating
  // decides the engagement, so the engine refuses the input rather than
  // silently weighting that component twice. (The per-item schema cannot see
  // duplicates across the array.)
  const seenComponents = new Set<CosoComponent>();
  for (const c of input.cosoComponents) {
    if (seenComponents.has(c.component)) {
      throw new InternalAuditError(`COSO component "${c.component}" is reported more than once.`);
    }
    seenComponents.add(c.component);
  }
  assertNonNegativeMoney(input.materialityMinor, "materiality");

  const ratingRank: Record<AuditRating, number> = { effective: 1, adequate: 2, "needs-improvement": 3, ineffective: 4 };

  const cosoSummary = input.cosoComponents.map((c) => {
    const overall = ratingRank[c.designRating] >= ratingRank[c.operatingRating] ? c.designRating : c.operatingRating;
    return { component: c.component, design: c.designRating, operating: c.operatingRating, overall };
  });

  const worstOverall = cosoSummary.reduce(
    (worst, c) => (ratingRank[c.overall] > ratingRank[worst] ? c.overall : worst),
    "effective" as AuditRating,
  );

  const openIssues = input.issues.filter((i) => i.status === "open" || i.status === "in-progress");
  const overdueIssues = input.issues.filter(
    (i) => i.status !== "closed" && i.targetDate && i.targetDate < new Date().toISOString().slice(0, 10),
  );
  const highRiskFindings = input.issues.filter((i) => i.riskRating === "high" || i.riskRating === "critical");

  const reportSections: { heading: string; body: string }[] = [
    {
      heading: "Executive Summary",
      body: `Internal audit of ${input.entityName} for ${input.fiscalYear}. Overall internal control rating: ${worstOverall}. ${openIssues.length} open issue(s), ${overdueIssues.length} overdue, ${highRiskFindings.length} high-risk finding(s).`,
    },
    {
      heading: "Audit Objective and Scope",
      body: `${input.auditObjective}\n\nIn scope: ${input.scopeIn.join(", ")}\nOut of scope: ${input.scopeOut.join(", ") || "none"}\n\nMateriality: ${Math.round(input.materialityMinor / 100)} rupees.`,
    },
    {
      heading: "COSO Component Summary",
      body: cosoSummary
        .map((c) => `${c.component}: design ${c.design}, operating ${c.operating} -> overall ${c.overall}`)
        .join("\n"),
    },
    ...(highRiskFindings.length > 0
      ? [
          {
            heading: "High-Risk Findings",
            body: highRiskFindings.map((i) => `${i.findingTitle} (${i.riskRating}, ${i.processArea})`).join("\n"),
          },
        ]
      : []),
    {
      heading: "Issues Summary",
      body:
        input.issues.length > 0
          ? input.issues
              .map(
                (i) =>
                  `${i.id}: ${i.findingTitle} -- ${i.status} (risk: ${i.riskRating}, due: ${i.targetDate ?? "n/a"})`,
              )
              .join("\n")
          : "No findings identified.",
    },
  ];

  const reportReady =
    worstOverall !== "effective" && // always report
    openIssues.length === 0 &&
    overdueIssues.length === 0;

  return {
    overallRating: worstOverall,
    cosoSummary,
    openIssues,
    overdueIssues,
    highRiskFindings,
    reportReady,
    reportSections,
    methodology: [
      "Rating scale: effective > adequate > needs-improvement > ineffective.",
      "COSO 2013 five-component framework applied to each in-scope process area.",
      "Overall component rating is the worse of design and operating effectiveness.",
      `Overall engagement rating is the worst of the five components = ${worstOverall}.`,
      "Issues rated on a four-point risk scale (low/medium/high/critical).",
    ],
  };
}

/** Track an internal audit issue through its lifecycle. */
export function trackAuditIssue(issue: AuditIssue, action: "progress" | "retest" | "close"): AuditIssue {
  const now = new Date().toISOString().slice(0, 10);
  if (action === "progress") {
    return { ...issue, status: issue.targetDate && issue.targetDate < now ? "overdue" : "in-progress" };
  }
  if (action === "retest") {
    return { ...issue, status: "retested", retestResult: "not-retested" };
  }
  return { ...issue, status: "closed" };
}

/** Risk-based audit plan: prioritise process areas by inherent risk. */
export interface RiskBasedPlanInput {
  processAreas: { name: string; inherentRisk: "low" | "medium" | "high"; transactionVolume: number }[];
  availableHours: number;
  hoursPerHighRiskArea: number;
  hoursPerMediumRiskArea: number;
  hoursPerLowRiskArea: number;
}

export interface RiskBasedPlanOutput {
  prioritized: { name: string; inherentRisk: string; recommendedHours: number; rationale: string }[];
  totalRecommendedHours: number;
  withinBudget: boolean;
  notes: string[];
}

export function planRiskBasedAudit(input: RiskBasedPlanInput): RiskBasedPlanOutput {
  const ranked = [...input.processAreas].sort((a, b) => {
    const rank = { high: 3, medium: 2, low: 1 };
    return rank[b.inherentRisk] - rank[a.inherentRisk] || b.transactionVolume - a.transactionVolume;
  });

  const prioritized = ranked.map((a) => {
    const hours =
      a.inherentRisk === "high"
        ? input.hoursPerHighRiskArea
        : a.inherentRisk === "medium"
          ? input.hoursPerMediumRiskArea
          : input.hoursPerLowRiskArea;
    return {
      name: a.name,
      inherentRisk: a.inherentRisk,
      recommendedHours: hours,
      rationale: `${a.inherentRisk}-risk area with ${a.transactionVolume.toLocaleString()} transactions -- recommend ${hours} hours.`,
    };
  });

  const totalRecommendedHours = prioritized.reduce((s, p) => s + p.recommendedHours, 0);

  return {
    prioritized,
    totalRecommendedHours,
    withinBudget: totalRecommendedHours <= input.availableHours,
    notes:
      totalRecommendedHours > input.availableHours
        ? [
            `Recommended ${totalRecommendedHours} hours exceeds ${input.availableHours} available -- prioritise high-risk areas first.`,
          ]
        : ["Plan fits within available hours."],
  };
}

/** A single concurrent audit observation. */
export interface ConcurrentAuditObservation {
  ref: string;
  area: string;
  description: string;
  category: "compliance" | "accounting" | "operational" | "fraud-risk" | "customer-service";
  severity: "minor" | "major" | "critical";
  regulatoryReference?: string;
  correctiveAction: string;
  managementResponse: string | null;
  status: "open" | "closed";
  detectedBy: string;
  detectedOn: string;
}

/** A single concurrent audit branch. */
export interface ConcurrentAuditBranch {
  branchCode: string;
  branchName: string;
  centerHead: string;
  branchManager: string;
  examinationPeriod: { from: string; to: string };
  transactionsTested: number;
  transactionsTestedAmount: number;
  kycSampleTested: number;
  amlAlertReviewed: number;
  interestCalculationTested: number;
  prudentialLimitChecks: PrudentialLimitCheck[];
  observations: ConcurrentAuditObservation[];
  concurrentAuditor: string;
  auditReportDate: string;
}

/** A prudential limit check. */
export interface PrudentialLimitCheck {
  limitName: string;
  regulatoryLimit: number;
  actualExposure: number;
  headroom: number;
  breached: boolean;
  description: string;
}

/** Concurrent audit result. */
export interface ConcurrentAuditResult {
  branch: ConcurrentAuditBranch;
  totalObservations: number;
  bySeverity: { minor: number; major: number; critical: number };
  byCategory: Record<string, number>;
  openCritical: ConcurrentAuditObservation[];
  prudentialBreaches: PrudentialLimitCheck[];
  quarterlyReportReady: boolean;
  reportSections: { heading: string; body: string }[];
  methodology: string[];
}

/** Reconcile prudential exposure limits. */
export function checkPrudentialLimits(checks: PrudentialLimitCheck[]): PrudentialLimitCheck[] {
  return checks.map((c) => {
    assertNonNegativeMoney(c.regulatoryLimit, `regulatory limit for "${c.limitName}"`);
    assertNonNegativeMoney(c.actualExposure, `actual exposure for "${c.limitName}"`);
    return {
      ...c,
      headroom: c.regulatoryLimit - c.actualExposure,
      breached: c.actualExposure > c.regulatoryLimit,
    };
  });
}

/** Assess a concurrent audit branch and produce the quarterly report. */
export function assessConcurrentAudit(branch: ConcurrentAuditBranch): ConcurrentAuditResult {
  const checkedLimits = checkPrudentialLimits(branch.prudentialLimitChecks);
  const bySeverity = { minor: 0, major: 0, critical: 0 };
  const byCategory: Record<string, number> = {};

  for (const obs of branch.observations) {
    bySeverity[obs.severity] += 1;
    byCategory[obs.category] = (byCategory[obs.category] ?? 0) + 1;
  }

  const openCritical = branch.observations.filter((o) => o.severity === "critical" && o.status === "open");
  const prudentialBreaches = checkedLimits.filter((l) => l.breached);

  const reportSections: { heading: string; body: string }[] = [
    {
      heading: "Concurrent Audit Report -- " + branch.branchName,
      body: `Branch Code: ${branch.branchCode}\nPeriod: ${branch.examinationPeriod.from} to ${branch.examinationPeriod.to}\nAuditor: ${branch.concurrentAuditor}\nReport Date: ${branch.auditReportDate}`,
    },
    {
      heading: "Scope of Examination",
      body: `Transactions tested: ${branch.transactionsTested} (amount: ${Math.round(branch.transactionsTestedAmount / 100)} rupees)\nKYC sample tested: ${branch.kycSampleTested}\nAML alerts reviewed: ${branch.amlAlertReviewed}\nInterest calculation tested: ${branch.interestCalculationTested}`,
    },
    {
      heading: "Observations",
      body: `${branch.observations.length} total: ${bySeverity.minor} minor, ${bySeverity.major} major, ${bySeverity.critical} critical`,
    },
    ...(prudentialBreaches.length > 0
      ? [
          {
            heading: "Prudential Limit Breaches",
            body: prudentialBreaches
              .map(
                (l) =>
                  `${l.limitName}: exposure ${Math.round(l.actualExposure / 100)} vs limit ${Math.round(l.regulatoryLimit / 100)} rupees`,
              )
              .join("\n"),
          },
        ]
      : []),
  ];

  return {
    // Return the CHECKED limits, not the raw input: headroom and the breach flag
    // are computed here, and a UI that renders the input would show every limit
    // as unbreached with zero headroom.
    branch: { ...branch, prudentialLimitChecks: checkedLimits },
    totalObservations: branch.observations.length,
    bySeverity,
    byCategory,
    openCritical,
    prudentialBreaches,
    quarterlyReportReady: openCritical.length === 0,
    reportSections,
    methodology: [
      "Concurrent audit examines transactions on a sample basis during the financial year.",
      "Prudential limits checked against regulatory thresholds; breach = exposure > limit.",
      "Observations categorised by area and severity; critical open items block report sign-off.",
      "Quarterly report submitted to the banking company's head office audit department.",
    ],
  };
}

/** A physical stock verification plan. */
export interface StockAuditPlan {
  entityName: string;
  location: string;
  stockDate: string;
  countingTeamLead: string;
  countingTeamMembers: string[];
  bookStockValueMinor: number;
  bookStockQuantity: number;
  scope: "full-physical" | "cycle-count" | "test-count";
  materialityMinor: number;
  highValueItemThresholdMinor: number;
  areas: StockArea[];
}

/** A physical stock verification area. */
export interface StockArea {
  areaCode: string;
  areaName: string;
  expectedQuantity: number;
  bookValueMinor: number;
  countedQuantity: number | null;
  countedValueMinor: number | null;
  varianceQuantity: number | null;
  varianceValueMinor: number | null;
  varianceReason: string | null;
  countedBy: string | null;
  countedAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

/** A test count for stock items. */
export interface StockTestCount {
  itemCode: string;
  itemDescription: string;
  areaCode: string;
  bookQuantity: number;
  bookValueMinor: number;
  testCountQuantity: number;
  testCountValueMinor: number;
  testCountBy: string;
  testCountAt: string;
}

/** Stock audit result. */
export interface StockAuditResult {
  plan: StockAuditPlan;
  totalBookQuantity: number;
  totalBookValueMinor: number;
  totalCountedQuantity: number | null;
  totalCountedValueMinor: number | null;
  totalVarianceQuantity: number | null;
  totalVarianceValueMinor: number | null;
  variancePct: number | null;
  areasWithVariance: StockArea[];
  testCounts: StockTestCount[];
  materialVariance: boolean;
  reportReady: boolean;
  reportSections: { heading: string; body: string }[];
  methodology: string[];
}

/** Reconcile counted stock to book stock and compute variances. */
export function reconcileStockAreas(areas: StockArea[]): {
  totalBookQuantity: number;
  totalBookValueMinor: number;
  totalCountedQuantity: number | null;
  totalCountedValueMinor: number | null;
  totalVarianceQuantity: number | null;
  totalVarianceValueMinor: number | null;
  areasWithVariance: StockArea[];
} {
  let totalBookQty = 0;
  let totalBookVal = 0;
  let totalCountedQty: number | null = 0;
  let totalCountedVal: number | null = 0;

  for (const a of areas) {
    assertNonNegativeMoney(a.bookValueMinor, `book value for stock area "${a.areaCode}"`);
    if (a.countedValueMinor !== null) {
      assertNonNegativeMoney(a.countedValueMinor, `counted value for stock area "${a.areaCode}"`);
    }
    totalBookQty += a.expectedQuantity;
    totalBookVal += a.bookValueMinor;
    if (a.countedQuantity !== null) {
      totalCountedQty = (totalCountedQty ?? 0) + a.countedQuantity;
    }
    if (a.countedValueMinor !== null) {
      totalCountedVal = (totalCountedVal ?? 0) + a.countedValueMinor;
    }
  }

  const areasWithVariance: StockArea[] = [];
  for (const a of areas) {
    if (a.countedQuantity === null || a.bookValueMinor === 0) continue;
    const qtyVar = a.countedQuantity - a.expectedQuantity;
    const valVar = (a.countedValueMinor ?? 0) - a.bookValueMinor;
    const updated: StockArea = {
      ...a,
      varianceQuantity: qtyVar,
      varianceValueMinor: valVar,
    };
    if (qtyVar !== 0 || valVar !== 0) {
      areasWithVariance.push(updated);
    }
  }

  const totalVarianceQty = totalCountedQty !== null ? totalCountedQty - totalBookQty : null;
  const totalVarianceVal = totalCountedVal !== null ? totalCountedVal - totalBookVal : null;

  return {
    totalBookQuantity: totalBookQty,
    totalBookValueMinor: totalBookVal,
    totalCountedQuantity: totalCountedQty,
    totalCountedValueMinor: totalCountedVal,
    totalVarianceQuantity: totalVarianceQty,
    totalVarianceValueMinor: totalVarianceVal,
    areasWithVariance,
  };
}

/** Run the stock audit and produce the verification report. */
export function assessStockAudit(plan: StockAuditPlan): StockAuditResult {
  const reconciled = reconcileStockAreas(plan.areas);
  const totalBookVal = reconciled.totalBookValueMinor;
  const varianceVal = reconciled.totalVarianceValueMinor;
  const variancePct =
    totalBookVal !== 0 && varianceVal !== null ? Math.round((varianceVal / totalBookVal) * 10000) / 100 : null;

  const materialVariance = varianceVal !== null && Math.abs(varianceVal) > plan.materialityMinor;

  const reportSections: { heading: string; body: string }[] = [
    {
      heading: "Stock Verification Report",
      body: `Entity: ${plan.entityName}\nLocation: ${plan.location}\nStock Date: ${plan.stockDate}\nCounting Team Lead: ${plan.countingTeamLead}`,
    },
    {
      heading: "Verification Scope",
      body: `Scope: ${plan.scope}\nMateriality: ${Math.round(plan.materialityMinor / 100)} rupees\nHigh-value item threshold: ${Math.round(plan.highValueItemThresholdMinor / 100)} rupees`,
    },
    {
      heading: "Summary",
      body:
        `Book quantity: ${reconciled.totalBookQuantity}\nBook value: ${Math.round(totalBookVal / 100)} rupees\n` +
        (reconciled.totalCountedQuantity !== null
          ? `Counted quantity: ${reconciled.totalCountedQuantity}\nCounted value: ${Math.round((reconciled.totalCountedValueMinor ?? 0) / 100)} rupees\n`
          : "Counting not yet completed.\n") +
        (variancePct !== null
          ? `Variance: ${varianceVal !== null ? Math.round((varianceVal ?? 0) / 100) : 0} rupees (${variancePct}% of book value)`
          : ""),
    },
    {
      heading: "Areas with Variance",
      body:
        reconciled.areasWithVariance.length > 0
          ? reconciled.areasWithVariance
              .map(
                (a) =>
                  `${a.areaCode} (${a.areaName}): book ${a.expectedQuantity}, counted ${a.countedQuantity ?? "-"}, variance ${a.varianceQuantity ?? 0} (${a.varianceReason ?? "reason not recorded"})`,
              )
              .join("\n")
          : "No variances identified.",
    },
    {
      heading: "Test Counts",
      body:
        plan.areas
          .filter((a) => a.countedQuantity !== null)
          .map((a) => `${a.areaCode}: counted by ${a.countedBy ?? "-"}, verified by ${a.verifiedBy ?? "-"}`)
          .join("\n") || "No areas counted.",
    },
  ];

  return {
    plan,
    totalBookQuantity: reconciled.totalBookQuantity,
    totalBookValueMinor: reconciled.totalBookValueMinor,
    totalCountedQuantity: reconciled.totalCountedQuantity,
    totalCountedValueMinor: reconciled.totalCountedValueMinor,
    totalVarianceQuantity: reconciled.totalVarianceQuantity,
    totalVarianceValueMinor: reconciled.totalVarianceValueMinor,
    variancePct,
    areasWithVariance: reconciled.areasWithVariance,
    testCounts: [],
    materialVariance,
    reportReady: plan.areas.every((a) => a.countedQuantity !== null && a.verifiedBy !== null),
    reportSections,
    methodology: [
      "Physical verification performed by counting team on stock date.",
      `High-value items (above ${Math.round(plan.highValueItemThresholdMinor / 100)} rupees) are 100% counted.`,
      "Test counts applied to sample items; quantity and value differences computed per area.",
      "Variance = counted - book. Material when absolute variance exceeds materiality.",
      "Report signed by counting team lead and verified by an independent person.",
    ],
  };
}
