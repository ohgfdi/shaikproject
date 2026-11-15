/**
 * Audit & assurance practice engine — oracle tests.
 *
 * Every figure here is hand-computed so a rule in the engine can be challenged
 * against the arithmetic, not against the engine's own output.
 */

import {
  AuditAssuranceError,
  WRITTEN_REPRESENTATIONS,
  FINANCIAL_STATEMENT_ASSERTIONS,
  evaluateIndependence,
  assessEngagementAcceptance,
  renderManagementRepresentationLetter,
  understandEntity,
  assessRiskOfMaterialMisstatement,
  evaluateInternalControls,
  assessFraudRisk,
  musSampleSize,
  attributeSampleSize,
  stratifyPopulation,
  evaluateMusResults,
  developAnalyticalExpectation,
  investigateDifference,
  createWorkpaper,
  addReviewNote,
  rectifyReviewNote,
  clearReviewNote,
  reviewWorkpaper,
  addRemark,
  assembleAuditFile,
  evaluateEvidenceSufficiency,
  reconcileExternalConfirmation,
  stockInspectionNote,
  legalCorrespondenceNote,
  draftAuditReport,
  classifyControlDeficiency,
  draftManagementLetter,
  requireTcwgCommunication,
  renderEngagementLetter,
  recordSignedAssertions,
  assessItGeneralControls,
  reconcileBankConfirmation,
  managementInquiryNote,
  summarizeReportableConditions,
  type EvidenceItem,
} from "@/lib/engine/ca-audit-assurance";

describe("evaluateIndependence", () => {
  it("reduces a threat to acceptable residual risk with a safeguard", () => {
    const result = evaluateIndependence(
      [{ category: "self-interest", description: "Fee dependence", severity: 3 }],
      [{ description: "Engagement quality review", mitigates: ["self-interest"], effectiveness: 2 }],
    );
    expect(result.acceptable).toBe(true);
    expect(result.residualRisk).toBe("low");
    expect(result.mitigations).toHaveLength(1);
    expect(result.mitigations[0]!.after).toBe(1);
  });

  it("flags an unmitigated high-severity threat as unacceptable", () => {
    const result = evaluateIndependence(
      [{ category: "familiarity", description: "Long association", severity: 3 }],
      [],
    );
    expect(result.acceptable).toBe(false);
    expect(result.residualRisk).toBe("high");
    expect(result.unresolved).toHaveLength(1);
  });
});

describe("assessEngagementAcceptance", () => {
  const base = {
    clientIntegrityConcern: "low" as const,
    competenceAndResources: "sufficient" as const,
    independenceAcceptable: true,
    scopeAgreedInWriting: true,
    feeArrangement: "fixed" as const,
    ethicalRequirementsComplianceConfirmed: true,
  };

  it("accepts a clean engagement", () => {
    const result = assessEngagementAcceptance(base);
    expect(result.decision).toBe("accept");
    expect(result.conditions).toHaveLength(0);
  });

  it("declines when integrity concerns are high", () => {
    const result = assessEngagementAcceptance({ ...base, clientIntegrityConcern: "high" });
    expect(result.decision).toBe("decline");
    expect(result.reasons.join(" ")).toContain("integrity");
  });

  it("accepts with conditions when scope or fees are unresolved", () => {
    const result = assessEngagementAcceptance({
      ...base,
      scopeAgreedInWriting: false,
      feeArrangement: "contingent",
    });
    expect(result.decision).toBe("accept-with-conditions");
    expect(result.conditions.length).toBeGreaterThanOrEqual(2);
  });
});

describe("renderManagementRepresentationLetter", () => {
  it("includes the standard representations and any qualification", () => {
    const letter = renderManagementRepresentationLetter({
      entityName: "Acme Ltd",
      financialYear: "2025-26",
      periodEnd: "2026-03-31",
      auditorName: "A. Auditor",
      auditorFirm: "Audit LLP",
      qualifications: ["Inventory at branch not counted"],
    });
    expect(letter).toContain("Acme Ltd");
    expect(letter).toContain(WRITTEN_REPRESENTATIONS[0]!);
    expect(letter).toContain("Inventory at branch not counted");
  });
});

describe("understandEntity", () => {
  it("marks documentation complete when every section is populated", () => {
    const result = understandEntity({
      natureOfBusiness: "Manufacturing",
      industryAndRegulatory: ["Factories Act"],
      applicableFramework: "Ind AS",
      ownershipAndGovernance: ["Promoter family"],
      keyAccountingPolicies: ["Revenue recognition"],
      objectivesAndStrategies: ["Expand capacity"],
      measurementAndReviewOfFinancialPerformance: ["Monthly MIS"],
      significantChanges: ["New plant"],
    });
    expect(result.sections).toHaveLength(8);
    expect(result.documentationComplete).toBe(true);
  });
});

describe("assessRiskOfMaterialMisstatement", () => {
  it("flags a significant risk and expands the response when controls are absent", () => {
    const result = assessRiskOfMaterialMisstatement([
      {
        account: "Revenue",
        assertion: "occurrence",
        inherentLikelihood: 5,
        inherentImpact: 5,
        controlEffectiveness: 0,
      },
    ]);
    expect(result.rmms[0]!.rmmScore).toBe(25);
    expect(result.rmms[0]!.significant).toBe(true);
    expect(result.significantRisks).toHaveLength(1);
    expect(result.responses[0]!.response).toBe("substantive");
    expect(result.responses[0]!.extent).toBe("expanded");
  });

  it("reduces the risk to nil and relies on controls when they are fully effective", () => {
    const result = assessRiskOfMaterialMisstatement([
      { account: "Cash", assertion: "existence", inherentLikelihood: 3, inherentImpact: 3, controlEffectiveness: 1 },
    ]);
    expect(result.rmms[0]!.rmmScore).toBe(0);
    expect(result.rmms[0]!.significant).toBe(false);
    expect(result.responses[0]!.response).toBe("test-of-controls");
    expect(result.responses[0]!.extent).toBe("reduced");
  });

  it("counts assertion coverage per account", () => {
    const result = assessRiskOfMaterialMisstatement([
      {
        account: "Revenue",
        assertion: "occurrence",
        inherentLikelihood: 2,
        inherentImpact: 2,
        controlEffectiveness: 0.5,
      },
      { account: "Revenue", assertion: "cut-off", inherentLikelihood: 2, inherentImpact: 2, controlEffectiveness: 0.5 },
    ]);
    expect(result.assertionCoverage.Revenue).toBe(2);
  });

  it("exposes the assertion vocabulary used by evidence linking", () => {
    expect(FINANCIAL_STATEMENT_ASSERTIONS).toContain("completeness");
    expect(FINANCIAL_STATEMENT_ASSERTIONS).toContain("existence");
  });
});

describe("evaluateInternalControls", () => {
  it("escalates a broken entity-level control to a material weakness", () => {
    const result = evaluateInternalControls([
      { id: "C1", description: "Tone at the top", domain: "entity-level", design: "deficient", operating: "deficient" },
    ]);
    expect(result.deficiencies[0]!.type).toBe("material-weakness");
    expect(result.materialWeaknesses).toBe(1);
  });

  it("treats a design-only failure as a significant deficiency", () => {
    const result = evaluateInternalControls([
      { id: "C2", description: "Invoice approval", domain: "transaction", design: "deficient", operating: "effective" },
    ]);
    expect(result.deficiencies[0]!.type).toBe("significant-deficiency");
  });

  it("treats an operating-only failure in a transaction control as a deficiency", () => {
    const result = evaluateInternalControls([
      {
        id: "C3",
        description: "Reconciliation review",
        domain: "transaction",
        design: "effective",
        operating: "deficient",
      },
    ]);
    expect(result.deficiencies[0]!.type).toBe("deficiency");
    expect(result.overallAssessment).toContain("Deficiencies identified");
  });
});

describe("assessFraudRisk", () => {
  const none = {
    revenueRecognitionJudgemental: false,
    revenuePresumptionRebutted: false,
    managementOverrideIndicators: [],
    incentiveFactors: [],
    opportunityFactors: [],
    rationalisationFactors: [],
  };

  it("applies the rebuttable revenue presumption and management override risk", () => {
    const result = assessFraudRisk(none);
    expect(result.rebuttableRevenuePresumption).toBe(true);
    expect(result.managementOverrideRisk).toBe(true);
    expect(result.significantFraudRisks.join(" ")).toContain("Management override");
  });

  it("honours a documented rebuttal of the revenue presumption", () => {
    const result = assessFraudRisk({ ...none, revenuePresumptionRebutted: true });
    expect(result.rebuttableRevenuePresumption).toBe(false);
  });

  it("adds a fraud-triangle finding when two or more indicator families are present", () => {
    const result = assessFraudRisk({
      ...none,
      incentiveFactors: ["Bonuses tied to revenue"],
      opportunityFactors: ["Weak segregation"],
    });
    expect(result.significantFraudRisks).toContain("Fraud triangle indicators present");
    expect(result.triangle.incentive).toBe(1);
    expect(result.triangle.opportunity).toBe(1);
  });
});

describe("musSampleSize", () => {
  it("sizes on the sampling interval", () => {
    const plan = musSampleSize({
      bookValue: 900_000,
      tolerableMisstatement: 90_000,
      expectedMisstatement: 0,
      confidence: 0.95,
    });
    expect(plan.reliabilityFactor).toBe(3.0);
    expect(plan.samplingInterval).toBe(30_000);
    expect(plan.sampleSize).toBe(30);
  });

  it("reduces the interval and grows the sample when misstatement is expected", () => {
    const plan = musSampleSize({
      bookValue: 900_000,
      tolerableMisstatement: 90_000,
      expectedMisstatement: 30_000,
      confidence: 0.95,
    });
    expect(plan.samplingInterval).toBe(20_000);
    expect(plan.sampleSize).toBe(45);
  });

  it("rejects a non-positive tolerable misstatement", () => {
    expect(() =>
      musSampleSize({ bookValue: 100, tolerableMisstatement: 0, expectedMisstatement: 0, confidence: 0.95 }),
    ).toThrow(AuditAssuranceError);
  });
});

describe("attributeSampleSize", () => {
  it("returns the base size for zero expected deviation", () => {
    expect(
      attributeSampleSize({ confidence: 0.95, tolerableDeviationRate: 0.05, expectedDeviationRate: 0 }).sampleSize,
    ).toBe(28);
  });

  it("pads the sample for an expected deviation", () => {
    expect(
      attributeSampleSize({ confidence: 0.95, tolerableDeviationRate: 0.05, expectedDeviationRate: 0.01 }).sampleSize,
    ).toBe(34);
  });
});

describe("stratifyPopulation", () => {
  it("bands the population and sizes each stratum by value share", () => {
    const result = stratifyPopulation(
      [
        { id: "a", amount: 5_000 },
        { id: "b", amount: 50_000 },
        { id: "c", amount: 200_000 },
      ],
      [0, 10_000, 100_000],
    );
    expect(result.totalItems).toBe(3);
    expect(result.totalBookValue).toBe(255_000);
    expect(result.strata.map((s) => s.items)).toEqual([1, 1, 1]);
    expect(result.strata[2]!.bookValue).toBe(200_000);
  });
});

describe("evaluateMusResults", () => {
  it("projects tainting and adds basic precision", () => {
    const result = evaluateMusResults({
      sampleItems: [
        { bookValue: 1_000, auditValue: 900 },
        { bookValue: 2_000, auditValue: 2_000 },
      ],
      samplingInterval: 50_000,
      confidence: 0.95,
    });
    expect(result.knownMisstatement).toBe(100);
    expect(result.projectedMisstatement).toBe(5_000);
    expect(result.basicPrecision).toBe(150_000);
    expect(result.upperMisstatementLimit).toBe(155_000);
    expect(result.conclusion).toBe("within-tolerable");
  });
});

describe("developAnalyticalExpectation", () => {
  it("flags a difference beyond the greater of materiality and the tolerance", () => {
    const result = developAnalyticalExpectation({
      account: "Revenue",
      baseAmount: 100_000,
      expectedChangePct: 10,
      actualAmount: 130_000,
      materialityMinor: 5_000,
    });
    expect(result.expectedAmount).toBe(110_000);
    expect(result.difference).toBe(20_000);
    expect(result.tolerance).toBe(11_000);
    expect(result.requiresInvestigation).toBe(true);
  });

  it("does not flag a difference within tolerance", () => {
    const result = developAnalyticalExpectation({
      account: "Revenue",
      baseAmount: 100_000,
      expectedChangePct: 10,
      actualAmount: 115_000,
      materialityMinor: 5_000,
    });
    expect(result.requiresInvestigation).toBe(false);
  });
});

describe("investigateDifference", () => {
  it("concludes no error for an explained non-misstatement", () => {
    expect(investigateDifference({ difference: 1_000, explanation: "Timing", isMisstatement: false }).conclusion).toBe(
      "no-error",
    );
  });

  it("concludes corrected / uncorrected / unexplained appropriately", () => {
    expect(
      investigateDifference({ difference: 1_000, explanation: "Error", isMisstatement: true, correctionMinor: 1_000 })
        .conclusion,
    ).toBe("misstatement-corrected");
    expect(investigateDifference({ difference: 1_000, explanation: "Error", isMisstatement: true }).conclusion).toBe(
      "misstatement-uncorrected",
    );
    expect(investigateDifference({ difference: 1_000, explanation: "  ", isMisstatement: true }).conclusion).toBe(
      "unexplained",
    );
  });
});

describe("workpaper system", () => {
  function prepared(ref: string) {
    return createWorkpaper({
      ref,
      title: "Working paper",
      sa: "SA 330",
      preparedBy: "Preparer",
      preparedAt: "2026-04-01",
    });
  }

  it("creates a prepared working paper with versioned remarks", () => {
    const wp = prepared("B-100");
    expect(wp.status).toBe("prepared");
    expect(wp.version).toBe(1);
    expect(wp.remarks).toHaveLength(1);
  });

  it("blocks sign-off while a review note is open", () => {
    const wp = addReviewNote(prepared("B-100"), {
      id: "n1",
      raisedBy: "Reviewer",
      raisedAt: "2026-04-02",
      text: "Tie up totals",
    });
    expect(wp.reviewNotes[0]!.status).toBe("open");
    expect(() => reviewWorkpaper(wp, "Reviewer", "2026-04-03")).toThrow(AuditAssuranceError);
  });

  it("flows a note through addressed and cleared before sign-off", () => {
    let wp = addReviewNote(prepared("B-100"), {
      id: "n1",
      raisedBy: "Reviewer",
      raisedAt: "2026-04-02",
      text: "Tie up totals",
    });
    wp = rectifyReviewNote(wp, "n1", "Totals agreed", "Preparer", "2026-04-02");
    expect(wp.reviewNotes[0]!.status).toBe("addressed");
    wp = clearReviewNote(wp, "n1", "Reviewer", "2026-04-03");
    expect(wp.reviewNotes[0]!.status).toBe("cleared");
    wp = reviewWorkpaper(wp, "Reviewer", "2026-04-03");
    expect(wp.status).toBe("reviewed");
    expect(wp.reviewedBy).toBe("Reviewer");
    expect(wp.version).toBeGreaterThan(1);
  });

  it("assembles the file and reports gaps", () => {
    const a = prepared("A-100");
    const b = addReviewNote(
      createWorkpaper({
        ref: "B-100",
        title: "Evidence",
        sa: "SA 500",
        preparedBy: "Preparer",
        preparedAt: "2026-04-01",
        partnerFlag: true,
      }),
      { id: "n1", raisedBy: "Reviewer", raisedAt: "2026-04-02", text: "Open point" },
    );
    const result = assembleAuditFile({ workpapers: [a, b], requiredRefs: ["A-100", "B-100", "C-100"] });
    expect(result.complete).toBe(false);
    expect(result.missingRefs).toEqual(["C-100"]);
    expect(result.unsigned).toEqual(["A-100", "B-100"]);
    expect(result.openReviewNotes).toHaveLength(1);
    expect(result.partnerAttention).toEqual(["B-100"]);
    expect(result.bySa["SA 500"]).toBe(1);
  });

  it("adds a versioned remark without changing review state", () => {
    const wp = addRemark(prepared("A-100"), "Reviewer", "2026-04-04", "Cleared with the partner");
    expect(wp.version).toBe(2);
    expect(wp.remarks.at(-1)!.remark).toContain("partner");
  });
});

describe("evaluateEvidenceSufficiency", () => {
  it("is sufficient when a high-reliability item with a clean tie-out supports the risk", () => {
    const evidence: EvidenceItem[] = [
      {
        id: "e1",
        type: "external-confirmation",
        source: "external",
        reliability: "high",
        assertions: ["existence"],
        workpaperRef: "B-300",
        tieOut: { bookAmount: 100_000, agreedAmount: 100_000, difference: 0 },
      },
    ];
    const result = evaluateEvidenceSufficiency(evidence, [{ account: "Trade receivables", assertion: "existence" }]);
    expect(result.sufficient).toBe(true);
    expect(result.reliabilityMix.high).toBe(1);
  });

  it("raises a gap when nothing supports the assertion", () => {
    const result = evaluateEvidenceSufficiency([], [{ account: "Revenue", assertion: "occurrence" }]);
    expect(result.sufficient).toBe(false);
    expect(result.gaps[0]!.account).toBe("Revenue");
  });

  it("does not count evidence whose tie-out does not agree", () => {
    const evidence: EvidenceItem[] = [
      {
        id: "e2",
        type: "inspection",
        source: "internal",
        reliability: "medium",
        assertions: ["existence"],
        workpaperRef: "B-200",
        tieOut: { bookAmount: 100_000, agreedAmount: 90_000, difference: 10_000 },
      },
    ];
    const result = evaluateEvidenceSufficiency(evidence, [{ account: "Trade receivables", assertion: "existence" }]);
    expect(result.sufficient).toBe(false);
  });
});

describe("reconcileExternalConfirmation", () => {
  const request = {
    id: "c1",
    payee: "Supplier",
    account: "Payables",
    requestedAmount: 100_000,
    assertion: "completeness" as const,
    sentAt: "2026-04-01",
  };

  it("treats an unreturned request as a no-response", () => {
    const result = reconcileExternalConfirmation(request, null);
    expect(result.status).toBe("no-response");
    expect(result.difference).toBe(100_000);
    expect(result.note).toContain("alternative procedures");
  });

  it("confirms an agreeing response", () => {
    const result = reconcileExternalConfirmation(request, {
      requestId: "c1",
      respondedAt: "2026-04-10",
      confirmedAmount: 100_000,
    });
    expect(result.status).toBe("confirmed");
    expect(result.difference).toBe(0);
  });

  it("raises an exception on a difference or a stated exception", () => {
    expect(
      reconcileExternalConfirmation(request, { requestId: "c1", respondedAt: "2026-04-10", confirmedAmount: 90_000 })
        .status,
    ).toBe("exception");
    expect(
      reconcileExternalConfirmation(request, {
        requestId: "c1",
        respondedAt: "2026-04-10",
        confirmedAmount: 100_000,
        exception: "Goods returned",
      }).status,
    ).toBe("exception");
  });
});

describe("stock inspection & legal correspondence", () => {
  it("computes the count difference", () => {
    const note = stockInspectionNote({
      location: "Plant 1",
      date: "2026-03-31",
      countedBy: "Auditor",
      bookQuantity: 1_000,
      countedQuantity: 985,
    });
    expect(note.difference).toBe(-15);
    expect(note.note).toContain("Plant 1");
  });

  it("flags a provision review when legal matters are reported", () => {
    const note = legalCorrespondenceNote({
      correspondent: "Counsel LLP",
      receivedAt: "2026-04-05",
      matters: ["Tax demand"],
      estimatedLiability: 250_000,
    });
    expect(note.requiresProvisionReview).toBe(true);
    expect(note.note).toContain("Tax demand");
  });
});

describe("draftAuditReport", () => {
  const base = {
    entityName: "Acme Ltd",
    financialYear: "2025-26",
    framework: "Ind AS",
    materialityMinor: 100_000,
    evidenceSufficient: true,
    pervasiveness: "not-pervasive" as const,
  };

  it("issues an unmodified opinion when there is no cause", () => {
    const report = draftAuditReport({ ...base, uncorrectedMisstatementsMinor: 0, cause: "none" });
    expect(report.opinion).toBe("unqualified");
    expect(report.requiresKeyAuditMatters).toBe(false);
    expect(report.requiresEmphasisOfMatter).toBe(false);
    expect(report.opinionParagraph).toContain("Acme Ltd");
  });

  it("maps the SA 705 decision table", () => {
    expect(draftAuditReport({ ...base, uncorrectedMisstatementsMinor: 200_000, cause: "misstatement" }).opinion).toBe(
      "qualified",
    );
    expect(
      draftAuditReport({
        ...base,
        uncorrectedMisstatementsMinor: 200_000,
        cause: "misstatement",
        pervasiveness: "pervasive",
      }).opinion,
    ).toBe("adverse");
    expect(
      draftAuditReport({
        ...base,
        uncorrectedMisstatementsMinor: 200_000,
        cause: "scope-limitation",
        pervasiveness: "pervasive",
      }).opinion,
    ).toBe("disclaimer");
  });

  it("adds EOM, KAM and Other Matter sections when required", () => {
    const report = draftAuditReport({
      ...base,
      uncorrectedMisstatementsMinor: 0,
      cause: "none",
      goingConcern: { materialUncertainty: true, appropriatelyDisclosed: true },
      keyAuditMatters: [{ title: "Revenue", description: "Cut-off", response: "Tested" }],
      otherMatter: ["Prior-year comparatives restated"],
    });
    expect(report.requiresEmphasisOfMatter).toBe(true);
    expect(report.requiresKeyAuditMatters).toBe(true);
    expect(report.sections.map((s) => s.heading)).toEqual(
      expect.arrayContaining(["Emphasis of Matter", "Key Audit Matters", "Other Matter"]),
    );
    expect(report.communicationWithTcwg.length).toBeGreaterThan(0);
  });

  it("rejects non-positive materiality", () => {
    expect(() =>
      draftAuditReport({ ...base, materialityMinor: 0, uncorrectedMisstatementsMinor: 0, cause: "none" }),
    ).toThrow(AuditAssuranceError);
  });
});

describe("deficiency classification & management letter", () => {
  it("classifies deficiencies by likelihood and magnitude", () => {
    expect(
      classifyControlDeficiency({
        description: "x",
        likelihoodOfMisstatement: "probable",
        magnitude: "significant",
        isEntityLevelOrIt: false,
      }).type,
    ).toBe("material-weakness");
    expect(
      classifyControlDeficiency({
        description: "x",
        likelihoodOfMisstatement: "possible",
        magnitude: "material",
        isEntityLevelOrIt: false,
      }).type,
    ).toBe("significant-deficiency");
    expect(
      classifyControlDeficiency({
        description: "x",
        likelihoodOfMisstatement: "remote",
        magnitude: "immaterial",
        isEntityLevelOrIt: false,
      }).type,
    ).toBe("deficiency");
  });

  it("drafts a management letter and counts the escalations", () => {
    const letter = draftManagementLetter({
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
        {
          description: "Minor log gap",
          likelihoodOfMisstatement: "remote",
          magnitude: "immaterial",
          isEntityLevelOrIt: false,
        },
      ],
    });
    expect(letter.materialWeaknesses).toBe(1);
    expect(letter.significantDeficiencies).toBe(1);
    expect(letter.requireTcwgCommunication).toBe(true);
  });
});

describe("requireTcwgCommunication", () => {
  it("requires nothing when there are no matters", () => {
    expect(requireTcwgCommunication({}).required).toBe(false);
  });

  it("requires communication of significant deficiencies and fraud", () => {
    const result = requireTcwgCommunication({ significantDeficiencies: ["x"], fraudOrSuspectedFraud: ["y"] });
    expect(result.required).toBe(true);
    expect(result.items.join(" ")).toContain("SA 265");
    expect(result.items.join(" ")).toContain("SA 240");
  });
});

describe("engagement letter (scope documentation)", () => {
  it("documents scope, responsibilities and sign-off", () => {
    const letter = renderEngagementLetter({
      addressee: "The Board, Acme Ltd",
      entityName: "Acme Ltd",
      financialYear: "2025-26",
      scope: ["Statutory audit under the Companies Act 2013"],
      responsibilitiesManagement: ["Maintain adequate accounting records"],
      responsibilitiesAuditor: ["Express an opinion on the financial statements"],
      fees: "Fixed fee of ₹X plus applicable taxes",
      reportingDeadline: "Within 30 days of signing the financial statements",
      otherMatters: ["Independence confirmed"],
    });
    expect(letter).toContain("Statutory audit under the Companies Act 2013");
    expect(letter).toContain("Fixed fee of ₹X");
    expect(letter).toContain("Independence confirmed");
    expect(letter).toContain("Yours faithfully");
  });
});

describe("recordSignedAssertions", () => {
  it("reports the assertions still unsigned", () => {
    const required = [
      { account: "Revenue", assertion: "occurrence" as const },
      { account: "Revenue", assertion: "completeness" as const },
    ];
    const partial = recordSignedAssertions(required, [
      { account: "Revenue", assertion: "occurrence", signedBy: "CFO", signedAt: "2026-04-05" },
    ]);
    expect(partial.complete).toBe(false);
    expect(partial.missing).toEqual([{ account: "Revenue", assertion: "completeness" }]);

    const complete = recordSignedAssertions(required, [
      { account: "Revenue", assertion: "occurrence", signedBy: "CFO", signedAt: "2026-04-05" },
      { account: "Revenue", assertion: "completeness", signedBy: "CFO", signedAt: "2026-04-05" },
    ]);
    expect(complete.complete).toBe(true);
    expect(complete.covered).toHaveLength(2);
  });
});

describe("assessItGeneralControls", () => {
  it("summarises coverage by ITGC domain and lists weaknesses", () => {
    const result = assessItGeneralControls([
      { domain: "access", description: "User access reviews", tested: true, effective: true },
      { domain: "change-management", description: "Change approvals", tested: true, effective: false },
    ]);
    expect(result.byDomain.access).toEqual({ total: 1, tested: 1, effective: 1 });
    expect(result.fullyEffective).toBe(false);
    expect(result.weaknesses).toHaveLength(1);
  });

  it("reports fully effective when every tested control is effective", () => {
    const result = assessItGeneralControls([
      { domain: "backup-recovery", description: "Off-site backups", tested: true, effective: true },
    ]);
    expect(result.fullyEffective).toBe(true);
    expect(result.weaknesses).toHaveLength(0);
  });
});

describe("reconcileBankConfirmation", () => {
  const request = {
    bank: "State Bank",
    accountNumber: "001234",
    asOf: "2026-03-31",
    requestedBalance: 500_000,
    requestedLienAmount: 50_000,
  };

  it("treats silence as a no-response", () => {
    const result = reconcileBankConfirmation(request, null);
    expect(result.status).toBe("no-response");
    expect(result.note).toContain("alternative procedures");
  });

  it("confirms an agreeing reply", () => {
    const result = reconcileBankConfirmation(request, {
      respondedAt: "2026-04-08",
      confirmedBalance: 500_000,
      confirmedLienAmount: 50_000,
    });
    expect(result.status).toBe("confirmed");
    expect(result.balanceDifference).toBe(0);
    expect(result.lienDifference).toBe(0);
  });

  it("raises an exception on a balance difference, an undisclosed lien or a stated exception", () => {
    expect(
      reconcileBankConfirmation(request, {
        respondedAt: "2026-04-08",
        confirmedBalance: 480_000,
        confirmedLienAmount: 50_000,
      }).status,
    ).toBe("exception");
    expect(
      reconcileBankConfirmation(request, {
        respondedAt: "2026-04-08",
        confirmedBalance: 500_000,
        confirmedLienAmount: 0,
      }).lienDifference,
    ).toBe(-50_000);
    expect(
      reconcileBankConfirmation(request, {
        respondedAt: "2026-04-08",
        confirmedBalance: 500_000,
        confirmedLienAmount: 50_000,
        exception: "Cheque in transit",
      }).status,
    ).toBe("exception");
  });
});

describe("managementInquiryNote", () => {
  it("always flags that inquiry needs corroboration", () => {
    const result = managementInquiryNote({
      inquiredOf: "Ms. CFO",
      role: "Chief Financial Officer",
      date: "2026-04-05",
      topics: ["Related-party transactions"],
      responses: ["None other than disclosed"],
    });
    expect(result.requiresCorroboration).toBe(true);
    expect(result.openTopics).toHaveLength(0);
    expect(result.note).toContain("Related-party transactions");
  });

  it("leaves a topic open when no response was recorded", () => {
    const result = managementInquiryNote({
      inquiredOf: "Mr. Director",
      role: "Director",
      date: "2026-04-05",
      topics: ["Litigation"],
      responses: [],
    });
    expect(result.openTopics).toEqual(["Litigation"]);
  });
});

describe("summarizeReportableConditions", () => {
  it("reports only significant deficiencies and material weaknesses", () => {
    const result = summarizeReportableConditions([
      {
        description: "Override risk",
        likelihoodOfMisstatement: "probable",
        magnitude: "significant",
        isEntityLevelOrIt: true,
      },
      {
        description: "Minor log gap",
        likelihoodOfMisstatement: "remote",
        magnitude: "immaterial",
        isEntityLevelOrIt: false,
      },
    ]);
    expect(result.count).toBe(1);
    expect(result.requireTcwgCommunication).toBe(true);
    expect(result.reportable[0]!.type).toBe("material-weakness");
  });

  it("reports none when no condition rises to reportable", () => {
    const result = summarizeReportableConditions([
      {
        description: "Minor log gap",
        likelihoodOfMisstatement: "remote",
        magnitude: "immaterial",
        isEntityLevelOrIt: false,
      },
    ]);
    expect(result.count).toBe(0);
    expect(result.requireTcwgCommunication).toBe(false);
  });
});
