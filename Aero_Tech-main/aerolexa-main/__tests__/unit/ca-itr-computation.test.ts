/**
 * ITR computation engine — oracle tests.
 *
 * Every figure is hand-computed from the FY 2025-26 table: 4/8/12/16/20/24 lakh
 * slabs, ₹60,000 s.87A rebate up to ₹12L (with marginal relief), 10%/15%/25%
 * surcharge, 4% cess. FY 2024-25 is pinned separately so a prior-year
 * computation cannot silently pick up the new rates.
 */

import { computeItr } from "@/lib/engine/ca-itr-computation";

const base = {
  fy: "2025-26",
  assesseeType: "individual" as const,
  residentialStatus: "resident" as const,
  incomeHeads: {
    salary: 0,
    houseProperty: 0,
    businessProfession: 0,
    capitalGains: 0,
    otherSources: 0,
    agricultural: 0,
  },
  deductions: {
    section80C: 0,
    section80D: 0,
    section80E: 0,
    section80G: 0,
    section80GG: 0,
    section80TTA: 0,
    section80TTB: 0,
    nopNorm: 0,
    otherDeductions: 0,
  },
  hra: { received: 0, paidRent: 0, city: false, metro: false, actualRent: 0 },
  losses: { bhplBroughtFwd: 0, bhplSetOff: 0, cglBroughtFwd: 0, cglSetOff: 0 },
  scheduleAi: { interestPaid: 0, interestReceived: 0 },
  prepaidTax: { tds: 0, tcs: 0, advanceTax: 0, selfAssessment: 0, demands: 0 },
  formType: "ITR-1" as const,
  surcharges: { hvilag: false, healthcare: false },
};

describe("computeItr: FY 2025-26 slab tax", () => {
  it("taxes a ₹20L salary at 20% in the top bracket reached", () => {
    // ₹4L nil; 4–8L @5% = 20,000; 8–12L @10% = 40,000; 12–16L @15% = 60,000;
    // 16–20L @20% = 80,000 → ₹2,00,000. No rebate above ₹12L. Cess 4% = 8,000.
    const { computation } = computeItr({ ...base, incomeHeads: { ...base.incomeHeads, salary: 20_00_000 } });
    expect(computation.grossTotalIncome).toBe(20_00_000);
    expect(computation.basicIncome).toBe(20_00_000);
    expect(computation.taxBeforeRebate).toBe(2_00_000);
    expect(computation.rebate87A).toBe(0);
    expect(computation.cess).toBe(8_000);
    expect(computation.totalTaxLiability).toBe(2_08_000);
  });

  it("uses the FY 2024-25 table for an FY 2024-25 computation", () => {
    // 3L nil; 3–7L @5% = 20,000; 7–10L @10% = 30,000 → 50,000 (no 87A at 10L
    // in FY 2024-25, where the rebate stops at ₹7L). Cess 2,000.
    const { computation } = computeItr({
      ...base,
      fy: "2024-25",
      incomeHeads: { ...base.incomeHeads, salary: 10_00_000 },
    });
    expect(computation.taxBeforeRebate).toBe(50_000);
    expect(computation.rebate87A).toBe(0);
    expect(computation.totalTaxLiability).toBe(52_000);
  });
});

describe("computeItr: s.87A rebate (FY 2025-26)", () => {
  it("rebates the tax away at exactly ₹12L", () => {
    // 4–8L @5% = 20,000 + 8–12L @10% = 40,000 = 60,000; rebate 60,000.
    const { computation } = computeItr({ ...base, incomeHeads: { ...base.incomeHeads, salary: 12_00_000 } });
    expect(computation.taxBeforeRebate).toBe(60_000);
    expect(computation.rebate87A).toBe(60_000);
    expect(computation.taxAfterRebate).toBe(0);
    expect(computation.totalTaxLiability).toBe(0);
  });

  it("grants marginal relief one rupee above ₹12L instead of a cliff", () => {
    // Tax 60,000.15; tax may not exceed income above ₹12L (₹1) → relief.
    const { computation } = computeItr({ ...base, incomeHeads: { ...base.incomeHeads, salary: 12_00_001 } });
    expect(computation.rebate87A).toBe(0);
    expect(computation.rebateMarginalRelief).toBeCloseTo(59_999.15, 2);
    expect(computation.taxAfterRebate).toBe(1);
    expect(computation.totalTaxLiability).toBeCloseTo(1.04, 2);
  });

  it("rebates the full tax at ₹5L", () => {
    const { computation } = computeItr({ ...base, incomeHeads: { ...base.incomeHeads, salary: 5_00_000 } });
    expect(computation.taxBeforeRebate).toBe(5_000);
    expect(computation.rebate87A).toBe(5_000);
    expect(computation.totalTaxLiability).toBe(0);
  });
});

describe("computeItr: loss set-off, deductions and agricultural income", () => {
  it("limits business-loss set-off to business income and caps 80C", () => {
    const { computation } = computeItr({
      ...base,
      regime: "old",
      incomeHeads: { ...base.incomeHeads, salary: 10_00_000, businessProfession: 1_00_000 },
      losses: { ...base.losses, bhplBroughtFwd: 2_00_000, bhplSetOff: 1_00_000 },
      deductions: { ...base.deductions, section80C: 1_50_000 },
    });
    expect(computation.grossTotalIncome).toBe(11_00_000);
    expect(computation.totalIncomeAfterDeductions).toBe(10_00_000);
    expect(computation.chapterVIADeductions).toBe(1_50_000);
    expect(computation.basicIncome).toBe(8_50_000);
    // Old slabs: 2.5–5L @5% = 12,500; 5–8.5L @20% = 70,000 → ₹82,500.
    expect(computation.taxBeforeRebate).toBe(82_500);
    expect(computation.totalTaxLiability).toBe(85_800); // + 4% cess
  });

  it("partially integrates agricultural income instead of adding it to income", () => {
    const { computation } = computeItr({
      ...base,
      incomeHeads: { ...base.incomeHeads, salary: 14_00_000, businessProfession: 2_00_000, agricultural: 1_00_000 },
    });
    // GTI excludes agricultural income: 16L.
    expect(computation.grossTotalIncome).toBe(16_00_000);
    expect(computation.basicIncome).toBe(16_00_000);
    // Slab(17L) = 20,000+40,000+60,000+20,000 = 1,40,000; less slab(5L) = 5,000
    // → 1,35,000; the same as slab(16L) 1,20,000 pushed up by 15,000.
    expect(computation.taxBeforeRebate).toBe(1_35_000);
    expect(computation.agriculturalIncomeSetOff).toBe(1_00_000);
  });

  it("carves special-rate LTCG out of the slab and taxes it at 12.5%", () => {
    const { computation } = computeItr({
      ...base,
      incomeHeads: { ...base.incomeHeads, salary: 20_00_000, capitalGains: 3_00_000 },
      capitalGainsSpecialRate: { ltcg: 3_00_000 },
    });
    // GTI 23L includes the gain. Normal slice 23L − 3L = 20L → 2,00,000.
    // LTCG: (3L − 1.25L) @12.5% = 21,875. Cess 4% of 2,21,875 = 8,875.
    expect(computation.grossTotalIncome).toBe(23_00_000);
    expect(computation.basicIncome).toBe(23_00_000);
    expect(computation.taxBeforeRebate).toBe(2_21_875);
    expect(computation.cess).toBe(8_875);
    expect(computation.totalTaxLiability).toBe(2_30_750);
  });

  it("applies HRA exemption only in the old regime", () => {
    const old = computeItr({
      ...base,
      regime: "old",
      incomeHeads: { ...base.incomeHeads, salary: 10_00_000 },
      hra: {
        received: 2_40_000,
        paidRent: 3_00_000,
        city: true,
        metro: true,
        actualRent: 3_00_000,
        basicAndDaSalary: 6_00_000,
      },
    });
    expect(old.computation.hraExemption).toBe(2_40_000);
    const nu = computeItr({
      ...base,
      incomeHeads: { ...base.incomeHeads, salary: 10_00_000 },
      hra: {
        received: 2_40_000,
        paidRent: 3_00_000,
        city: true,
        metro: true,
        actualRent: 3_00_000,
        basicAndDaSalary: 6_00_000,
      },
    });
    expect(nu.computation.hraExemption).toBe(0);
    expect(nu.warnings.join(" ")).toMatch(/HRA.*not available in the new regime/i);
  });
});

describe("computeItr: prepaid tax and metadata", () => {
  it("nets prepaid tax off the liability, producing a refund when it overpays", () => {
    const { computation } = computeItr({
      ...base,
      incomeHeads: { ...base.incomeHeads, salary: 20_00_000 },
      prepaidTax: { tds: 10_000, tcs: 0, advanceTax: 2_00_000, selfAssessment: 0, demands: 0 },
    });
    expect(computation.totalTaxLiability).toBe(2_08_000);
    expect(computation.prepaidTax).toBe(2_10_000);
    expect(computation.netTaxPayableOrRefundable).toBe(-2_000); // refund
  });

  it("echoes the metadata and says which table it applied", () => {
    const { computation, warnings, methodology } = computeItr({
      ...base,
      fy: "2024-25",
      assesseeType: "hir india",
      formType: "ITR-2",
      incomeHeads: { ...base.incomeHeads, salary: 5_00_000 },
    });
    expect(computation.fy).toBe("2024-25");
    expect(computation.assesseeType).toBe("hir india");
    expect(computation.regime).toBe("new");
    expect(computation.formType).toBe("ITR-2");
    expect(methodology[0]).toMatch(/FY 2024-25/);
    expect(warnings.join(" ")).toMatch(/standard deduction/i);
  });
});
