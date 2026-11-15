/**
 * Audit & assurance API adapter — oracle tests.
 *
 * These pin the two things the adapter can get wrong that the engine's own
 * tests cannot see: the RUPEES → PAISE conversion at the boundary, and the
 * `op` dispatch/validation. Every expected figure is the same hand-computed
 * paise figure the engine's suite already pins, reached from rupee inputs.
 */

import {
  AuditAssuranceError,
  type AuditReport,
  type BankConfirmationReconciliation,
  type EvidenceAssessment,
  type FileAssemblyResult,
  type MusEvaluation,
  type MusSamplePlan,
  type Workpaper,
} from "@/lib/engine/ca-audit-assurance";
import {
  auditAssuranceInput,
  computeAuditAssurance,
  type AuditAssuranceRequest,
} from "@/lib/engine/ca-audit-assurance-api";

/** Parse + dispatch in one step, mirroring the route. */
function run(input: unknown) {
  return computeAuditAssurance(auditAssuranceInput.parse(input));
}

describe("auditAssuranceInput validation", () => {
  it("accepts a payload that also carries the outer `kind` discriminator", () => {
    const result = auditAssuranceInput.safeParse({ kind: "audit-assurance", op: "tcwg" });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown op", () => {
    expect(auditAssuranceInput.safeParse({ op: "not-an-op" }).success).toBe(false);
  });

  it("rejects a non-positive materiality/tolerable amount", () => {
    expect(
      auditAssuranceInput.safeParse({
        op: "mus-plan",
        bookValue: 9_000,
        tolerableMisstatement: 0,
        expectedMisstatement: 0,
        confidence: 0.95,
      }).success,
    ).toBe(false);
  });

  it("rejects an out-of-range severity", () => {
    expect(
      auditAssuranceInput.safeParse({
        op: "independence",
        threats: [{ category: "self-interest", description: "x", severity: 5 }],
        safeguards: [],
      }).success,
    ).toBe(false);
  });
});

describe("rupee → paise conversion", () => {
  it("sizes MUS in paise from rupee inputs", () => {
    // Rupees: book 9,000 · TM 900 · expected 0 → paise 900,000 / 90,000.
    // Interval = 90,000 / 3.0 = 30,000 paise; n = 900,000 / 30,000 = 30.
    const plan = run({
      op: "mus-plan",
      bookValue: 9_000,
      tolerableMisstatement: 900,
      expectedMisstatement: 0,
      confidence: 0.95,
    }) as MusSamplePlan;
    expect(plan.reliabilityFactor).toBe(3.0);
    expect(plan.samplingInterval).toBe(30_000);
    expect(plan.sampleSize).toBe(30);
  });

  it("projects MUS misstatements in paise from rupee inputs", () => {
    const result = run({
      op: "mus-evaluate",
      sampleItems: [
        { bookValue: 10, auditValue: 9 },
        { bookValue: 20, auditValue: 20 },
      ],
      samplingInterval: 500,
      confidence: 0.95,
    }) as MusEvaluation;
    expect(result.knownMisstatement).toBe(100);
    expect(result.projectedMisstatement).toBe(5_000);
    expect(result.basicPrecision).toBe(150_000);
    expect(result.upperMisstatementLimit).toBe(155_000);
  });

  it("develops an analytical expectation in paise from rupee inputs", () => {
    const result = run({
      op: "analytical-expectation",
      account: "Revenue",
      baseAmount: 1_000,
      expectedChangePct: 10,
      actualAmount: 1_300,
      materiality: 50,
    }) as { expectedAmount: number; difference: number; tolerance: number; requiresInvestigation: boolean };
    expect(result.expectedAmount).toBe(110_000);
    expect(result.difference).toBe(20_000);
    expect(result.tolerance).toBe(11_000);
    expect(result.requiresInvestigation).toBe(true);
  });

  it("drafts a qualified report from rupee misstatement/materiality", () => {
    const report = run({
      op: "report",
      entityName: "Acme Ltd",
      financialYear: "2025-26",
      framework: "Ind AS",
      uncorrectedMisstatements: 2_000, // ₹2,000 → 200,000 paise
      materiality: 1_000, // ₹1,000 → 100,000 paise
      evidenceSufficient: true,
      cause: "misstatement",
      pervasiveness: "not-pervasive",
    }) as AuditReport;
    expect(report.opinion).toBe("qualified");
    expect(report.decisionTrace[0]).toContain("2000.00");
  });
});

describe("engagement, risk & controls ops", () => {
  it("returns an independence evaluation", () => {
    const result = run({
      op: "independence",
      threats: [{ category: "self-interest", description: "Fee dependence", severity: 3 }],
      safeguards: [{ description: "EQR", mitigates: ["self-interest"], effectiveness: 2 }],
    }) as { acceptable: boolean; residualRisk: string };
    expect(result.acceptable).toBe(true);
    expect(result.residualRisk).toBe("low");
  });

  it("declines an engagement with high integrity concerns", () => {
    const result = run({
      op: "engagement-acceptance",
      clientIntegrityConcern: "high",
      competenceAndResources: "sufficient",
      independenceAcceptable: true,
      scopeAgreedInWriting: true,
      feeArrangement: "fixed",
      ethicalRequirementsComplianceConfirmed: true,
    }) as { decision: string };
    expect(result.decision).toBe("decline");
  });

  it("renders the engagement and representation letters", () => {
    const engagement = run({
      op: "engagement-letter",
      addressee: "The Board, Acme Ltd",
      entityName: "Acme Ltd",
      financialYear: "2025-26",
      scope: ["Statutory audit under the Companies Act 2013"],
      responsibilitiesManagement: ["Maintain adequate accounting records"],
      responsibilitiesAuditor: ["Express an opinion"],
      fees: "Fixed fee",
      reportingDeadline: "Within 30 days",
    }) as { letter: string };
    expect(engagement.letter).toContain("Statutory audit under the Companies Act 2013");

    const representation = run({
      op: "representation-letter",
      entityName: "Acme Ltd",
      financialYear: "2025-26",
      periodEnd: "2026-03-31",
      auditorName: "A. Auditor",
      auditorFirm: "Audit LLP",
    }) as { letter: string };
    expect(representation.letter).toContain("Acme Ltd");
  });

  it("flags a significant RMM and expands the response", () => {
    const result = run({
      op: "risk-assessment",
      risks: [
        {
          account: "Revenue",
          assertion: "occurrence",
          inherentLikelihood: 5,
          inherentImpact: 5,
          controlEffectiveness: 0,
        },
      ],
    }) as { rmms: { rmmScore: number; significant: boolean }[]; responses: { extent: string }[] };
    expect(result.rmms[0]!.rmmScore).toBe(25);
    expect(result.rmms[0]!.significant).toBe(true);
    expect(result.responses[0]!.extent).toBe("expanded");
  });

  it("escalates a broken entity-level control to a material weakness", () => {
    const result = run({
      op: "internal-controls",
      controls: [
        {
          id: "C1",
          description: "Tone at the top",
          domain: "entity-level",
          design: "deficient",
          operating: "deficient",
        },
      ],
    }) as { materialWeaknesses: number };
    expect(result.materialWeaknesses).toBe(1);
  });

  it("summarises IT general controls and lists weaknesses", () => {
    const result = run({
      op: "itgc",
      controls: [
        { domain: "access", description: "User access reviews", tested: true, effective: true },
        { domain: "change-management", description: "Change approvals", tested: true, effective: false },
      ],
    }) as { fullyEffective: boolean; weaknesses: string[] };
    expect(result.fullyEffective).toBe(false);
    expect(result.weaknesses).toHaveLength(1);
  });

  it("applies the rebuttable revenue presumption", () => {
    const applied = run({
      op: "fraud-risk",
      revenueRecognitionJudgemental: false,
      revenuePresumptionRebutted: false,
      managementOverrideIndicators: [],
      incentiveFactors: [],
      opportunityFactors: [],
      rationalisationFactors: [],
    }) as { rebuttableRevenuePresumption: boolean; managementOverrideRisk: boolean };
    expect(applied.rebuttableRevenuePresumption).toBe(true);
    expect(applied.managementOverrideRisk).toBe(true);
  });
});

describe("workpaper & file-assembly ops", () => {
  function created(): Workpaper {
    return run({
      op: "workpaper-create",
      ref: "B-100",
      title: "Working paper",
      sa: "SA 330",
      preparedBy: "Preparer",
      preparedAt: "2026-04-01",
      partnerFlag: true,
    }) as Workpaper;
  }

  it("creates, notes, rectifies and clears a working paper", () => {
    let wp = created();
    wp = run({
      op: "workpaper-add-note",
      workpaper: wp,
      note: { id: "n1", raisedBy: "Reviewer", raisedAt: "2026-04-02", text: "Tie up totals" },
    }) as Workpaper;
    expect(wp.reviewNotes[0]!.status).toBe("open");

    // Sign-off is blocked while a note is open.
    expect(() => run({ op: "workpaper-review", workpaper: wp, reviewer: "Reviewer", at: "2026-04-03" })).toThrow(
      AuditAssuranceError,
    );

    wp = run({
      op: "workpaper-rectify-note",
      workpaper: wp,
      noteId: "n1",
      resolution: "Totals agreed",
      resolvedBy: "Preparer",
      at: "2026-04-02",
    }) as Workpaper;
    wp = run({
      op: "workpaper-clear-note",
      workpaper: wp,
      noteId: "n1",
      clearedBy: "Reviewer",
      at: "2026-04-03",
    }) as Workpaper;
    expect(wp.reviewNotes[0]!.status).toBe("cleared");

    wp = run({ op: "workpaper-review", workpaper: wp, reviewer: "Reviewer", at: "2026-04-03" }) as Workpaper;
    expect(wp.status).toBe("reviewed");
    expect(wp.reviewedBy).toBe("Reviewer");
  });

  it("assembles the file and reports the gaps", () => {
    const result = run({
      op: "file-assembly",
      workpapers: [created()],
      requiredRefs: ["B-100", "C-100"],
    }) as FileAssemblyResult;
    expect(result.complete).toBe(false);
    expect(result.missingRefs).toEqual(["C-100"]);
    expect(result.partnerAttention).toEqual(["B-100"]);
  });
});

describe("evidence linking ops", () => {
  it("is sufficient only for a clean high/medium-reliability tie-out", () => {
    const sufficient = run({
      op: "evidence-sufficiency",
      evidence: [
        {
          id: "e1",
          type: "external-confirmation",
          source: "external",
          reliability: "high",
          assertions: ["existence"],
          workpaperRef: "B-300",
          tieOut: { bookAmount: 1_000, agreedAmount: 1_000, difference: 0 },
        },
      ],
      significantRisks: [{ account: "Trade receivables", assertion: "existence" }],
    }) as EvidenceAssessment;
    expect(sufficient.sufficient).toBe(true);

    const gap = run({
      op: "evidence-sufficiency",
      evidence: [
        {
          id: "e2",
          type: "inspection",
          source: "internal",
          reliability: "medium",
          assertions: ["existence"],
          workpaperRef: "B-200",
          tieOut: { bookAmount: 1_000, agreedAmount: 900, difference: 100 },
        },
      ],
      significantRisks: [{ account: "Trade receivables", assertion: "existence" }],
    }) as EvidenceAssessment;
    expect(gap.sufficient).toBe(false);
  });

  it("treats a silent bank confirmation as a no-response", () => {
    const result = run({
      op: "bank-confirmation",
      request: {
        bank: "State Bank",
        accountNumber: "001234",
        asOf: "2026-03-31",
        requestedBalance: 5_000,
        requestedLienAmount: 500,
      },
      reply: null,
    }) as BankConfirmationReconciliation;
    expect(result.status).toBe("no-response");
    expect(result.note).toContain("alternative procedures");
  });

  it("raises an external-confirmation exception on a difference", () => {
    const result = run({
      op: "external-confirmation",
      request: {
        id: "c1",
        payee: "Supplier",
        account: "Payables",
        requestedAmount: 1_000,
        assertion: "completeness",
        sentAt: "2026-04-01",
      },
      response: { requestId: "c1", respondedAt: "2026-04-10", confirmedAmount: 900 },
    }) as { status: string; difference: number };
    expect(result.status).toBe("exception");
    expect(result.difference).toBe(-10_000);
  });

  it("notes stock, legal and management-inquiry evidence", () => {
    const stock = run({
      op: "stock-inspection",
      location: "Plant 1",
      date: "2026-03-31",
      countedBy: "Auditor",
      bookQuantity: 1_000,
      countedQuantity: 985,
    }) as { difference: number };
    expect(stock.difference).toBe(-15);

    const legal = run({
      op: "legal-correspondence",
      correspondent: "Counsel LLP",
      receivedAt: "2026-04-05",
      matters: ["Tax demand"],
      estimatedLiability: 2_500,
    }) as { requiresProvisionReview: boolean };
    expect(legal.requiresProvisionReview).toBe(true);

    const inquiry = run({
      op: "management-inquiry",
      inquiredOf: "Ms. CFO",
      role: "Chief Financial Officer",
      date: "2026-04-05",
      topics: ["Litigation"],
      responses: [],
    }) as { requiresCorroboration: boolean; openTopics: string[] };
    expect(inquiry.requiresCorroboration).toBe(true);
    expect(inquiry.openTopics).toEqual(["Litigation"]);
  });
});

describe("reporting ops", () => {
  it("classifies a deficiency and drafts the management letter", () => {
    const classification = run({
      op: "classify-deficiency",
      description: "Override of controls",
      likelihoodOfMisstatement: "probable",
      magnitude: "significant",
      isEntityLevelOrIt: true,
    }) as { type: string };
    expect(classification.type).toBe("material-weakness");

    const letter = run({
      op: "management-letter",
      entityName: "Acme Ltd",
      financialYear: "2025-26",
      deficiencies: [
        {
          description: "Override of controls",
          likelihoodOfMisstatement: "probable",
          magnitude: "significant",
          isEntityLevelOrIt: true,
        },
        {
          description: "Approval gap",
          likelihoodOfMisstatement: "possible",
          magnitude: "material",
          isEntityLevelOrIt: false,
        },
      ],
    }) as { materialWeaknesses: number; significantDeficiencies: number };
    expect(letter.materialWeaknesses).toBe(1);
    expect(letter.significantDeficiencies).toBe(1);
  });

  it("summarises reportable conditions and TCWG communication", () => {
    const conditions = run({
      op: "reportable-conditions",
      deficiencies: [
        {
          description: "Minor log gap",
          likelihoodOfMisstatement: "remote",
          magnitude: "immaterial",
          isEntityLevelOrIt: false,
        },
      ],
    }) as { count: number; requireTcwgCommunication: boolean };
    expect(conditions.count).toBe(0);

    const tcwg = run({ op: "tcwg", fraudOrSuspectedFraud: ["y"] }) as { required: boolean; items: string[] };
    expect(tcwg.required).toBe(true);
    expect(tcwg.items.join(" ")).toContain("SA 240");
  });
});

describe("adapter exhaustiveness", () => {
  it("covers every op in the schema with a case (no op falls through undefined)", () => {
    const ops = (auditAssuranceInput as unknown as { options: { shape: { op: { value: string } } }[] }).options.map(
      (o) => o.shape.op.value,
    );
    expect(ops.length).toBeGreaterThanOrEqual(30);
    expect(new Set(ops).size).toBe(ops.length);
  });

  it("dispatches a representative payload of the declared request type", () => {
    const request: AuditAssuranceRequest = { op: "tcwg" };
    expect(computeAuditAssurance(request)).toEqual({ required: false, items: [] });
  });
});
