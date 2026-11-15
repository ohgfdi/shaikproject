/**
 * Route-level integration for `POST /api/ca/compute` with the DIRECT-TAX kinds.
 *
 * These engines (income-head-salary, income-head-house-property,
 * income-head-capital-gains, ca-itr-computation, advance-tax, ca-advance-tax)
 * were complete and unit-tested but reachable from NO live API before this
 * change. Every assertion here is hand-computed from the statute/engine math and
 * checks the ROUTE's contract — the rupee→paise conversion where the engine is in
 * integer paise, and the rupee pass-through where the engine is in whole rupees —
 * not just that a 200 came back.
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

describe("POST /api/ca/compute · income-head-salary", () => {
  it("computes taxable salary in integer paise from rupee inputs", async () => {
    const res = await post({
      kind: "income-head-salary",
      ay: "2025-26",
      regimeId: "new",
      // ₹6,00,000 basic + ₹2,40,000 HRA (HRA is part of gross 17(1) here).
      components: [
        { label: "Basic", amount: 600_000, countsForSalary: true },
        { label: "HRA", amount: 240_000, countsForSalary: true },
      ],
      allowances: { hraExempt: 120_000, professionalTax: 2_400 },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const s = json.data.salaryHead;
    // Gross 17(1) ₹8,40,000 → less exempt ₹1,20,000 → ₹7,20,000.
    // Less standard deduction (new regime) ₹75,000 and professional tax ₹2,400 → ₹6,42,600.
    expect(s.grossSalary17_1).toBe(84_000_000);
    expect(s.grossTotalSalary).toBe(84_000_000);
    expect(s.exemptUnder10).toBe(12_000_000);
    expect(s.standardDeduction).toBe(7_500_000);
    expect(s.professionalTax).toBe(240_000);
    expect(s.taxableSalary).toBe(64_260_000);
  });

  it("rejects a salary head with no components", async () => {
    const res = await post({ kind: "income-head-salary", ay: "2025-26", components: [] });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});

describe("POST /api/ca/compute · house-property", () => {
  it("computes NAV, 30% standard deduction and 24(b) interest in paise", async () => {
    const res = await post({
      kind: "house-property",
      ay: "2025-26",
      regimeLabel: "individual",
      properties: [
        {
          id: "HP-1",
          status: "let-out",
          municipalValue: 300_000,
          fairRent: 320_000,
          rentReceived: 360_000,
          municipalTaxPaid: 20_000,
          interestOnHousingLoan: 200_000,
        },
      ],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const hp = json.data.houseProperty;
    // Expected rent = max(MV ₹3L, FR ₹3.2L) = ₹3.2L; gross value = max(₹3.2L, rent ₹3.6L) = ₹3.6L.
    // NAV = ₹3.6L − municipal tax ₹20k = ₹3.4L; 30% std deduction = ₹1.02L; net = ₹2.38L.
    // Let-out interest fully admissible: ₹2.38L − ₹2L = ₹38k income.
    expect(hp.totalNav).toBe(34_000_000);
    expect(hp.totalStd30).toBe(10_200_000);
    expect(hp.totalInterestDeductible).toBe(20_000_000);
    expect(hp.totalIncomeFromHouseProperty).toBe(3_800_000);
  });
});

describe("POST /api/ca/compute · capital-gains", () => {
  it("classifies a listed-equity LTCG and taxes it at the 112A default", async () => {
    const res = await post({
      kind: "capital-gains",
      ay: "2025-26",
      regimeLabel: "individual",
      transactions: [
        {
          id: "CG-1",
          assetClass: "listed-equity-shares",
          acquisitionDate: "2021-05-01",
          transferDate: "2025-08-01",
          saleProceeds: 500_000,
          costOfAcquisition: 200_000,
          holding: { acquisitionDate: "2021-05-01", transferDate: "2025-08-01", daysHeld: 1_553, longTerm: true },
          sttPaid: true,
        },
      ],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const cg = json.data.capitalGains;
    // LTCG = ₹5L − ₹2L = ₹3L. 112A default: ₹1.25L exempt, ₹1.75L @ 12.5% = ₹21,875.
    expect(cg.totalLongTermCapitalGain).toBe(30_000_000);
    expect(cg.transactions[0].specialRate.section).toBe("112A");
    expect(cg.transactions[0].taxAtSpecialRate).toBe(2_187_500);
  });

  it("rejects a transaction whose holding block is missing", async () => {
    const res = await post({
      kind: "capital-gains",
      ay: "2025-26",
      transactions: [{ id: "CG-1", assetClass: "other", saleProceeds: 1, costOfAcquisition: 1 }],
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/ca/compute · itr", () => {
  it("computes the ITR in whole rupees (no paise conversion)", async () => {
    const res = await post({
      kind: "itr",
      fy: "2025-26",
      assesseeType: "individual",
      incomeHeads: { salary: 1_000_000 },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const c = json.data.itr.computation;
    // FY 2025-26 new regime: 4–8L @5% = ₹20k; 8–10L @10% = ₹20k → ₹40k slab.
    // The ₹60,000 / ₹12L rebate wipes it out (income ≤ ₹12L) → nil tax.
    expect(c.grossTotalIncome).toBe(1_000_000);
    expect(c.taxBeforeRebate).toBe(40_000);
    expect(c.rebate87A).toBe(40_000);
    expect(c.totalTaxLiability).toBe(0);
  });

  it("maps the assessee alias huf onto the engine's in-engine literal", async () => {
    const res = await post({ kind: "itr", fy: "2025-26", assesseeType: "huf", incomeHeads: { salary: 600_000 } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.itr.computation.assesseeType).toBe("hir india");
  });
});

describe("POST /api/ca/compute · advance-tax (projection)", () => {
  it("projects tax and instalments in whole rupees, and the 100% instalment equals total tax", async () => {
    const res = await post({
      kind: "advance-tax",
      fy: "2025-26",
      assesseeType: "individual",
      regime: "new",
      incomeHeads: { salary: 1_500_000 },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const at = json.data.advanceTax;
    // ₹15L − ₹75k standard deduction = ₹14.25L taxable.
    // 20k + 40k + (2.25L @15% = 33,750) = ₹93,750; 4% cess ₹3,750 → ₹97,500.
    expect(at.totalTaxLiability).toBe(97_500);
    expect(at.instalments).toHaveLength(4);
    expect(at.instalments[0]).toMatchObject({ percentage: 15, amountDue: 14_625 });
    expect(at.instalments[3].amountDue).toBe(97_500);
    // Old regime on the same income is dearer, so the comparison recommends the new regime.
    expect(at.regimeComparison.recommendedRegime).toBe("new");
  });
});

describe("POST /api/ca/compute · advance-tax-advisory", () => {
  it("accrues 234C on the missed June instalment and 234B from 1 April in paise", async () => {
    const res = await post({
      kind: "advance-tax-advisory",
      fy: "2025-26",
      clientName: "Acme",
      regimeId: "new",
      totalTax: 100_000,
      advanceTaxPaid: 0,
      referenceDate: "2025-06-30",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const a = json.data.advanceTaxAdvisory;
    // Q1 target 15% of ₹1,00,000 = ₹15,000 missed → 234C = 1% × 3 months = ₹450.
    expect(a.interest234C).toBe(45_000);
    // 90% = ₹90,000 unpaid; 1 April → 30 June = 3 months → 234B = 1% × 3 × ₹90,000 = ₹2,700.
    expect(a.interest234B).toBe(270_000);
    expect(a.payNow).toBe(9_000_000);
  });
});

describe("POST /api/ca/compute · dispatch guard", () => {
  it("rejects an unknown kind with a 400, not a 500", async () => {
    const res = await post({ kind: "not-a-real-kind" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});
