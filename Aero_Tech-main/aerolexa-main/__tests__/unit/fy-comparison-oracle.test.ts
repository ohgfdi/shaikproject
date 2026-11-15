/**
 * FY 2024-25 vs FY 2025-26 — side-by-side oracle tests.
 *
 * The Finance Act 2025 rebuilt the new-regime slab table and moved the s.87A
 * rebate from ₹25,000 at ₹7,00,000 to ₹60,000 at ₹12,00,000. The same income
 * therefore produces a different answer in the two years, and a computation
 * that silently applies one year's table to the other is wrong by lakhs.
 *
 * Every figure below is hand-computed from the statutory tables in
 * `india-tax.ts` and pinned for BOTH years. The old-regime figures are pinned
 * as unchanged across the two years because no Finance Act touched them.
 */

import { computeItr } from "@/lib/engine/ca-itr-computation";
import {
  INDIVIDUAL_REGIMES_BY_FY,
  NEW_REGIME_2024_25,
  NEW_REGIME_2025_26,
  OLD_REGIME_2024_25,
  OLD_REGIME_2025_26,
  advanceTaxInstallments,
  computeIncomeTax,
  computeInterest234B,
  computeInterest234C,
  INR,
} from "@/lib/engine/india-tax";
import { computePayslip } from "@/lib/engine/payroll";

const FY24 = INDIVIDUAL_REGIMES_BY_FY["2024-25"]!;
const FY25 = INDIVIDUAL_REGIMES_BY_FY["2025-26"]!;

/** Income tax on a plain taxable figure with no deductions or standard deduction. */
const taxOn = (grossRupees: number, regime: typeof NEW_REGIME_2025_26) =>
  computeIncomeTax({
    grossIncome: INR(grossRupees),
    regime,
    applyStandardDeduction: false,
  });

const r = (minor: number) => minor / 100;

describe("new regime: the ₹12,00,000 rebate ceiling", () => {
  it("wipes out the tax at ₹12,00,000 in FY 2025-26 but not in FY 2024-25", () => {
    const fy25 = taxOn(1200000, FY25.new);
    // 4-8L 5% = 20,000 + 8-12L 10% = 40,000 = 60,000; rebate 60,000 → nil.
    expect(r(fy25.slabTax)).toBe(60000);
    expect(r(fy25.rebate)).toBe(60000);
    expect(r(fy25.totalTax)).toBe(0);

    const fy24 = taxOn(1200000, FY24.new);
    // 3-7L 5% = 20,000 + 7-10L 10% = 30,000 + 10-12L 15% = 30,000 = 80,000.
    // The ₹7L rebate threshold was crossed long ago → no rebate, only cess.
    expect(r(fy24.slabTax)).toBe(80000);
    expect(r(fy24.rebate)).toBe(0);
    expect(r(fy24.cess)).toBe(3200);
    expect(r(fy24.totalTax)).toBe(83200);
  });

  it("grants the ₹60,000 rebate up to the new threshold (FY 2024-25 gave ₹25,000 up to ₹7L)", () => {
    expect(r(taxOn(700000, FY25.new).totalTax)).toBe(0); // 15,000 tax, 15,000 rebate
    expect(r(taxOn(700000, FY24.new).totalTax)).toBe(0); // 20,000 tax, 20,000 rebate
    expect(r(FY25.new.rebate!.maxRebate)).toBe(60000);
    expect(r(FY24.new.rebate!.maxRebate)).toBe(25000);
  });
});

describe("new regime: slabs and marginal relief", () => {
  it("taxes ₹20,00,000 at ₹2,08,000 in FY 2025-26 and ₹3,01,600 in FY 2024-25", () => {
    const fy25 = taxOn(2000000, FY25.new);
    // 20,000 + 40,000 + 60,000 + 80,000 = 2,00,000; cess 4% = 8,000.
    expect(r(fy25.slabTax)).toBe(200000);
    expect(r(fy25.totalTax)).toBe(208000);

    const fy24 = taxOn(2000000, FY24.new);
    // 20,000 + 30,000 + 30,000 + 60,000 + 30% × 5,00,000 = 2,90,000; cess 11,600.
    expect(r(fy24.slabTax)).toBe(290000);
    expect(r(fy24.totalTax)).toBe(301600);
  });

  it("caps the tax at ₹10,400 just above ₹12,00,000 in FY 2025-26 (marginal relief)", () => {
    const fy25 = taxOn(1210000, FY25.new);
    // Slab tax 61,500 but income above ₹12L is only ₹10,000 → tax capped at
    // ₹10,000; cess 400 → ₹10,400.
    expect(r(fy25.slabTax)).toBe(61500);
    expect(r(fy25.rebate)).toBe(0);
    expect(r(fy25.rebateMarginalRelief)).toBe(51500);
    expect(r(fy25.totalTax)).toBe(10400);

    // FY 2024-25 has no relief here: the ₹7L threshold is far behind, so the
    // full slab tax plus cess is payable. 20,000 + 30,000 + 30,000 + 20% of
    // ₹10,000 (the FY 2024-25 12-15L band) = 82,000; cess 3,280.
    const fy24 = taxOn(1210000, FY24.new);
    expect(r(fy24.slabTax)).toBe(82000);
    expect(fy24.rebateMarginalRelief).toBe(0);
    expect(r(fy24.totalTax)).toBe(85280);
  });

  it("applies the 10% surcharge at ₹60,00,000 in both years, on each year's own slabs", () => {
    const fy25 = taxOn(6000000, FY25.new);
    expect(r(fy25.slabTax)).toBe(1380000);
    expect(fy25.surchargeBandPct).toBe(10);
    expect(r(fy25.surcharge)).toBe(138000);
    expect(r(fy25.cess)).toBe(60720);
    expect(r(fy25.totalTax)).toBe(1578720);

    const fy24 = taxOn(6000000, FY24.new);
    expect(r(fy24.slabTax)).toBe(1490000);
    expect(fy24.surchargeBandPct).toBe(10);
    expect(r(fy24.surcharge)).toBe(149000);
    expect(r(fy24.cess)).toBe(65560);
    expect(r(fy24.totalTax)).toBe(1704560);
  });
});

describe("old regime: identical in both years", () => {
  it("produces the same slab tax, rebate and cess for the same income", () => {
    const fy25 = taxOn(1000000, FY25.old);
    const fy24 = taxOn(1000000, FY24.old);
    // 2.5-5L 5% = 12,500 + 5-10L 20% = 1,00,000 = 1,12,500; cess 4,500.
    for (const res of [fy25, fy24]) {
      expect(r(res.slabTax)).toBe(112500);
      expect(r(res.rebate)).toBe(0);
      expect(r(res.cess)).toBe(4500);
      expect(r(res.totalTax)).toBe(117000);
    }
    expect(OLD_REGIME_2024_25.slabs).toEqual(OLD_REGIME_2025_26.slabs);
    expect(OLD_REGIME_2024_25.surcharge).toEqual(OLD_REGIME_2025_26.surcharge);
  });

  it("keeps the ₹5,00,000 / ₹12,500 rebate in both years", () => {
    expect(r(taxOn(500000, FY25.old).totalTax)).toBe(0);
    expect(r(taxOn(500000, FY24.old).totalTax)).toBe(0);
  });
});

describe("standard deduction by regime and year", () => {
  it("₹75,000 in the new regime (both years) and ₹50,000 in the old", () => {
    expect(r(NEW_REGIME_2024_25.standardDeduction)).toBe(75000);
    expect(r(NEW_REGIME_2025_26.standardDeduction)).toBe(75000);
    expect(r(OLD_REGIME_2024_25.standardDeduction)).toBe(50000);
    expect(r(OLD_REGIME_2025_26.standardDeduction)).toBe(50000);
  });
});

describe("computeItr: the same taxpayer in FY 2024-25 and FY 2025-26", () => {
  const baseItr = {
    assesseeType: "individual" as const,
    residentialStatus: "resident" as const,
    applyStandardDeduction: false,
    incomeHeads: {
      salary: 2000000,
      houseProperty: 0,
      businessProfession: 0,
      capitalGains: 0,
      otherSources: 0,
      agricultural: 0,
    },
    deductions: {
      section80C: 200000,
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
    formType: "ITR-2" as const,
    surcharges: { hvilag: false, healthcare: false },
  };

  it("new regime: ₹2,08,000 in FY 2025-26 against ₹3,01,600 in FY 2024-25", () => {
    const fy25 = computeItr({ ...baseItr, fy: "2025-26", regime: "new" }).computation;
    const fy24 = computeItr({ ...baseItr, fy: "2024-25", regime: "new" }).computation;

    expect(fy25.chapterVIADeductions).toBe(0); // 80C is not available in 115BAC
    expect(fy25.basicIncome).toBe(2000000);
    expect(fy25.totalTaxLiability).toBe(208000);

    expect(fy24.chapterVIADeductions).toBe(0);
    expect(fy24.basicIncome).toBe(2000000);
    expect(fy24.totalTaxLiability).toBe(301600);
  });

  it("old regime: §80C capped at ₹1,50,000 and the same ₹3,82,200 in both years", () => {
    const fy25 = computeItr({ ...baseItr, fy: "2025-26", regime: "old" }).computation;
    const fy24 = computeItr({ ...baseItr, fy: "2024-25", regime: "old" }).computation;

    for (const res of [fy25, fy24]) {
      expect(res.chapterVIADeductions).toBe(150000);
      expect(res.basicIncome).toBe(1850000);
      // 12,500 + 1,00,000 + 30% × 8,50,000 = 3,67,500; cess 14,700.
      expect(res.taxBeforeRebate).toBe(367500);
      expect(res.totalTaxLiability).toBe(382200);
    }
  });
});

describe("advance tax and interest: the schedule follows the year", () => {
  it("moves the four due dates with the financial year", () => {
    expect(advanceTaxInstallments("2024-25").map((i) => i.dueDate)).toEqual([
      "2024-06-15",
      "2024-09-15",
      "2024-12-15",
      "2025-03-15",
    ]);
    expect(advanceTaxInstallments("2025-26").map((i) => i.dueDate)).toEqual([
      "2025-06-15",
      "2025-09-15",
      "2025-12-15",
      "2026-03-15",
    ]);
  });

  it("charges 234C on the same shortfall identically in both years", () => {
    const assessed = INR(1000000);
    const run = (fy: string, startYear: number) =>
      computeInterest234C({
        assessedTax: assessed,
        fy,
        payments: [{ date: `${startYear}-09-15`, amount: INR(100000) }],
      });

    const fy24 = run("2024-25", 2024);
    const fy25 = run("2025-26", 2025);
    // Q1: 1,50,000 required, nil paid → 4,500.
    // Q2: 4,50,000 required, 1,00,000 paid (below the 36% proviso) → 10,500.
    // Q3: 7,50,000 required, 1,00,000 paid (below the 75% proviso) → 19,500.
    // Q4: 10,00,000 required, 1,00,000 paid → 9,000.
    for (const res of [fy24, fy25]) {
      expect(res.totalInterest).toBe(INR(43500));
      expect(res.belowThreshold).toBe(false);
      expect(res.perInstallment.map((p) => p.interest)).toEqual([INR(4500), INR(10500), INR(19500), INR(9000)]);
    }
    // The dates, however, are the year's own.
    expect(fy24.perInstallment.map((p) => p.dueDate)[0]).toBe("2024-06-15");
    expect(fy25.perInstallment.map((p) => p.dueDate)[0]).toBe("2025-06-15");
  });

  it("runs 234B from 1 April of the assessment year, which is one year later for FY 2025-26", () => {
    const fy24 = computeInterest234B({
      assessedTax: INR(1000000),
      advanceTaxPaid: 0,
      fy: "2024-25",
      determinationDate: "2025-09-30",
    });
    const fy25 = computeInterest234B({
      assessedTax: INR(1000000),
      advanceTaxPaid: 0,
      fy: "2025-26",
      determinationDate: "2026-09-30",
    });
    expect(fy24.months).toBe(6);
    expect(fy24.interest).toBe(INR(60000));
    expect(fy25.months).toBe(6);
    expect(fy25.interest).toBe(INR(60000));
    expect(fy24.methodology[1]).toContain("1% per month");
  });
});

describe("payroll TDS u/s 192 across the two years", () => {
  const employee = { employeeId: "E1", name: "Salaried", basic: INR(100000) };

  it("deducts nil for a ₹12,75,000 salary in FY 2025-26 and ₹6,933 a month in FY 2024-25", () => {
    const fy25 = computePayslip({
      employee,
      month: "2025-04",
      annualTaxableSalary: INR(1275000),
      monthsRemaining: 12,
      regime: NEW_REGIME_2025_26,
    });
    // 12,75,000 − 75,000 standard deduction = 12,00,000 taxable → 87A rebate
    // wipes out the ₹60,000 slab tax.
    expect(fy25.tdsAnnualTax).toBe(0);
    expect(fy25.deductions.tds).toBe(0);

    const fy24 = computePayslip({
      employee,
      month: "2024-04",
      annualTaxableSalary: INR(1275000),
      monthsRemaining: 12,
      regime: NEW_REGIME_2024_25,
    });
    // Same taxable ₹12,00,000 under the older table → ₹83,200 p.a.;
    // 8,32,000 paise ÷ 12, rounded to whole rupees = ₹6,933 a month.
    expect(fy24.tdsAnnualTax).toBe(INR(83200));
    expect(fy24.deductions.tds).toBe(INR(6933));
  });

  it("keeps the statutory payroll ceilings identical in both years", () => {
    const fy24 = computePayslip({
      employee: { employeeId: "E2", name: "Ceiling", basic: INR(25000) },
      month: "2024-04",
      regime: NEW_REGIME_2024_25,
    });
    const fy25 = computePayslip({
      employee: { employeeId: "E2", name: "Ceiling", basic: INR(25000) },
      month: "2025-04",
      regime: NEW_REGIME_2025_26,
    });
    // EPF wages capped at ₹15,000; ESI applies at ₹25,000 gross only in neither
    // year (ceiling ₹21,000), so both payslips agree.
    expect(fy24.epfWages).toBe(INR(15000));
    expect(fy25.epfWages).toBe(INR(15000));
    expect(fy24.deductions.epfEmployee).toBe(INR(1800));
    expect(fy25.deductions.epfEmployee).toBe(INR(1800));
    expect(fy24.esiApplicable).toBe(false);
    expect(fy25.esiApplicable).toBe(false);
  });
});
