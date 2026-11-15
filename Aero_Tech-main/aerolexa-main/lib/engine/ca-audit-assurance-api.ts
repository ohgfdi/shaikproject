/**
 * Audit & assurance practice — API adapter.
 *
 * `ca-audit-assurance.ts` is the pure workflow engine (engagement → report); it
 * speaks in MINOR UNITS (paise) and exposes ~39 free functions. This module makes
 * that engine reachable from the product surface: it is the one place that
 *
 *   1. validates an op-shaped payload with Zod (so a bad request is a 400 with a
 *      pointed message, not a 500), and
 *   2. converts the API's RUPEES-as-decimals into the engine's integer PAISE,
 *      exactly as `/api/ca/compute` does for every other CA engine.
 *
 * It is dispatched by `POST /api/ca/compute` under `kind: "audit-assurance"`.
 * Keeping the adapter in a pure, exported function (rather than inline in the
 * route) is deliberate: the money conversion is the part most likely to be
 * wrong, so it is unit-testable without booting a server or authenticating.
 *
 * Nothing here exercises professional judgement or signs anything — it routes
 * caller-supplied inputs to the engine's rule-traceable outputs.
 */

import { z } from "zod";

import {
  addRemark,
  addReviewNote,
  assembleAuditFile,
  assessEngagementAcceptance,
  assessFraudRisk,
  assessItGeneralControls,
  assessRiskOfMaterialMisstatement,
  attributeSampleSize,
  classifyControlDeficiency,
  clearReviewNote,
  createWorkpaper,
  developAnalyticalExpectation,
  draftAuditReport,
  draftManagementLetter,
  evaluateEvidenceSufficiency,
  evaluateIndependence,
  evaluateInternalControls,
  evaluateMusResults,
  FINANCIAL_STATEMENT_ASSERTIONS,
  investigateDifference,
  legalCorrespondenceNote,
  managementInquiryNote,
  musSampleSize,
  reconcileBankConfirmation,
  reconcileExternalConfirmation,
  rectifyReviewNote,
  recordSignedAssertions,
  renderEngagementLetter,
  renderManagementRepresentationLetter,
  requireTcwgCommunication,
  reviewWorkpaper,
  stockInspectionNote,
  stratifyPopulation,
  summarizeReportableConditions,
  understandEntity,
} from "./ca-audit-assurance";

/** Rupee amount (major units) as it arrives over the API. */
const rupees = z.number().finite().safe();
const positiveRupees = rupees.positive();
/** Convert rupees (major) to paise (minor), the engine's unit. */
const paise = (n: number) => Math.round(n * 100);

const severity = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const effectiveness = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const assertion = z.enum(FINANCIAL_STATEMENT_ASSERTIONS);
const threatCategory = z.enum(["self-interest", "self-review", "advocacy", "familiarity", "intimidation"]);

const deficiencyInput = z.object({
  description: z.string(),
  likelihoodOfMisstatement: z.enum(["remote", "possible", "probable"]),
  magnitude: z.enum(["immaterial", "material", "significant"]),
  isEntityLevelOrIt: z.boolean(),
});

const reviewNote = z.object({
  id: z.string().min(1),
  raisedBy: z.string().min(1),
  raisedAt: z.string().min(1),
  text: z.string(),
  status: z.enum(["open", "addressed", "cleared"]),
  resolution: z.string().nullable(),
  clearedBy: z.string().nullable(),
});

const workpaperRemark = z.object({
  version: z.number().int().nonnegative(),
  at: z.string().min(1),
  by: z.string().min(1),
  remark: z.string(),
});

const workpaper = z.object({
  ref: z.string().min(1),
  title: z.string(),
  sa: z.string(),
  preparedBy: z.string().min(1),
  preparedAt: z.string().min(1),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  partnerFlag: z.boolean(),
  status: z.enum(["draft", "prepared", "reviewed", "cleared"]),
  crossRefs: z.array(z.string()),
  reviewNotes: z.array(reviewNote),
  remarks: z.array(workpaperRemark),
  version: z.number().int().nonnegative(),
});

const evidenceItem = z.object({
  id: z.string().min(1),
  type: z.enum([
    "inspection",
    "observation",
    "external-confirmation",
    "recalculation",
    "reperformance",
    "analytical",
    "inquiry",
  ]),
  source: z.enum(["external", "internal", "auditor-generated"]),
  reliability: z.enum(["high", "medium", "low"]),
  assertions: z.array(assertion),
  workpaperRef: z.string().min(1),
  tieOut: z.object({ bookAmount: rupees, agreedAmount: rupees, difference: rupees }).nullable(),
});

/**
 * The discriminated union the route parses. Each variant carries a literal
 * `op`; money fields are RUPEES and are converted to paise by the dispatcher.
 */
export const auditAssuranceInput = z.discriminatedUnion("op", [
  // ---- 1. Engagement acceptance, independence & representations ----------
  z.object({
    op: z.literal("independence"),
    threats: z.array(z.object({ category: threatCategory, description: z.string(), severity })),
    safeguards: z.array(z.object({ description: z.string(), mitigates: z.array(threatCategory), effectiveness })),
  }),
  z.object({
    op: z.literal("engagement-acceptance"),
    clientIntegrityConcern: z.enum(["low", "medium", "high"]),
    competenceAndResources: z.enum(["sufficient", "insufficient"]),
    independenceAcceptable: z.boolean(),
    scopeAgreedInWriting: z.boolean(),
    feeArrangement: z.enum(["fixed", "time-based", "contingent"]),
    ethicalRequirementsComplianceConfirmed: z.boolean(),
  }),
  z.object({
    op: z.literal("engagement-letter"),
    addressee: z.string().min(1),
    entityName: z.string().min(1),
    financialYear: z.string().min(1),
    scope: z.array(z.string()),
    responsibilitiesManagement: z.array(z.string()),
    responsibilitiesAuditor: z.array(z.string()),
    fees: z.string(),
    reportingDeadline: z.string(),
    otherMatters: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal("representation-letter"),
    entityName: z.string().min(1),
    financialYear: z.string().min(1),
    periodEnd: z.string().min(1),
    auditorName: z.string().min(1),
    auditorFirm: z.string().min(1),
    additionalRepresentations: z.array(z.string()).optional(),
    qualifications: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal("signed-assertions"),
    required: z.array(z.object({ account: z.string(), assertion })),
    signed: z.array(z.object({ account: z.string(), assertion, signedBy: z.string(), signedAt: z.string() })),
  }),

  // ---- 2. Risk assessment -------------------------------------------------
  z.object({
    op: z.literal("entity-understanding"),
    natureOfBusiness: z.string(),
    industryAndRegulatory: z.array(z.string()),
    applicableFramework: z.string(),
    ownershipAndGovernance: z.array(z.string()),
    keyAccountingPolicies: z.array(z.string()),
    objectivesAndStrategies: z.array(z.string()),
    measurementAndReviewOfFinancialPerformance: z.array(z.string()),
    significantChanges: z.array(z.string()),
  }),
  z.object({
    op: z.literal("risk-assessment"),
    risks: z.array(
      z.object({
        account: z.string(),
        assertion,
        inherentLikelihood: z.number().finite(),
        inherentImpact: z.number().finite(),
        controlEffectiveness: z.number().finite(),
      }),
    ),
  }),
  z.object({
    op: z.literal("internal-controls"),
    controls: z.array(
      z.object({
        id: z.string().min(1),
        description: z.string(),
        domain: z.enum(["entity-level", "it", "transaction"]),
        design: z.enum(["effective", "deficient"]),
        operating: z.enum(["effective", "not-tested", "deficient"]),
      }),
    ),
  }),
  z.object({
    op: z.literal("itgc"),
    controls: z.array(
      z.object({
        domain: z.enum(["access", "change-management", "operations", "backup-recovery"]),
        description: z.string(),
        tested: z.boolean(),
        effective: z.boolean(),
      }),
    ),
  }),
  z.object({
    op: z.literal("fraud-risk"),
    revenueRecognitionJudgemental: z.boolean(),
    revenuePresumptionRebutted: z.boolean(),
    managementOverrideIndicators: z.array(z.string()),
    incentiveFactors: z.array(z.string()),
    opportunityFactors: z.array(z.string()),
    rationalisationFactors: z.array(z.string()),
  }),

  // ---- 3. Sampling & substantive analytical procedures --------------------
  z.object({
    op: z.literal("mus-plan"),
    bookValue: positiveRupees,
    tolerableMisstatement: positiveRupees,
    expectedMisstatement: rupees.nonnegative(),
    confidence: z.number().finite(),
  }),
  z.object({
    op: z.literal("attribute-plan"),
    confidence: z.number().finite(),
    tolerableDeviationRate: z.number().finite().positive(),
    expectedDeviationRate: z.number().finite().nonnegative(),
  }),
  z.object({
    op: z.literal("stratify"),
    items: z.array(z.object({ id: z.string().min(1), amount: rupees })),
    bands: z.array(rupees),
  }),
  z.object({
    op: z.literal("mus-evaluate"),
    sampleItems: z.array(z.object({ bookValue: rupees, auditValue: rupees })),
    samplingInterval: positiveRupees,
    confidence: z.number().finite(),
  }),
  z.object({
    op: z.literal("analytical-expectation"),
    account: z.string(),
    baseAmount: rupees,
    expectedChangePct: z.number().finite(),
    actualAmount: rupees,
    materiality: positiveRupees,
    thresholdPct: z.number().finite().optional(),
  }),
  z.object({
    op: z.literal("investigate-difference"),
    difference: rupees,
    explanation: z.string(),
    isMisstatement: z.boolean(),
    correction: rupees.optional(),
  }),

  // ---- 4. Workpaper system ------------------------------------------------
  z.object({
    op: z.literal("workpaper-create"),
    ref: z.string().min(1),
    title: z.string(),
    sa: z.string(),
    preparedBy: z.string().min(1),
    preparedAt: z.string().min(1),
    crossRefs: z.array(z.string()).optional(),
    partnerFlag: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("workpaper-add-note"),
    workpaper,
    note: z.object({
      id: z.string().min(1),
      raisedBy: z.string().min(1),
      raisedAt: z.string().min(1),
      text: z.string(),
    }),
  }),
  z.object({
    op: z.literal("workpaper-rectify-note"),
    workpaper,
    noteId: z.string().min(1),
    resolution: z.string(),
    resolvedBy: z.string().min(1),
    at: z.string().min(1),
  }),
  z.object({
    op: z.literal("workpaper-clear-note"),
    workpaper,
    noteId: z.string().min(1),
    clearedBy: z.string().min(1),
    at: z.string().min(1),
  }),
  z.object({
    op: z.literal("workpaper-review"),
    workpaper,
    reviewer: z.string().min(1),
    at: z.string().min(1),
  }),
  z.object({
    op: z.literal("workpaper-remark"),
    workpaper,
    by: z.string().min(1),
    at: z.string().min(1),
    remark: z.string(),
  }),
  z.object({
    op: z.literal("file-assembly"),
    workpapers: z.array(workpaper),
    requiredRefs: z.array(z.string()),
  }),

  // ---- 5. Evidence linking ------------------------------------------------
  z.object({
    op: z.literal("evidence-sufficiency"),
    evidence: z.array(evidenceItem),
    significantRisks: z.array(z.object({ account: z.string(), assertion })),
  }),
  z.object({
    op: z.literal("external-confirmation"),
    request: z.object({
      id: z.string().min(1),
      payee: z.string(),
      account: z.string(),
      requestedAmount: rupees,
      assertion,
      sentAt: z.string(),
    }),
    response: z
      .object({
        requestId: z.string().min(1),
        respondedAt: z.string(),
        confirmedAmount: rupees,
        exception: z.string().nullish(),
      })
      .nullable(),
  }),
  z.object({
    op: z.literal("bank-confirmation"),
    request: z.object({
      bank: z.string(),
      accountNumber: z.string(),
      asOf: z.string(),
      requestedBalance: rupees,
      requestedLienAmount: rupees.optional(),
    }),
    reply: z
      .object({
        respondedAt: z.string(),
        confirmedBalance: rupees,
        confirmedLienAmount: rupees.optional(),
        exception: z.string().nullish(),
      })
      .nullable(),
  }),
  z.object({
    op: z.literal("stock-inspection"),
    location: z.string(),
    date: z.string(),
    countedBy: z.string(),
    bookQuantity: z.number().finite(),
    countedQuantity: z.number().finite(),
    conditionNotes: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal("legal-correspondence"),
    correspondent: z.string(),
    receivedAt: z.string(),
    matters: z.array(z.string()),
    estimatedLiability: rupees.nullish(),
  }),
  z.object({
    op: z.literal("management-inquiry"),
    inquiredOf: z.string(),
    role: z.string(),
    date: z.string(),
    topics: z.array(z.string()),
    responses: z.array(z.string()),
  }),

  // ---- 6. Reporting -------------------------------------------------------
  z.object({
    op: z.literal("report"),
    entityName: z.string().min(1),
    financialYear: z.string().min(1),
    framework: z.string().min(1),
    uncorrectedMisstatements: rupees,
    materiality: positiveRupees,
    evidenceSufficient: z.boolean(),
    cause: z.enum(["misstatement", "scope-limitation", "none"]),
    pervasiveness: z.enum(["not-pervasive", "pervasive"]),
    goingConcern: z.object({ materialUncertainty: z.boolean(), appropriatelyDisclosed: z.boolean() }).nullish(),
    keyAuditMatters: z.array(z.object({ title: z.string(), description: z.string(), response: z.string() })).optional(),
    emphasisOfMatter: z.array(z.string()).optional(),
    otherMatter: z.array(z.string()).optional(),
    tcwgMatters: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal("classify-deficiency"),
    description: z.string(),
    likelihoodOfMisstatement: z.enum(["remote", "possible", "probable"]),
    magnitude: z.enum(["immaterial", "material", "significant"]),
    isEntityLevelOrIt: z.boolean(),
  }),
  z.object({
    op: z.literal("management-letter"),
    entityName: z.string().min(1),
    financialYear: z.string().min(1),
    deficiencies: z.array(deficiencyInput),
  }),
  z.object({
    op: z.literal("tcwg"),
    significantDeficiencies: z.array(z.string()).optional(),
    fraudOrSuspectedFraud: z.array(z.string()).optional(),
    significantRelatedPartyTransactions: z.array(z.string()).optional(),
    significantGoingConcernUncertainty: z.boolean().optional(),
    disagreementsWithManagement: z.array(z.string()).optional(),
    otherSignificantFindings: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal("reportable-conditions"),
    deficiencies: z.array(deficiencyInput),
  }),
]);

export type AuditAssuranceRequest = z.infer<typeof auditAssuranceInput>;

/**
 * Dispatch a validated op to the engine, converting rupee money fields to
 * paise. Returns the engine's result verbatim (it already carries its rule
 * trace), so the caller can surface it without a second transformation.
 */
export function computeAuditAssurance(input: AuditAssuranceRequest): unknown {
  switch (input.op) {
    case "independence":
      return evaluateIndependence(input.threats, input.safeguards);

    case "engagement-acceptance":
      return assessEngagementAcceptance({
        clientIntegrityConcern: input.clientIntegrityConcern,
        competenceAndResources: input.competenceAndResources,
        independenceAcceptable: input.independenceAcceptable,
        scopeAgreedInWriting: input.scopeAgreedInWriting,
        feeArrangement: input.feeArrangement,
        ethicalRequirementsComplianceConfirmed: input.ethicalRequirementsComplianceConfirmed,
      });

    case "engagement-letter":
      return { letter: renderEngagementLetter(input) };

    case "representation-letter":
      return {
        letter: renderManagementRepresentationLetter({
          entityName: input.entityName,
          financialYear: input.financialYear,
          periodEnd: input.periodEnd,
          auditorName: input.auditorName,
          auditorFirm: input.auditorFirm,
          additionalRepresentations: input.additionalRepresentations,
          qualifications: input.qualifications,
        }),
      };

    case "signed-assertions":
      return recordSignedAssertions(input.required, input.signed);

    case "entity-understanding":
      return understandEntity(input);

    case "risk-assessment":
      return assessRiskOfMaterialMisstatement(input.risks);

    case "internal-controls":
      return evaluateInternalControls(input.controls);

    case "itgc":
      return assessItGeneralControls(input.controls);

    case "fraud-risk":
      return assessFraudRisk(input);

    case "mus-plan":
      return musSampleSize({
        bookValue: paise(input.bookValue),
        tolerableMisstatement: paise(input.tolerableMisstatement),
        expectedMisstatement: paise(input.expectedMisstatement),
        confidence: input.confidence,
      });

    case "attribute-plan":
      return attributeSampleSize({
        confidence: input.confidence,
        tolerableDeviationRate: input.tolerableDeviationRate,
        expectedDeviationRate: input.expectedDeviationRate,
      });

    case "stratify":
      return stratifyPopulation(
        input.items.map((i) => ({ id: i.id, amount: paise(i.amount) })),
        input.bands.map(paise),
      );

    case "mus-evaluate":
      return evaluateMusResults({
        sampleItems: input.sampleItems.map((s) => ({ bookValue: paise(s.bookValue), auditValue: paise(s.auditValue) })),
        samplingInterval: paise(input.samplingInterval),
        confidence: input.confidence,
      });

    case "analytical-expectation":
      return developAnalyticalExpectation({
        account: input.account,
        baseAmount: paise(input.baseAmount),
        expectedChangePct: input.expectedChangePct,
        actualAmount: paise(input.actualAmount),
        materialityMinor: paise(input.materiality),
        thresholdPct: input.thresholdPct,
      });

    case "investigate-difference":
      return investigateDifference({
        difference: paise(input.difference),
        explanation: input.explanation,
        isMisstatement: input.isMisstatement,
        correctionMinor: input.correction !== undefined ? paise(input.correction) : undefined,
      });

    case "workpaper-create":
      return createWorkpaper({
        ref: input.ref,
        title: input.title,
        sa: input.sa,
        preparedBy: input.preparedBy,
        preparedAt: input.preparedAt,
        crossRefs: input.crossRefs,
        partnerFlag: input.partnerFlag,
      });

    case "workpaper-add-note":
      return addReviewNote(input.workpaper, input.note);

    case "workpaper-rectify-note":
      return rectifyReviewNote(input.workpaper, input.noteId, input.resolution, input.resolvedBy, input.at);

    case "workpaper-clear-note":
      return clearReviewNote(input.workpaper, input.noteId, input.clearedBy, input.at);

    case "workpaper-review":
      return reviewWorkpaper(input.workpaper, input.reviewer, input.at);

    case "workpaper-remark":
      return addRemark(input.workpaper, input.by, input.at, input.remark);

    case "file-assembly":
      return assembleAuditFile({ workpapers: input.workpapers, requiredRefs: input.requiredRefs });

    case "evidence-sufficiency":
      return evaluateEvidenceSufficiency(
        input.evidence.map((e) => ({
          ...e,
          tieOut: e.tieOut
            ? {
                bookAmount: paise(e.tieOut.bookAmount),
                agreedAmount: paise(e.tieOut.agreedAmount),
                difference: paise(e.tieOut.difference),
              }
            : null,
        })),
        input.significantRisks,
      );

    case "external-confirmation":
      return reconcileExternalConfirmation(
        { ...input.request, requestedAmount: paise(input.request.requestedAmount) },
        input.response ? { ...input.response, confirmedAmount: paise(input.response.confirmedAmount) } : null,
      );

    case "bank-confirmation":
      return reconcileBankConfirmation(
        {
          ...input.request,
          requestedBalance: paise(input.request.requestedBalance),
          requestedLienAmount:
            input.request.requestedLienAmount !== undefined ? paise(input.request.requestedLienAmount) : undefined,
        },
        input.reply
          ? {
              ...input.reply,
              confirmedBalance: paise(input.reply.confirmedBalance),
              confirmedLienAmount:
                input.reply.confirmedLienAmount !== undefined ? paise(input.reply.confirmedLienAmount) : undefined,
            }
          : null,
      );

    case "stock-inspection":
      return stockInspectionNote(input);

    case "legal-correspondence":
      return legalCorrespondenceNote({
        correspondent: input.correspondent,
        receivedAt: input.receivedAt,
        matters: input.matters,
        estimatedLiability: input.estimatedLiability != null ? paise(input.estimatedLiability) : null,
      });

    case "management-inquiry":
      return managementInquiryNote(input);

    case "report":
      return draftAuditReport({
        entityName: input.entityName,
        financialYear: input.financialYear,
        framework: input.framework,
        uncorrectedMisstatementsMinor: paise(input.uncorrectedMisstatements),
        materialityMinor: paise(input.materiality),
        evidenceSufficient: input.evidenceSufficient,
        cause: input.cause,
        pervasiveness: input.pervasiveness,
        goingConcern: input.goingConcern ?? null,
        keyAuditMatters: input.keyAuditMatters,
        emphasisOfMatter: input.emphasisOfMatter,
        otherMatter: input.otherMatter,
        tcwgMatters: input.tcwgMatters,
      });

    case "classify-deficiency":
      return classifyControlDeficiency(input);

    case "management-letter":
      return draftManagementLetter({
        entityName: input.entityName,
        financialYear: input.financialYear,
        deficiencies: input.deficiencies,
      });

    case "tcwg":
      return requireTcwgCommunication(input);

    case "reportable-conditions":
      return summarizeReportableConditions(input.deficiencies);
  }
}
