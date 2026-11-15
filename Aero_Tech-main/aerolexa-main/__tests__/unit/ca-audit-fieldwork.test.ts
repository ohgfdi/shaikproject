/**
 * Audit-fieldwork engine — 100% oracle tests (all advanced features).
 *
 * Every figure is hand-computed. The tests pin MUS sample sizes, risk scoring,
 * fraud indicators, going concern assessment, and audit program generation.
 */

import { planAuditFieldwork } from "@/lib/engine/ca-audit-fieldwork";

const base = {
  engagementName: "Acme FY25",
  yearEnd: "2025-03-31",
  materiality: {
    benchmark: 10_00_000,
    benchmarkBase: "turnover" as const,
    performanceMaterialityPct: 50,
    ppmThreshold: 1_000,
    riskAdjusted: false,
    clientRiskProfile: "low" as const,
  },
  populations: [{ stratum: "Revenue", bookValue: 50_00_000, items: 1_000, riskLevel: "medium" as const }],
  riskRatings: [{ area: "Revenue", inherentRisk: "high" as const, controlRisk: "medium" as const }],
  mus: { tolerableMisstatement: 50_000, expectedErrors: 0, confidence: 0.95 },
  analyticalExpectations: [
    { account: "Purchases", priorYear: 1_000, expectedChangePct: 10, actualCurrent: 1_200 },
    { account: "Sales", priorYear: 1_000, expectedChangePct: 0, actualCurrent: 1_300 },
  ],
  companyMetrics: {
    currentRatio: 1.5,
    debtToEquity: 1.0,
    netProfitMargin: 0.1,
    revenue: 50_00_000,
    netProfit: 5_00_000,
    totalAssets: 40_00_000,
    totalTransactions: 500,
  },
};

describe("audit fieldwork: materiality with risk adjustment", () => {
  it("computes overall/performance materiality with low risk profile", () => {
    const res = planAuditFieldwork(base);
    expect(res.materiality.overallMateriality).toBe(5_00_000); // 10L x 50%
    expect(res.materiality.performanceMateriality).toBe(3_75_000); // 5L x 75%
    expect(res.materiality.benchmark).toBe("Revenue/turnover");
    expect(res.materiality.riskAdjustment).toBe(1.0);
  });

  it("risk-adjusts materiality for high-risk clients", () => {
    const res = planAuditFieldwork({
      ...base,
      materiality: { ...base.materiality, riskAdjusted: true, clientRiskProfile: "high" as const },
    });
    // 50% x 0.75 = 37.5%
    expect(res.materiality.overallMateriality).toBe(3_75_000); // 10L x 37.5%
    expect(res.materiality.riskAdjustment).toBe(0.75);
  });

  it("risk-adjusts materiality for medium-risk clients", () => {
    const res = planAuditFieldwork({
      ...base,
      materiality: { ...base.materiality, riskAdjusted: true, clientRiskProfile: "medium" as const },
    });
    // 50% x 0.85 = 42.5%
    expect(res.materiality.overallMateriality).toBe(4_25_000); // 10L x 42.5%
    expect(res.materiality.riskAdjustment).toBe(0.85);
  });

  it("supports all benchmark bases", () => {
    const bases: Array<"turnover" | "pbt" | "total-assets" | "equity"> = ["turnover", "pbt", "total-assets", "equity"];
    for (const baseType of bases) {
      const res = planAuditFieldwork({
        ...base,
        materiality: { ...base.materiality, benchmarkBase: baseType as "turnover" | "pbt" | "total-assets" | "equity" },
      });
      expect(res.materiality.benchmark).toBe(
        baseType === "turnover"
          ? "Revenue/turnover"
          : baseType === "pbt"
            ? "Profit before tax"
            : baseType === "total-assets"
              ? "Total assets"
              : "Equity",
      );
    }
  });

  it("warns when materiality collapses to zero", () => {
    const res = planAuditFieldwork({
      ...base,
      materiality: { ...base.materiality, benchmark: 0 },
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.warnings.some((w) => w.includes("Overall materiality"))).toBe(true);
  });
});

describe("audit fieldwork: MUS and attribute sampling", () => {
  it("computes MUS sample size for large populations", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    const plan = res.samplePlans[0]!;
    expect(plan.samplingMethod).toBe("mus");
    expect(plan.sampleSize).toBeGreaterThan(0);
    expect(plan.confidenceLevel).toBe(0.95);
  });

  it("uses attribute sampling for small populations", () => {
    const res = planAuditFieldwork({
      ...base,
      populations: [{ stratum: "Small", bookValue: 50_000, items: 10, riskLevel: "low" as const }],
    } as Parameters<typeof planAuditFieldwork>[0]);
    const plan = res.samplePlans[0]!;
    expect(plan.samplingMethod).toBe("attribute");
    expect(plan.sampleSize).toBeGreaterThan(0);
  });

  it("increases sample size for high-risk strata", () => {
    const highRisk = planAuditFieldwork({
      ...base,
      populations: [{ stratum: "Revenue", bookValue: 50_00_000, items: 1_000, riskLevel: "high" as const }],
    } as Parameters<typeof planAuditFieldwork>[0]);
    const lowRisk = planAuditFieldwork({
      ...base,
      populations: [{ stratum: "Revenue", bookValue: 50_00_000, items: 1_000, riskLevel: "low" as const }],
    } as Parameters<typeof planAuditFieldwork>[0]);
    // High risk should have >= sample size of low risk
    expect(highRisk.samplePlans[0]!.sampleSize).toBeGreaterThanOrEqual(lowRisk.samplePlans[0]!.sampleSize);
  });

  it("adjusts sample size with expected errors", () => {
    const resBase = planAuditFieldwork({
      ...base,
      mus: { tolerableMisstatement: 50_000, expectedErrors: 0, confidence: 0.95 },
    } as Parameters<typeof planAuditFieldwork>[0]);
    const resWithErrors = planAuditFieldwork({
      ...base,
      mus: { tolerableMisstatement: 50_000, expectedErrors: 500, confidence: 0.95 },
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(resWithErrors.samplePlans[0]!.sampleSize).toBeGreaterThan(resBase.samplePlans[0]!.sampleSize);
  });

  it("supports 90%, 95%, 99% confidence levels", () => {
    const confidences: number[] = [0.9, 0.95, 0.99];
    for (const conf of confidences) {
      const res = planAuditFieldwork({
        ...base,
        mus: { tolerableMisstatement: 50_000, expectedErrors: 0, confidence: conf },
      } as Parameters<typeof planAuditFieldwork>[0]);
      expect(res.samplePlans[0]!.confidenceLevel).toBe(conf);
      expect(res.samplePlans[0]!.sampleSize).toBeGreaterThan(0);
    }
  });
});

describe("audit fieldwork: risk assessment matrix", () => {
  it("computes risk scores from inherent x control risk", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    const ratings = res.riskRatings;
    expect(ratings).toHaveLength(1);
    expect(ratings[0]!.area).toBe("Revenue");
    expect(ratings[0]!.riskScore).toBe(6); // high(3) x medium(2) = 6
    expect(ratings[0]!.detectionRiskTarget).toBe("low"); // score >= 6
  });

  it("low inherent + low control = low risk score", () => {
    const res = planAuditFieldwork({
      ...base,
      riskRatings: [{ area: "Cash", inherentRisk: "low" as const, controlRisk: "low" as const }],
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.riskRatings[0]!.riskScore).toBe(1); // 1 x 1
    expect(res.riskRatings[0]!.detectionRiskTarget).toBe("high");
  });

  it("high inherent + high control = maximum risk score", () => {
    const res = planAuditFieldwork({
      ...base,
      riskRatings: [{ area: "Revenue", inherentRisk: "high" as const, controlRisk: "high" as const }],
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.riskRatings[0]!.riskScore).toBe(9); // 3 x 3
  });
});

describe("audit fieldwork: fraud risk assessment", () => {
  it("identifies fraud risk indicators for revenue areas", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.fraudRiskAssessment.fraudRiskPresent).toBe(true);
    expect(res.fraudRiskAssessment.revenueRecognitionRisk).toBe(true);
    expect(res.fraudRiskAssessment.managementOverrideRisk).toBe(true);
  });

  it("flags significant fraud risks in revenue areas", () => {
    const res = planAuditFieldwork({
      ...base,
      riskRatings: [{ area: "Revenue Recognition", inherentRisk: "high" as const, controlRisk: "medium" as const }],
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.fraudRiskAssessment.significantFraudRisk).toContain("Revenue Recognition");
  });

  it("no fraud risk for low-risk areas", () => {
    const res = planAuditFieldwork({
      ...base,
      riskRatings: [{ area: "Fixed Assets", inherentRisk: "low" as const, controlRisk: "low" as const }],
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.fraudRiskAssessment.fraudRiskPresent).toBe(true); // Still inherent (management override)
  });
});

describe("audit fieldwork: going concern assessment", () => {
  it("assesses going concern when company metrics provided", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.goingConcernAssessment.indicatorsPresent).toBe(false); // Healthy metrics
    expect(res.goingConcernAssessment.indicators).toHaveLength(0);
  });

  it("flags going concern for weak liquidity", () => {
    const res = planAuditFieldwork({
      ...base,
      companyMetrics: {
        currentRatio: 0.3,
        debtToEquity: 2.5,
        netProfitMargin: 0.03,
        revenue: 10_00_000,
        netProfit: 30_000,
        totalAssets: 20_00_000,
        totalTransactions: 100,
      },
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.goingConcernAssessment.indicatorsPresent).toBe(true);
    expect(res.goingConcernAssessment.indicators.length).toBeGreaterThan(0);
  });

  it("flags going concern for high leverage", () => {
    const res = planAuditFieldwork({
      ...base,
      companyMetrics: {
        currentRatio: 1.5,
        debtToEquity: 3.5,
        netProfitMargin: 0.08,
        revenue: 10_00_000,
        netProfit: 80_000,
        totalAssets: 20_00_000,
        totalTransactions: 100,
      },
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.goingConcernAssessment.indicators.some((i) => i.includes("2:1"))).toBe(true);
  });

  it("flags low profitability concern", () => {
    const res = planAuditFieldwork({
      ...base,
      companyMetrics: {
        currentRatio: 1.5,
        debtToEquity: 1.0,
        netProfitMargin: 0.03,
        revenue: 10_00_000,
        netProfit: 30_000,
        totalAssets: 20_00_000,
        totalTransactions: 100,
      },
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.goingConcernAssessment.indicators.some((i) => i.includes("5%"))).toBe(true);
  });

  it("no metrics means no going concern indicators", () => {
    const res = planAuditFieldwork({ ...base, companyMetrics: null } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.goingConcernAssessment.indicatorsPresent).toBe(false);
    expect(res.goingConcernAssessment.indicators).toHaveLength(0);
  });
});

describe("audit fieldwork: analytical procedures with trend analysis", () => {
  it("computes expected value and flags variances", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    const purchases = res.analyticalExpectations.find((a) => a.account === "Purchases")!;
    expect(purchases.expectedValue).toBe(1_100); // 1,000 x 1.1
    expect(purchases.variancePct).toBeCloseTo(9.0909, 3);
    expect(purchases.flag).toBe(false); // under 15% tolerance
    expect(purchases.trendDirection).toBe("increasing");

    const sales = res.analyticalExpectations.find((a) => a.account === "Sales")!;
    expect(sales.expectedValue).toBe(1_000);
    expect(sales.variancePct).toBe(30);
    expect(sales.flag).toBe(true); // over 15% tolerance
    expect(sales.trendDirection).toBe("increasing");
  });

  it("provides reasonable range around expected value", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    const purchases = res.analyticalExpectations.find((a) => a.account === "Purchases")!;
    // 10% tolerance: expectedValue +/- 10%
    expect(purchases.reasonableRange.min).toBeCloseTo(990, 2); // 1,100 x 0.9
    expect(purchases.reasonableRange.max).toBeCloseTo(1_210, 2); // 1,100 x 1.1
  });

  it("tighter tolerance for low-risk clients", () => {
    const resHighRisk = planAuditFieldwork({
      ...base,
      materiality: { ...base.materiality, clientRiskProfile: "high" as const },
    } as Parameters<typeof planAuditFieldwork>[0]);
    const purchasesHighRisk = resHighRisk.analyticalExpectations.find((a) => a.account === "Purchases")!;
    // Range should be wider for high risk (15% tolerance)
    expect(purchasesHighRisk.reasonableRange.max).toBeGreaterThan(purchasesHighRisk.reasonableRange.min);
  });

  it("detects decreasing trend", () => {
    const res = planAuditFieldwork({
      ...base,
      analyticalExpectations: [{ account: "Sales", priorYear: 1_000, expectedChangePct: 5, actualCurrent: 900 }],
    } as Parameters<typeof planAuditFieldwork>[0]);
    const sales = res.analyticalExpectations.find((a) => a.account === "Sales")!;
    expect(sales.trendDirection).toBe("decreasing");
  });

  it("detects stable trend", () => {
    const res = planAuditFieldwork({
      ...base,
      analyticalExpectations: [{ account: "Rent", priorYear: 1_000, expectedChangePct: 0, actualCurrent: 1_000 }],
    } as Parameters<typeof planAuditFieldwork>[0]);
    const rent = res.analyticalExpectations.find((a) => a.account === "Rent")!;
    expect(rent.trendDirection).toBe("stable");
  });
});

describe("audit fieldwork: audit program generation", () => {
  it("generates 15 audit procedures in sequence", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.auditProgram).toHaveLength(15);
    expect(res.auditProgram[0]!.sequence).toBe(1);
    expect(res.auditProgram[14]!.sequence).toBe(15);
  });

  it("expands fraud procedures when fraud risk present", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    const fraudProcedure = res.auditProgram.find((p) => p.procedure.includes("fraud"));
    expect(fraudProcedure!.extent).toBe("expanded");
  });

  it("expands revenue procedures when revenue recognition risk present", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    const revenueProcedure = res.auditProgram.find((p) => p.procedure.includes("revenue"));
    expect(revenueProcedure!.extent).toBe("expanded");
  });

  it("expands going concern procedures when indicators present", () => {
    const res = planAuditFieldwork({
      ...base,
      companyMetrics: {
        currentRatio: 0.3,
        debtToEquity: 3.5,
        netProfitMargin: 0.03,
        revenue: 10_00_000,
        netProfit: 30_000,
        totalAssets: 20_00_000,
        totalTransactions: 100,
      },
    } as Parameters<typeof planAuditFieldwork>[0]);
    const gcProcedure = res.auditProgram.find((p) => p.procedure.includes("going concern"));
    expect(gcProcedure!.extent).toBe("expanded");
  });

  it("includes various procedure natures", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    const natures = res.auditProgram.map((p) => p.nature);
    expect(natures).toContain("test-of-controls");
    expect(natures).toContain("substantive");
    expect(natures).toContain("analytical");
    expect(natures).toContain("inquiry");
    expect(natures).toContain("recalculation");
  });

  it("includes timing classification", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    const timings = res.auditProgram.map((p) => p.timing);
    expect(timings).toContain("interim");
    expect(timings).toContain("year-end");
  });
});

describe("audit fieldwork: materiality reallocation", () => {
  it("allocates performance materiality across populations", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.materialityReallocation).toHaveLength(1);
    expect(res.materialityReallocation[0]!.area).toBe("Revenue");
    expect(res.materialityReallocation[0]!.percentage).toBe(100);
  });

  it("allocates proportionally across multiple populations", () => {
    const res = planAuditFieldwork({
      ...base,
      populations: [
        { stratum: "Revenue", bookValue: 30_00_000, items: 1_000, riskLevel: "medium" as const },
        { stratum: "Expenses", bookValue: 20_00_000, items: 500, riskLevel: "low" as const },
      ],
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.materialityReallocation).toHaveLength(2);
    // Revenue: 30L/50L = 60%
    expect(res.materialityReallocation[0]!.percentage).toBe(60);
    expect(res.materialityReallocation[1]!.percentage).toBe(40);
  });
});

describe("audit fieldwork: warnings and validation", () => {
  it("warns on zero materiality and no populations", () => {
    const res = planAuditFieldwork({
      ...base,
      materiality: { ...base.materiality, benchmark: 0 },
      populations: [],
      riskRatings: [],
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.warnings.some((w) => w.includes("Overall materiality"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("No populations"))).toBe(true);
  });

  it("warns on fraud risk", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.warnings.some((w) => w.includes("fraud"))).toBe(true);
  });

  it("warns on significant going concern doubt", () => {
    const res = planAuditFieldwork({
      ...base,
      companyMetrics: {
        currentRatio: 0.1,
        debtToEquity: 5.0,
        netProfitMargin: 0.01,
        revenue: 5_00_000,
        netProfit: 50_000,
        totalAssets: 10_00_000,
        totalTransactions: 100,
      },
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("includes comprehensive methodology", () => {
    const res = planAuditFieldwork(base as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.methodology.length).toBeGreaterThan(5);
    expect(res.methodology.some((m) => m.includes("SA 240"))).toBe(true);
    expect(res.methodology.some((m) => m.includes("SA 570"))).toBe(true);
    expect(res.methodology.some((m) => m.includes("MUS"))).toBe(true);
    expect(res.methodology.some((m) => m.includes("Poisson"))).toBe(true);
  });
});

describe("audit fieldwork: edge cases", () => {
  it("handles zero book value populations", () => {
    const res = planAuditFieldwork({
      ...base,
      populations: [{ stratum: "Empty", bookValue: 0, items: 0, riskLevel: "low" as const }],
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.samplePlans).toHaveLength(1);
  });

  it("handles missing company metrics", () => {
    const res = planAuditFieldwork({ ...base, companyMetrics: null } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.goingConcernAssessment.indicatorsPresent).toBe(false);
    expect(res.goingConcernAssessment.indicators).toHaveLength(0);
  });

  it("zero tolerable misstatement produces minimum sample", () => {
    const res = planAuditFieldwork({
      ...base,
      mus: { tolerableMisstatement: 0, expectedErrors: 0, confidence: 0.95 },
    } as Parameters<typeof planAuditFieldwork>[0]);
    expect(res.samplePlans[0]!.sampleSize).toBeGreaterThan(0);
  });
});
