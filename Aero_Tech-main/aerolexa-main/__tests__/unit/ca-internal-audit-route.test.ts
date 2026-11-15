/**
 * Route-level integration for `POST /api/ca/compute` — the internal, concurrent
 * and stock audit kinds.
 *
 * These three engines were written behind `ca-internal-audit-api.ts`, which is
 * the rupee→paise boundary and the `op` dispatcher. The tests check that the
 * dispatcher routes each `op` to the right engine (it previously switched on
 * `input.op.op` while being handed the op itself, so every call fell through)
 * and that money crosses the boundary in the right unit.
 */

import { POST } from "@/app/api/ca/compute/route";

jest.mock("@/lib/auth/guard", () => {
  const actual = jest.requireActual("@/lib/auth/guard");
  return {
    ...actual,
    requireAuth: jest.fn(async () => ({
      user: { id: "u1" },
      workspace: { id: "w1" },
      settings: {},
      organization: null,
      organizationRole: null,
    })),
  };
});

function post(payload: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/ca/compute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

async function postOk<T = any>(payload: unknown): Promise<T> {
  const res = await post(payload);
  const json = await res.json();
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(json)}`);
  expect(json.ok).toBe(true);
  return json.data as T;
}

const cosoComponents = [
  {
    component: "control-environment",
    description: "Tone at the top",
    designRating: "adequate",
    operatingRating: "adequate",
    evidenceMethod: "inquiry",
  },
  {
    component: "risk-assessment",
    description: "Risk register maintained",
    designRating: "effective",
    operatingRating: "needs-improvement",
    evidenceMethod: "inspection",
  },
  {
    component: "control-activities",
    description: "Maker-checker on payments",
    designRating: "adequate",
    operatingRating: "adequate",
    evidenceMethod: "reperformance",
  },
  {
    component: "information-and-communication",
    description: "MIS circulated monthly",
    designRating: "effective",
    operatingRating: "effective",
    evidenceMethod: "inspection",
  },
  {
    component: "monitoring-activities",
    description: "Internal review quarterly",
    designRating: "needs-improvement",
    operatingRating: "needs-improvement",
    evidenceMethod: "observation",
  },
];

const internalPlan = {
  engagementName: "Internal audit FY 2025-26",
  entityName: "Sharma Textiles Pvt Ltd",
  fiscalYear: "2025-26",
  auditObjective: "Assess the design and operating effectiveness of the payment process.",
  scopeIn: ["procure-to-pay", "payroll"],
  materiality: 500000, // ₹5,00,000
  riskRating: "medium",
  cosoComponents,
  issues: [
    {
      id: "ISS-1",
      findingTitle: "Three-way match not evidenced",
      processArea: "procure-to-pay",
      cosoComponent: "control-activities",
      riskRating: "high",
      description: "Invoices are paid without evidence of the GRN match for 12 of 40 samples.",
      criteria: "Policy requires a three-way match before payment.",
      condition: "GRN reference missing on 12 vouchers.",
      cause: "Manual matching under time pressure.",
      effect: "Risk of payment for goods not received.",
      recommendation: "Block payment until the match is evidenced in the system.",
      status: "open",
      raisedBy: "R. Iyer",
      raisedAt: "2025-08-01",
      targetDate: "2025-09-30", // past → overdue
    },
  ],
};

describe("POST /api/ca/compute · internal-audit", () => {
  it("assesses COSO components and reports the overall rating in paise", async () => {
    const data = await postOk<{ internalAudit: any }>({
      kind: "internal-audit",
      op: { op: "assess", plan: internalPlan },
    });
    const r = data.internalAudit;
    // The worst of the five components decides the engagement rating.
    expect(r.overallRating).toBe("needs-improvement");
    expect(r.cosoSummary).toHaveLength(5);
    expect(r.openIssues.map((i: any) => i.id)).toEqual(["ISS-1"]);
    expect(r.overdueIssues.map((i: any) => i.id)).toEqual(["ISS-1"]);
    expect(r.highRiskFindings.map((i: any) => i.id)).toEqual(["ISS-1"]);
    expect(r.reportReady).toBe(false);
    expect(r.reportSections.length).toBeGreaterThan(0);
  });

  it("moves an issue through its lifecycle", async () => {
    const issue = {
      ...internalPlan.issues[0],
      managementResponse: "Agreed; system control to be configured.",
      managementResponseBy: "CFO",
      retestResult: null,
    };
    const closed = await postOk<{ internalAudit: any }>({
      kind: "internal-audit",
      op: { op: "track-issue", issue, action: "close" },
    });
    expect(closed.internalAudit.status).toBe("closed");

    const retested = await postOk<{ internalAudit: any }>({
      kind: "internal-audit",
      op: { op: "track-issue", issue, action: "retest" },
    });
    expect(retested.internalAudit.status).toBe("retested");
    expect(retested.internalAudit.retestResult).toBe("not-retested");

    // "progress" on an issue whose target date has passed is reported overdue.
    const progressed = await postOk<{ internalAudit: any }>({
      kind: "internal-audit",
      op: { op: "track-issue", issue, action: "progress" },
    });
    expect(progressed.internalAudit.status).toBe("overdue");
  });

  it("plans a risk-based audit and applies the hour budget", async () => {
    const data = await postOk<{ internalAudit: any }>({
      kind: "internal-audit",
      op: {
        op: "plan-risk-based",
        processAreas: [
          { name: "cash", inherentRisk: "high", transactionVolume: 1200 },
          { name: "payroll", inherentRisk: "medium", transactionVolume: 96 },
          { name: "fixed assets", inherentRisk: "low", transactionVolume: 12 },
        ],
        availableHours: 100,
        hoursPerHighRiskArea: 40,
        hoursPerMediumRiskArea: 24,
        hoursPerLowRiskArea: 8,
      },
    });
    expect(data.internalAudit.prioritized[0].name).toBe("cash");
    expect(data.internalAudit.totalRecommendedHours).toBe(72);
    expect(data.internalAudit.withinBudget).toBe(true);
  });

  it("rejects an audit plan with no COSO component", async () => {
    const res = await post({
      kind: "internal-audit",
      op: { op: "assess", plan: { ...internalPlan, cosoComponents: [] } },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a plan that reports the same COSO component twice as INTERNAL_AUDIT_INPUT", async () => {
    // The per-item schema cannot see duplicates across the array; the engine
    // refuses them so a component is never double-counted in the rating.
    const res = await post({
      kind: "internal-audit",
      op: { op: "assess", plan: { ...internalPlan, cosoComponents: [cosoComponents[0], cosoComponents[0]] } },
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INTERNAL_AUDIT_INPUT");
  });
});

const branch = {
  branchCode: "BR-014",
  branchName: "Pune Camp",
  centerHead: "Zonal Office West",
  branchManager: "S. Kulkarni",
  examinationPeriod: { from: "2025-04-01", to: "2025-06-30" },
  transactionsTested: 50,
  transactionsTestedAmount: 2500000, // ₹25,00,000
  kycSampleTested: 20,
  amlAlertReviewed: 12,
  interestCalculationTested: 8,
  prudentialLimitChecks: [
    {
      limitName: "Single borrower exposure",
      regulatoryLimit: 10000000,
      actualExposure: 12000000,
      description: "Exposure to a single borrower",
    },
    {
      limitName: "Unsecured advances",
      regulatoryLimit: 5000000,
      actualExposure: 4000000,
      description: "Unsecured book",
    },
  ],
  observations: [
    {
      ref: "OBS-1",
      area: "KYC",
      description: "Two accounts opened without a PAN copy",
      category: "compliance",
      severity: "critical",
      correctiveAction: "Obtain the PAN copies",
      managementResponse: null,
      status: "open",
      detectedBy: "R. Iyer",
      detectedOn: "2025-07-05",
    },
    {
      ref: "OBS-2",
      area: "Interest",
      description: "Interest posted a day late on one account",
      category: "operational",
      severity: "minor",
      correctiveAction: "Back-post and review the batch job",
      managementResponse: "Done",
      status: "closed",
      detectedBy: "R. Iyer",
      detectedOn: "2025-07-06",
    },
  ],
  concurrentAuditor: "R. Iyer",
  auditReportDate: "2025-07-10",
};

describe("POST /api/ca/compute · concurrent-audit", () => {
  it("scores observations, blocks sign-off on an open critical and flags a breach in paise", async () => {
    const data = await postOk<{ concurrentAudit: any }>({
      kind: "concurrent-audit",
      op: { op: "assess", branch },
    });
    const r = data.concurrentAudit;
    expect(r.totalObservations).toBe(2);
    expect(r.bySeverity).toEqual({ minor: 1, major: 0, critical: 1 });
    expect(r.byCategory).toEqual({ compliance: 1, operational: 1 });
    expect(r.openCritical.map((o: any) => o.ref)).toEqual(["OBS-1"]);
    expect(r.quarterlyReportReady).toBe(false); // an open critical blocks sign-off
    expect(r.prudentialBreaches).toHaveLength(1);
    expect(r.prudentialBreaches[0].limitName).toBe("Single borrower exposure");
    // ₹1,20,00,000 exposure against a ₹1,00,00,000 limit → ₹20,00,000 over, in paise.
    expect(r.prudentialBreaches[0].headroom).toBe(-200000000);
  });

  it("reconciles prudential limits in paise from rupee input", async () => {
    const data = await postOk<{ concurrentAudit: any }>({
      kind: "concurrent-audit",
      op: {
        op: "check-limits",
        checks: [
          {
            limitName: "Single borrower exposure",
            regulatoryLimit: 10000000,
            actualExposure: 12000000,
            description: "x",
          },
          { limitName: "Unsecured advances", regulatoryLimit: 5000000, actualExposure: 4000000, description: "y" },
        ],
      },
    });
    const checks = data.concurrentAudit;
    expect(checks).toHaveLength(2);
    expect(checks[0].breached).toBe(true);
    expect(checks[0].headroom).toBe(-200000000); // −₹20,00,000 in paise
    expect(checks[1].breached).toBe(false);
    expect(checks[1].headroom).toBe(100000000); // ₹10,00,000 headroom
  });
});

const stockPlan = {
  entityName: "Sharma Textiles Pvt Ltd",
  location: "Bhiwandi warehouse",
  stockDate: "2026-03-31",
  countingTeamLead: "R. Iyer",
  countingTeamMembers: ["A. Rao", "N. Bose"],
  bookStockValue: 150000, // ₹1,50,000
  bookStockQuantity: 150,
  scope: "full-physical",
  materiality: 10000, // ₹10,000
  highValueItemThreshold: 50000, // ₹50,000
  areas: [
    {
      areaCode: "A1",
      areaName: "Yarn store",
      expectedQuantity: 100,
      bookValue: 100000,
      countedQuantity: 95,
      countedValue: 95000,
      countedBy: "A. Rao",
      countedAt: "2026-03-31",
      verifiedBy: "R. Iyer",
      verifiedAt: "2026-03-31",
    },
    {
      areaCode: "A2",
      areaName: "Finished goods",
      expectedQuantity: 50,
      bookValue: 50000,
      countedQuantity: 50,
      countedValue: 50000,
      countedBy: "N. Bose",
      countedAt: "2026-03-31",
      verifiedBy: "R. Iyer",
      verifiedAt: "2026-03-31",
    },
  ],
};

describe("POST /api/ca/compute · stock-audit", () => {
  it("reconciles counted stock to book stock and decides materiality in paise", async () => {
    const data = await postOk<{ stockAudit: any }>({ kind: "stock-audit", op: { op: "assess", plan: stockPlan } });
    const r = data.stockAudit;
    expect(r.totalBookQuantity).toBe(150);
    expect(r.totalBookValueMinor).toBe(15000000); // ₹1,50,000 in paise
    expect(r.totalCountedQuantity).toBe(145);
    expect(r.totalCountedValueMinor).toBe(14500000);
    expect(r.totalVarianceQuantity).toBe(-5);
    expect(r.totalVarianceValueMinor).toBe(-500000); // −₹5,000
    expect(r.variancePct).toBe(-3.33);
    expect(r.materialVariance).toBe(false); // ₹5,000 is inside the ₹10,000 materiality
    expect(r.areasWithVariance.map((a: any) => a.areaCode)).toEqual(["A1"]);
    expect(r.reportReady).toBe(true);
  });

  it("treats a variance above materiality as material", async () => {
    const plan = {
      ...stockPlan,
      areas: [
        { ...stockPlan.areas[0], countedValue: 80000 }, // −₹20,000 against book value
        stockPlan.areas[1],
      ],
    };
    const data = await postOk<{ stockAudit: any }>({ kind: "stock-audit", op: { op: "assess", plan } });
    expect(data.stockAudit.totalVarianceValueMinor).toBe(-2000000);
    expect(data.stockAudit.materialVariance).toBe(true);
  });

  it("reconciles a bare area list", async () => {
    const data = await postOk<{ stockAudit: any }>({
      kind: "stock-audit",
      op: { op: "reconcile-areas", areas: stockPlan.areas },
    });
    expect(data.stockAudit.totalVarianceQuantity).toBe(-5);
    expect(data.stockAudit.areasWithVariance).toHaveLength(1);
    expect(data.stockAudit.areasWithVariance[0].varianceValueMinor).toBe(-500000);
  });

  it("rejects a plan whose areas are empty", async () => {
    const res = await post({ kind: "stock-audit", op: { op: "assess", plan: { ...stockPlan, areas: [] } } });
    expect(res.status).toBe(400);
  });

  it("rejects an area with a negative book value as INTERNAL_AUDIT_INPUT", async () => {
    // The `stockArea.bookValue` schema is a bare safe number, so a negative
    // value reaches the engine; it must be a caller error, not a 500.
    const res = await post({
      kind: "stock-audit",
      op: {
        op: "assess",
        plan: { ...stockPlan, areas: [{ ...stockPlan.areas[0], bookValue: -1000 }, stockPlan.areas[1]] },
      },
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INTERNAL_AUDIT_INPUT");
  });
});
