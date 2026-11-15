import { z } from "zod";

import {
  assessConcurrentAudit,
  assessInternalAudit,
  assessStockAudit,
  checkPrudentialLimits,
  planRiskBasedAudit,
  reconcileStockAreas,
  trackAuditIssue,
  type AuditIssue,
  type ConcurrentAuditBranch,
  type InternalAuditPlan,
  type PrudentialLimitCheck,
  type StockArea,
  type StockAuditPlan,
} from "./ca-internal-audit";

const rupees = z.number().finite().safe();
const positiveRupees = rupees.positive();

const paise = (n: number) => Math.round(n * 100);

/** Internal audit schemas */
const cosoComponent = z.enum([
  "control-environment",
  "risk-assessment",
  "control-activities",
  "information-and-communication",
  "monitoring-activities",
]);
const auditRating = z.enum(["effective", "adequate", "needs-improvement", "ineffective"]);
const issueStatus = z.enum(["open", "in-progress", "retested", "closed", "overdue"]);
const riskRating = z.enum(["low", "medium", "high", "critical"]);
const testingMethod = z.enum(["inquiry", "observation", "inspection", "reperformance", "walkthrough"]);
const severity = z.enum(["minor", "major", "critical"]);
const obsCategory = z.enum(["compliance", "accounting", "operational", "fraud-risk", "customer-service"]);

const cosoInput = z.object({
  component: cosoComponent,
  description: z.string().min(1),
  designRating: auditRating,
  operatingRating: auditRating,
  evidenceMethod: testingMethod,
  notes: z.array(z.string()).optional(),
});

const controlTest = z.object({
  id: z.string().min(1),
  controlDescription: z.string().min(1),
  testProcedure: z.string().min(1),
  sampleSize: z.number().int().min(0),
  exceptions: z.number().int().min(0),
  exceptionDetail: z.array(z.string()).optional(),
  conclusion: z.enum(["operating-effectively", "exception-noted", "not-tested"]),
  tester: z.string().min(1),
  testedAt: z.string().min(1),
});

const issue = z.object({
  id: z.string().min(1),
  findingTitle: z.string().min(1),
  processArea: z.string().min(1),
  cosoComponent: cosoComponent,
  riskRating,
  description: z.string().min(1),
  criteria: z.string().min(1),
  condition: z.string().min(1),
  cause: z.string().min(1),
  effect: z.string().min(1),
  recommendation: z.string().min(1),
  managementResponse: z.string().nullish(),
  managementResponseBy: z.string().nullish(),
  status: issueStatus,
  raisedBy: z.string().min(1),
  raisedAt: z.string().min(1),
  targetDate: z.string().nullable(),
  retestResult: z.enum(["passed", "failed", "not-retested"]).nullable().optional(),
});

const internalAuditPlan = z.object({
  engagementName: z.string().min(1),
  entityName: z.string().min(1),
  fiscalYear: z.string().min(1),
  auditObjective: z.string().min(1),
  scopeIn: z.array(z.string()).min(1),
  scopeOut: z.array(z.string()).optional(),
  materiality: positiveRupees,
  riskRating: z.enum(["low", "medium", "high"]),
  cosoComponents: z.array(cosoInput).min(1),
  plannedTests: z.array(controlTest).optional(),
  issues: z.array(issue).optional(),
});

const internalAuditOps = z.discriminatedUnion("op", [
  z.object({ op: z.literal("assess"), plan: internalAuditPlan }),
  z.object({ op: z.literal("track-issue"), issue, action: z.enum(["progress", "retest", "close"]) }),
  z.object({
    op: z.literal("plan-risk-based"),
    processAreas: z.array(
      z.object({
        name: z.string().min(1),
        inherentRisk: z.enum(["low", "medium", "high"]),
        transactionVolume: z.number().int().min(0),
      }),
    ),
    availableHours: z.number().int().min(1),
    hoursPerHighRiskArea: z.number().int().min(1),
    hoursPerMediumRiskArea: z.number().int().min(1),
    hoursPerLowRiskArea: z.number().int().min(1),
  }),
]);

/** Concurrent audit schemas */
const prudentialLimitCheck = z.object({
  limitName: z.string().min(1),
  regulatoryLimit: positiveRupees,
  actualExposure: positiveRupees,
  description: z.string().min(1),
});

const concurrentObservation = z.object({
  ref: z.string().min(1),
  area: z.string().min(1),
  description: z.string().min(1),
  category: obsCategory,
  severity,
  regulatoryReference: z.string().nullable().optional(),
  correctiveAction: z.string().min(1),
  managementResponse: z.string().nullable().optional(),
  status: z.enum(["open", "closed"]),
  detectedBy: z.string().min(1),
  detectedOn: z.string().min(1),
});

const concurrentBranch = z.object({
  branchCode: z.string().min(1),
  branchName: z.string().min(1),
  centerHead: z.string().min(1),
  branchManager: z.string().min(1),
  examinationPeriod: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  transactionsTested: z.number().int().min(0),
  transactionsTestedAmount: rupees,
  kycSampleTested: z.number().int().min(0),
  amlAlertReviewed: z.number().int().min(0),
  interestCalculationTested: z.number().int().min(0),
  prudentialLimitChecks: z.array(prudentialLimitCheck),
  observations: z.array(concurrentObservation),
  concurrentAuditor: z.string().min(1),
  auditReportDate: z.string().min(1),
});

const concurrentAuditOps = z.discriminatedUnion("op", [
  z.object({ op: z.literal("assess"), branch: concurrentBranch }),
  z.object({ op: z.literal("check-limits"), checks: z.array(prudentialLimitCheck) }),
]);

/** Stock audit schemas */
const stockArea = z.object({
  areaCode: z.string().min(1),
  areaName: z.string().min(1),
  expectedQuantity: z.number().int().min(0),
  bookValue: rupees,
  countedQuantity: z.number().int().nullable(),
  countedValue: rupees.nullable(),
  countedBy: z.string().nullable().optional(),
  countedAt: z.string().nullable().optional(),
  verifiedBy: z.string().nullable().optional(),
  verifiedAt: z.string().nullable().optional(),
});

const stockAuditPlan = z.object({
  entityName: z.string().min(1),
  location: z.string().min(1),
  stockDate: z.string().min(1),
  countingTeamLead: z.string().min(1),
  countingTeamMembers: z.array(z.string()).min(1),
  bookStockValue: rupees,
  bookStockQuantity: z.number().int().min(0),
  scope: z.enum(["full-physical", "cycle-count", "test-count"]),
  materiality: positiveRupees,
  highValueItemThreshold: positiveRupees,
  areas: z.array(stockArea).min(1),
});

const stockAuditOps = z.discriminatedUnion("op", [
  z.object({ op: z.literal("assess"), plan: stockAuditPlan }),
  z.object({ op: z.literal("reconcile-areas"), areas: z.array(stockArea) }),
]);

/** Top-level kind schemas */
export const internalAuditInput = z.object({ kind: z.literal("internal-audit"), op: internalAuditOps });
export const concurrentAuditInput = z.object({ kind: z.literal("concurrent-audit"), op: concurrentAuditOps });
export const stockAuditInput = z.object({ kind: z.literal("stock-audit"), op: stockAuditOps });

/**
 * Dispatch functions.
 *
 * Each takes the `op` payload from the matching `{ kind, op }` envelope, i.e.
 * the route calls `computeInternalAudit(input.op)`. Taking the op (not the
 * envelope) keeps the switch on `op.op` honest — an earlier version received
 * the envelope and switched on `input.op.op`, which is undefined at runtime.
 */
export function computeInternalAudit(op: z.infer<typeof internalAuditOps>): unknown {
  switch (op.op) {
    case "assess":
      return assessInternalAudit(planToEngine(op.plan));
    case "track-issue":
      return trackAuditIssue(issueToEngine(op.issue), op.action);
    case "plan-risk-based":
      return planRiskBasedAudit({
        processAreas: op.processAreas,
        availableHours: op.availableHours,
        hoursPerHighRiskArea: op.hoursPerHighRiskArea,
        hoursPerMediumRiskArea: op.hoursPerMediumRiskArea,
        hoursPerLowRiskArea: op.hoursPerLowRiskArea,
      });
  }
}

export function computeConcurrentAudit(op: z.infer<typeof concurrentAuditOps>): unknown {
  switch (op.op) {
    case "assess":
      return assessConcurrentAudit(branchToEngine(op.branch));
    case "check-limits":
      return checkPrudentialLimits(op.checks.map((c) => limitToEngine(c)));
  }
}

export function computeStockAudit(op: z.infer<typeof stockAuditOps>): unknown {
  switch (op.op) {
    case "assess":
      return assessStockAudit(planToStockEngine(op.plan));
    case "reconcile-areas":
      return reconcileStockAreas(op.areas.map(areaToEngine));
  }
}

/** Engine conversions */
function planToEngine(input: z.infer<typeof internalAuditPlan>): InternalAuditPlan {
  return {
    engagementName: input.engagementName,
    entityName: input.entityName,
    fiscalYear: input.fiscalYear,
    auditObjective: input.auditObjective,
    scopeIn: input.scopeIn,
    scopeOut: input.scopeOut ?? [],
    materialityMinor: paise(input.materiality),
    riskRating: input.riskRating,
    cosoComponents: input.cosoComponents.map((c) => ({
      component: c.component,
      description: c.description,
      designRating: c.designRating,
      operatingRating: c.operatingRating,
      evidenceMethod: c.evidenceMethod,
      notes: c.notes ?? [],
    })),
    plannedTests: (input.plannedTests ?? []).map((t) => ({ ...t, exceptionDetail: t.exceptionDetail ?? [] })),
    issues: (input.issues ?? []).map(issueToEngine),
  };
}

function issueToEngine(input: z.infer<typeof issue>): AuditIssue {
  return {
    id: input.id,
    findingTitle: input.findingTitle,
    processArea: input.processArea,
    cosoComponent: input.cosoComponent,
    riskRating: input.riskRating,
    description: input.description,
    criteria: input.criteria,
    condition: input.condition,
    cause: input.cause,
    effect: input.effect,
    recommendation: input.recommendation,
    managementResponse: input.managementResponse as string | null,
    managementResponseBy: input.managementResponseBy as string | null,
    status: input.status,
    raisedBy: input.raisedBy,
    raisedAt: input.raisedAt,
    targetDate: input.targetDate,
    retestResult: input.retestResult ?? undefined,
  };
}

function branchToEngine(input: z.infer<typeof concurrentBranch>): ConcurrentAuditBranch {
  return {
    branchCode: input.branchCode,
    branchName: input.branchName,
    centerHead: input.centerHead,
    branchManager: input.branchManager,
    examinationPeriod: input.examinationPeriod,
    transactionsTested: input.transactionsTested,
    transactionsTestedAmount: paise(input.transactionsTestedAmount),
    kycSampleTested: input.kycSampleTested,
    amlAlertReviewed: input.amlAlertReviewed,
    interestCalculationTested: input.interestCalculationTested,
    prudentialLimitChecks: checkPrudentialLimits(input.prudentialLimitChecks.map(limitToEngine)),
    observations: input.observations.map((o) => ({
      ref: o.ref,
      area: o.area,
      description: o.description,
      category: o.category,
      severity: o.severity,
      regulatoryReference: o.regulatoryReference ?? undefined,
      correctiveAction: o.correctiveAction,
      managementResponse: o.managementResponse ?? null,
      status: o.status,
      detectedBy: o.detectedBy,
      detectedOn: o.detectedOn,
    })),
    concurrentAuditor: input.concurrentAuditor,
    auditReportDate: input.auditReportDate,
  };
}

function planToStockEngine(input: z.infer<typeof stockAuditPlan>): StockAuditPlan {
  return {
    entityName: input.entityName,
    location: input.location,
    stockDate: input.stockDate,
    countingTeamLead: input.countingTeamLead,
    countingTeamMembers: input.countingTeamMembers,
    bookStockValueMinor: paise(input.bookStockValue),
    bookStockQuantity: input.bookStockQuantity,
    scope: input.scope,
    materialityMinor: paise(input.materiality),
    highValueItemThresholdMinor: paise(input.highValueItemThreshold),
    areas: input.areas.map(areaToEngine),
  };
}

/** Rupee-denominated prudential limit → engine's paise-denominated check. */
function limitToEngine(input: z.infer<typeof prudentialLimitCheck>): PrudentialLimitCheck {
  return {
    limitName: input.limitName,
    regulatoryLimit: paise(input.regulatoryLimit),
    actualExposure: paise(input.actualExposure),
    headroom: 0,
    breached: false,
    description: input.description,
  };
}

function areaToEngine(input: z.infer<typeof stockArea>): StockArea {
  return {
    areaCode: input.areaCode,
    areaName: input.areaName,
    expectedQuantity: input.expectedQuantity,
    bookValueMinor: paise(input.bookValue),
    countedQuantity: input.countedQuantity,
    countedValueMinor: input.countedValue != null ? paise(input.countedValue) : null,
    varianceQuantity: 0,
    varianceValueMinor: 0,
    varianceReason: "",
    countedBy: input.countedBy ?? null,
    countedAt: input.countedAt ?? null,
    verifiedBy: input.verifiedBy ?? null,
    verifiedAt: input.verifiedAt ?? null,
  };
}
