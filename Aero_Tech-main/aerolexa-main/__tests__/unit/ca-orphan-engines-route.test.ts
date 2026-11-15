/**
 * Route-level integration for the CA engines that had **no live surface**.
 *
 * `tds-threshold-engine`, `ca-tds-computation`, `ca-tax-audit`,
 * `tds-ldc-form15g`, `tds-form16-generator` and `itr-schedules` were complete and
 * unit-tested but reachable from no route and no UI — each was importable only by
 * its own test. These assertions are hand-computed and pin the ROUTE contract:
 *
 *   - every money field crosses the boundary in RUPEES and is converted to the
 *     engine's own unit (true paise for the paise engines, rupees for
 *     ca-tds-computation / ca-tax-audit, which are rupee-native);
 *   - the two engines that carried a unit defect are pinned at their corrected
 *     values, so the 10× class of bug cannot come back unnoticed.
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

describe("POST /api/ca/compute · tds-threshold", () => {
  const payments = [
    {
      id: "P1",
      section: "194C",
      deducteePan: "AAAAA0000A",
      amount: 80_000, // ₹80,000
      dateOfPayment: "2025-05-15",
      dateOfCredit: "2025-05-10",
    },
    {
      id: "P2",
      section: "194C",
      deducteePan: "AAAAA0000A",
      amount: 30_000, // ₹30,000 — pushes the FY aggregate past ₹1,00,000
      dateOfPayment: "2025-06-15",
      dateOfCredit: "2025-06-10",
    },
  ];

  it("tracks the 194C FY aggregate in true paise and triggers on the crossing payment", async () => {
    const res = await post({ kind: "tds-threshold", events: payments });
    expect(res.status).toBe(200);
    const json = await res.json();

    const outcomes = json.data.outcomes;
    expect(outcomes).toHaveLength(2);

    // First ₹80,000: below the ₹1,00,000 aggregate → no deduction.
    expect(outcomes[0].tdsApplicable).toBe(false);
    expect(outcomes[0].cumulativeAfter).toBe(8_000_000); // ₹80,000 in paise
    // The threshold the engine used is ₹1,00,000 in TRUE paise — the defect this
    // route could not be exposed behind was a factor of ten here (10,000,000 vs
    // the old 1,000,000).
    expect(outcomes[0].threshold).toBe(10_000_000);

    // Second ₹30,000: 80,000 + 30,000 = ₹1,10,000 > ₹1,00,000 → deduction.
    expect(outcomes[1].tdsApplicable).toBe(true);
    expect(outcomes[1].cumulativeAfter).toBe(11_000_000);

    // "Earlier of payment and credit" — credit on 2025-05-10 drives P1.
    expect(outcomes[0].effectiveDeductibleDate).toBe("2025-05-10");
    expect(outcomes[0].deductibleDateSource).toBe("credit");

    expect(json.data.summary.eventsWithTds).toBe(1);
    expect(json.data.summary.totalTdsComputed).toBe(60_000); // ₹600 at 2% of ₹30,000
    expect(json.data.rules[0].section).toBe("194C");
    expect(json.data.rules[0].rule.earlierOfPaymentOrCredit).toBe(true);
  });

  it("seeds the FY aggregate from a caller-supplied carry-over", async () => {
    const res = await post({
      kind: "tds-threshold",
      events: [payments[0]],
      carryOver: [{ section: "194C", deducteePan: "AAAAA0000A", cumulative: 95_000, threshold: 1_00_000 }],
    });
    const json = await res.json();

    // ₹95,000 brought forward + ₹80,000 = ₹1,75,000 > ₹1,00,000 → deduction on P1.
    expect(json.data.outcomes[0].tdsApplicable).toBe(true);
    expect(json.data.outcomes[0].carryOverBefore).toBe(9_500_000);
    expect(json.data.outcomes[0].cumulativeAfter).toBe(17_500_000);
  });

  it("rejects an empty event list", async () => {
    const res = await post({ kind: "tds-threshold", events: [] });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/ca/compute · tds-computation", () => {
  it("computes per-section tax, the statement form and 201 interest (rupee-native engine)", async () => {
    const res = await post({
      kind: "tds-computation",
      payerPan: "AAAAA1111A",
      assessmentYear: "2026-27",
      transactions: [
        {
          section: "194C",
          payeeName: "Vendor A",
          payeePan: "AAAAA0000A",
          amount: 100_000, // ₹1,00,000
          rate: 2,
          threshold: 100_000,
          dateOfPayment: "2025-05-31",
          dateOfDeduction: "2025-05-10", // 21 days late → ceil(21/30) = 1 month
          deposited: true,
          challan: "C-1",
        },
      ],
    });
    expect(res.status).toBe(200);
    const json = await res.json();

    const section = json.data.tds.sections[0];
    // This engine is rupee-native: 2% of ₹1,00,000 = ₹2,000, NOT paise.
    expect(section.totalTax).toBe(2_000);
    expect(section.aggregateCumulative).toBe(100_000);
    expect(section.transactions[0].crossedThreshold).toBe(false); // 1,00,000 > 1,00,000 is false
    expect(section.transactions[0].lateDeduction).toBe(true);
    expect(section.transactions[0].interest201).toBe(20); // ₹2,000 × 1% × 1 month
    expect(json.data.tds.statementSummary.formType).toBe("24Q"); // 194-family section
  });
});

describe("POST /api/ca/compute · tax-audit", () => {
  it("compares aggregate turnover against the ₹100 crore S.44AB limitation", async () => {
    const at = await post({ kind: "tax-audit", fy: "2025-26", turnover: 100_00_00_000, entityType: "company" });
    expect(at.status).toBe(200);
    const atJson = await at.json();
    expect(atJson.data.taxAudit.turnoverAnalysis.turnoverForAuditLimitation).toBe(1_000_000_000);
    expect(atJson.data.taxAudit.triggers.find((t: { name: string }) => t.name.includes("S.44AB"))?.applies).toBe(true);

    const below = await post({ kind: "tax-audit", fy: "2025-26", turnover: 99_99_99_999, entityType: "company" });
    const belowJson = await below.json();
    expect(belowJson.data.taxAudit.triggers.find((t: { name: string }) => t.name.includes("S.44AB"))?.applies).toBe(
      false,
    );
  });
});

describe("POST /api/ca/compute · tds-ldc", () => {
  it("flags a Form 15G declared by a senior citizen", async () => {
    const res = await post({
      kind: "tds-ldc",
      op: "validate-form15",
      declaration: {
        formType: "15G",
        deducteePan: "AAAAA0000A",
        age: 65, // senior — must use 15H
        declarationDate: "2025-04-10",
        sections: ["194A"],
        validFrom: "2025-04-10",
        validUntil: "2026-03-31",
      },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.form15Validation.valid).toBe(false);
    expect(json.data.form15Validation.issues.some((i: string) => i.includes("15H"))).toBe(true);
  });

  it("passes a well-formed Form 15G with the amount limit carried in paise", async () => {
    const res = await post({
      kind: "tds-ldc",
      op: "validate-form15",
      declaration: {
        formType: "15G",
        deducteePan: "AAAAA0000A",
        age: 40,
        declarationDate: "2025-04-10",
        sections: ["194A"],
        amountLimit: 1_00_000, // ₹1,00,000 → 10,000,000 paise
        validFrom: "2025-04-10",
        validUntil: "2026-03-31",
      },
    });
    const json = await res.json();
    expect(json.data.form15Validation.valid).toBe(true);
    expect(json.data.form15Validation.issues).toHaveLength(0);
  });

  it("reports whether an LDC covers a payment (amount in paise)", async () => {
    const res = await post({
      kind: "tds-ldc",
      op: "cover",
      event: { deducteePan: "AAAAA0000A", section: "194J", amount: 50_000, dateOfPaymentOrCredit: "2025-06-01" },
      ldcCertificates: [
        {
          certificateNumber: "LDC/2025/001",
          deducteePan: "AAAAA0000A",
          sections: ["194J"],
          lowerRate: 2,
          lowerAmountLimit: 1_00_000,
          validFrom: "2020-01-01",
          validUntil: "2030-12-31",
        },
      ],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.cover.covered).toBe(true);
    expect(json.data.cover.byLdc.certificateNumber).toBe("LDC/2025/001");
    expect(json.data.cover.byLdc.lowerAmountLimit).toBe(10_000_000); // ₹1,00,000
  });

  it("clears the cover when the payment exceeds the LDC limit", async () => {
    const res = await post({
      kind: "tds-ldc",
      op: "cover",
      event: { deducteePan: "AAAAA0000A", section: "194J", amount: 1_50_000, dateOfPaymentOrCredit: "2025-06-01" },
      ldcCertificates: [
        {
          certificateNumber: "LDC/2025/001",
          deducteePan: "AAAAA0000A",
          sections: ["194J"],
          lowerRate: 2,
          lowerAmountLimit: 1_00_000,
          validFrom: "2020-01-01",
          validUntil: "2030-12-31",
        },
      ],
    });
    const json = await res.json();
    expect(json.data.cover.covered).toBe(false);
    expect(json.data.cover.reason).toContain("exceeded");
  });
});

describe("POST /api/ca/compute · tds-form16", () => {
  it("builds Form 16 Part A + Part B with true-paise tax", async () => {
    const res = await post({
      kind: "tds-form16",
      op: "16",
      deductorTan: "MUMA12345A",
      deductorName: "Acme Pvt Ltd",
      deducteePan: "AAAAA0000A",
      deducteeName: "Ramesh Kumar",
      fy: "2025-26",
      assessmentYear: "2026-27",
      salaryEntries: [
        {
          id: "e1",
          quarter: "Q1",
          dateOfPayment: "2025-05-31",
          grossAmount: 5_00_000,
          tdsAmount: 50_000,
          status: "deposited",
        },
        {
          id: "e2",
          quarter: "Q2",
          dateOfPayment: "2025-08-31",
          grossAmount: 6_50_000,
          tdsAmount: 65_000,
          status: "deposited",
        },
      ],
      salary: { totalSalary: 11_50_000 },
      chapterVIA: { totalChapterVIA: 2_25_000 },
      tdsDeducted: 1_15_000,
    });
    expect(res.status).toBe(200);
    const json = await res.json();

    // Part A aggregates the entries in paise.
    expect(json.data.partA.totalSalaryPaid).toBe(115_000_000); // ₹11,50,000
    expect(json.data.partA.totalTdsDeducted).toBe(11_500_000); // ₹1,15,000

    // Part B: (₹11,50,000 − ₹50,000 standard deduction) − ₹2,25,000 Chapter VI-A = ₹8,75,000.
    const tax = json.data.partB.taxComputation;
    expect(tax.totalIncome).toBe(87_500_000);
    // Old regime, below 60: ₹2,50,000 × 5% + ₹3,75,000 × 20% = ₹87,500 = 8,750,000 paise.
    expect(tax.taxOnTotalIncome).toBe(8_750_000);
    expect(tax.rebate87A).toBe(0); // above the ₹5,00,000 ceiling
    expect(tax.cess).toBe(350_000); // 4% of ₹87,500
    expect(tax.totalTaxLiability).toBe(9_100_000);

    expect(json.data.certificate.certificateType).toBe("16");
    expect(json.data.validation.valid).toBe(true);
  });

  it("builds a Form 16A certificate grouped by section", async () => {
    const res = await post({
      kind: "tds-form16",
      op: "16A",
      deductorTan: "MUMA12345A",
      deductorName: "Acme Pvt Ltd",
      deducteePan: "AAAAA0000A",
      deducteeName: "Vendor A",
      fy: "2025-26",
      nonSalaryEntries: [
        { id: "n1", section: "194C", natureOfPayment: "Contract", grossAmount: 5_00_000, tdsAmount: 10_000 },
        { id: "n2", section: "194J", natureOfPayment: "Professional", grossAmount: 2_00_000, tdsAmount: 20_000 },
      ],
    });
    const json = await res.json();
    expect(json.data.form16A.sections).toHaveLength(2);
    expect(json.data.form16A.totalAmount).toBe(70_000_000); // ₹5,00,000 + ₹2,00,000
    expect(json.data.form16A.totalTdsDeducted).toBe(3_000_000); // ₹10,000 + ₹20,000
    expect(json.data.certificate.certificateType).toBe("16A");
  });

  it("requires the salary annexure for op=16", async () => {
    const res = await post({ kind: "tds-form16", op: "16", deductorTan: "MUMA12345A" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/ca/compute · itr-schedules", () => {
  it("assembles an ITR-5 payload, converting rupees to paise", async () => {
    const res = await post({
      kind: "itr-schedules",
      formType: "ITR-5",
      assessmentYear: "2026-27",
      general: { pan: "AAAPA1234A", name: "Partners LLP" },
      schedules: {
        BP: { header: "Business/Profession", lines: [{ label: "Net profit", amount: 2_00_000 }] },
        PMT: { header: "Profit sharing", lines: [{ label: "Partner share", amount: 1_50_000 }] },
      },
      income: { "Gross Total Income": 2_00_000 },
      tax: { "Total Tax Liability": 31_200 },
    });
    expect(res.status).toBe(200);
    const json = await res.json();

    const payload = json.data.itrSchedules;
    expect(payload.json.form_type).toBe("ITR-5");
    // Rupees in → paise in the assembled document.
    expect(payload.json.income["Gross Total Income"]).toBe(20_000_000);
    expect(payload.json.tax["Total Tax Liability"]).toBe(3_120_000);
    expect(payload.json.schedules.BP.lines[0].amount).toBe(20_000_000);
    expect(payload.xml).toContain('<Schedule code="BP">');
    expect(payload.validation.valid).toBe(true);
  });

  it("reports the required schedules an ITR-5 payload is missing", async () => {
    const res = await post({
      kind: "itr-schedules",
      formType: "ITR-5",
      assessmentYear: "2026-27",
      schedules: {},
      income: {},
      tax: {},
    });
    const json = await res.json();
    expect(json.data.itrSchedules.validation.valid).toBe(false);
    expect(json.data.itrSchedules.validation.errors.some((e: string) => e.includes("Schedule BP"))).toBe(true);
  });
});
