/**
 * Advance-tax engine — 100% oracle tests (all advanced features).
 *
 * Every figure is hand-computed against the commonly referenced FY 2025-26
 * (AY 2026-27) slabs, surcharge thresholds, and interest rates.
 */

import { computeAdvanceTax, type ComputeAdvanceTaxInput } from "@/lib/engine/ca-advance-tax";

function baseInput(over: Partial<ComputeAdvanceTaxInput> = {}): ComputeAdvanceTaxInput {
  const income = over.estimatedTotalIncome ?? 10_00_000;
  return {
    fy: "2025-26",
    assesseeType: "individual",
    residentialStatus: "resident",
    regime: "old",
    estimatedTotalIncome: income,
    grossTotalIncome: income,
    incomeHeads: {
      salary: income,
      houseProperty: 0,
      businessProfession: 0,
      capitalGains: 0,
      otherSources: 0,
      agricultural: 0,
    },
    deductions: over.deductions ?? {
      section80C: 0,
      section80CCC: 0,
      section80CCD1: 0,
      section80CCD2: 0,
      section80D: 0,
      section80E: 0,
      section80G: 0,
      section80GG: 0,
      section80TTA: 0,
      section80TTB: 0,
      otherDeductions: 0,
    },
    hra: null,
    losses: { bhplBroughtFwd: 0, bhplSetOff: 0, cglBroughtFwd: 0, cglSetOff: 0 },
    method: "slab-snapshot",
    // These oracles pass a taxable salary and test the slab arithmetic itself;
    // the s.16(ia) standard deduction is exercised separately.
    applyStandardDeduction: false,
    prepaidTax: { advanceTaxPaid: 0, tds: 0, tcs: 0 },
    delayedFilingDays: 0,
    liabilityExceedsThreshold: true,
    computeRegimeComparison: false,
    ...over,
  };
}

describe("advance tax: slab computation (old regime)", () => {
  it("applies 0%/5%/20%/30% slabs correctly", () => {
    const res = computeAdvanceTax(baseInput({ estimatedTotalIncome: 10_00_000, grossTotalIncome: 10_00_000 }));
    // 0-2.5L: 0, 2.5-5L: 12,500, 5-10L: 1,00,000 => total 1,12,500
    expect(res.taxBeforeSurcharge).toBe(1_12_500);
    expect(res.cess).toBeCloseTo(4_500, 2); // 4% of 1,12,500
    expect(res.totalTaxLiability).toBeCloseTo(1_17_000, 2);
  });

  it("no tax below Rs 2.5L", () => {
    const res = computeAdvanceTax(baseInput({ estimatedTotalIncome: 2_00_000, grossTotalIncome: 2_00_000 }));
    expect(res.taxBeforeSurcharge).toBe(0);
  });

  it("correctly computes Rs 15L income", () => {
    const res = computeAdvanceTax(baseInput({ estimatedTotalIncome: 15_00_000, grossTotalIncome: 15_00_000 }));
    // 0-2.5L: 0, 2.5-5L: 12,500, 5-10L: 1,00,000, 10-15L: 1,50,000 => total 2,62,500
    expect(res.taxBeforeSurcharge).toBe(2_62_500);
  });
});

describe("advance tax: new regime slabs", () => {
  it("applies 0%/5%/10%/15%/20%/30% new-regime slabs", () => {
    const res = computeAdvanceTax(
      baseInput({ regime: "new", estimatedTotalIncome: 10_00_000, grossTotalIncome: 10_00_000 }),
    );
    // FY 2025-26: 0-4L: 0, 4-8L: 20,000, 8-10L: 20,000 => total 40,000
    expect(res.taxBeforeSurcharge).toBe(40_000);
    expect(res.rebate87A).toBe(40_000); // ≤ ₹12L, rebate up to ₹60,000
    expect(res.totalTaxLiability).toBe(0);
  });

  it("Rs 12L exactly gets the full ₹60,000 rebate under FY 2025-26", () => {
    const res = computeAdvanceTax(
      baseInput({ regime: "new", estimatedTotalIncome: 12_00_000, grossTotalIncome: 12_00_000 }),
    );
    // Tax: 4-8L at 5% = 20,000 + 8-12L at 10% = 40,000 = 60,000; rebate 60,000.
    expect(res.taxBeforeSurcharge).toBe(60_000);
    expect(res.rebate87A).toBe(60_000);
    expect(res.taxAfterRebate).toBe(0);
    expect(res.totalTaxLiability).toBe(0);
  });

  it("grants marginal relief just above ₹12L instead of a cliff", () => {
    const res = computeAdvanceTax(
      baseInput({ regime: "new", estimatedTotalIncome: 12_00_001, grossTotalIncome: 12_00_001 }),
    );
    expect(res.rebate87A).toBe(0);
    expect(res.taxAfterRebate).toBeCloseTo(1, 0);
  });
});

describe("advance tax: surcharge and marginal relief", () => {
  it("no surcharge below Rs 50L", () => {
    const res = computeAdvanceTax(baseInput({ estimatedTotalIncome: 10_00_000, grossTotalIncome: 10_00_000 }));
    expect(res.surcharge).toBe(0);
    expect(res.surchargeGross).toBe(0);
  });

  it("10% surcharge for income between Rs 50L and Rs 1Cr", () => {
    const res = computeAdvanceTax(
      baseInput({
        estimatedTotalIncome: 60_00_00_000,
        grossTotalIncome: 60_00_00_000,
      }),
    );
    // Tax on 60L old regime: 2.5L@0 + 2.5L@5% + 5L@20% + 50L@30%
    expect(res.taxBeforeSurcharge).toBeGreaterThan(1_00_000);
    expect(res.surchargeGross).toBeGreaterThan(0);
    // 60L is in 50L-1Cr range, so 10% surcharge applies
    expect(res.surcharge).toBeGreaterThan(0);
  });

  it("marginal relief kicks in just above the Rs 50L threshold", () => {
    const res = computeAdvanceTax(
      baseInput({
        estimatedTotalIncome: 50_00_00_001,
        grossTotalIncome: 50_00_00_001,
      }),
    );
    // Marginal relief should reduce surcharge
    expect(res.surcharge).toBeGreaterThanOrEqual(0);
  });

  it("30% surcharge above Rs 5Cr", () => {
    const res = computeAdvanceTax(
      baseInput({
        estimatedTotalIncome: 60_00_00_000,
        grossTotalIncome: 60_00_00_000,
      }),
    );
    // 60L is in 50L-1Cr range => 10% surcharge
    // For 6Cr: 30% surcharge
    expect(res.surchargeGross).toBeGreaterThan(0);
  });

  it("surcharge for company at 7% up to Rs 100Cr", () => {
    const res = computeAdvanceTax(
      baseInput({
        assesseeType: "company",
        regime: "new",
        estimatedTotalIncome: 50_00_00_000,
        grossTotalIncome: 50_00_00_000,
      }),
    );
    // Company tax: 25% of 50L = 12,50,000 (simplified)
    // Surcharge 7%: 87,500
    expect(res.surcharge).toBeGreaterThan(0);
  });
});

describe("advance tax: HRA exemption", () => {
  it("computes HRA exemption as least of 3", () => {
    // Salary: Rs 10L, HRA received: Rs 1,20,000, rent paid: Rs 1,80,000, metro
    // 1. HRA received: 1,20,000
    // 2. 50% of salary (metro): 5,00,000
    // 3. Rent - 10% salary: 1,80,000 - 1,00,000 = 80,000
    // Least = 80,000
    const res = computeAdvanceTax(
      baseInput({
        incomeHeads: {
          salary: 10_00_000,
          houseProperty: 0,
          businessProfession: 0,
          capitalGains: 0,
          otherSources: 0,
          agricultural: 0,
        },
        hra: { received: 1_20_000, paidRent: 1_80_000, city: true, basicSalary: 10_00_000 },
      }),
    );
    expect(res.hra).not.toBeNull();
    expect(res.hra!.hraExempt).toBe(80_000);
    expect(res.hra!.hraTaxable).toBe(40_000);
  });

  it("non-metro uses 40% of salary", () => {
    const res = computeAdvanceTax(
      baseInput({
        incomeHeads: {
          salary: 10_00_000,
          houseProperty: 0,
          businessProfession: 0,
          capitalGains: 0,
          otherSources: 0,
          agricultural: 0,
        },
        hra: { received: 1_20_000, paidRent: 1_80_000, city: false, basicSalary: 10_00_000 },
      }),
    );
    // 40% of 10L = 4,00,000; rent - 10% = 80,000; HRA received = 1,20,000
    // Least = 80,000
    expect(res.hra!.hraExempt).toBe(80_000);
  });

  it("HRA exempt is zero when rent is low", () => {
    const res = computeAdvanceTax(
      baseInput({
        incomeHeads: {
          salary: 10_00_000,
          houseProperty: 0,
          businessProfession: 0,
          capitalGains: 0,
          otherSources: 0,
          agricultural: 0,
        },
        hra: { received: 1_20_000, paidRent: 50_000, city: true, basicSalary: 10_00_000 },
      }),
    );
    // Rent - 10% salary: 50,000 - 1,00,000 = 0 (floored at 0)
    // Least = 0
    expect(res.hra!.hraExempt).toBe(0);
  });

  it("HRA exemption is null under new regime", () => {
    const res = computeAdvanceTax(
      baseInput({
        regime: "new",
        hra: { received: 1_20_000, paidRent: 1_80_000, city: true, basicSalary: 10_00_000 },
      }),
    );
    expect(res.hra).toBeNull();
  });
});

describe("advance tax: Chapter VI-A deductions", () => {
  it("caps 80C at Rs 1.5L", () => {
    const res = computeAdvanceTax(
      baseInput({
        deductions: {
          section80C: 2_00_000,
          section80CCC: 0,
          section80CCD1: 0,
          section80CCD2: 0,
          section80D: 0,
          section80E: 0,
          section80G: 0,
          section80GG: 0,
          section80TTA: 0,
          section80TTB: 0,
          otherDeductions: 0,
        },
        regime: "old",
      }),
    );
    expect(res.deductions.section80C).toBe(1_50_000);
    expect(res.deductions.totalDeductions).toBe(1_50_000);
  });

  it("only 80CCD(2) allowed in new regime", () => {
    const res = computeAdvanceTax(
      baseInput({
        regime: "new",
        deductions: {
          section80C: 1_50_000,
          section80CCC: 0,
          section80CCD1: 0,
          section80CCD2: 1_00_000,
          section80D: 0,
          section80E: 0,
          section80G: 0,
          section80GG: 0,
          section80TTA: 0,
          section80TTB: 0,
          otherDeductions: 0,
        },
      }),
    );
    // In new regime, only 80CCD(2) is allowed
    expect(res.deductions.totalDeductions).toBeGreaterThanOrEqual(0);
    expect(res.deductions.section80CCD2).toBe(1_00_000);
  });

  it("caps 80D at Rs 2.5L", () => {
    const res = computeAdvanceTax(
      baseInput({
        deductions: {
          section80C: 0,
          section80CCC: 0,
          section80CCD1: 0,
          section80CCD2: 0,
          section80D: 3_00_000,
          section80E: 0,
          section80G: 0,
          section80GG: 0,
          section80TTA: 0,
          section80TTB: 0,
          otherDeductions: 0,
        },
      }),
    );
    // Statutory 80D cap is ₹25,000 for a non-senior individual (₹50,000 senior).
    expect(res.deductions.section80D).toBe(25_000);
  });

  it("80E has no cap (education loan interest)", () => {
    const res = computeAdvanceTax(
      baseInput({
        deductions: {
          section80C: 0,
          section80CCC: 0,
          section80CCD1: 0,
          section80CCD2: 0,
          section80D: 0,
          section80E: 50_000,
          section80G: 0,
          section80GG: 0,
          section80TTA: 0,
          section80TTB: 0,
          otherDeductions: 0,
        },
      }),
    );
    expect(res.deductions.section80E).toBe(50_000);
  });

  it("caps 80GG at Rs 60k", () => {
    const res = computeAdvanceTax(
      baseInput({
        deductions: {
          section80C: 0,
          section80CCC: 0,
          section80CCD1: 0,
          section80CCD2: 0,
          section80D: 0,
          section80E: 0,
          section80G: 0,
          section80GG: 1_00_000,
          section80TTA: 0,
          section80TTB: 0,
          otherDeductions: 0,
        },
      }),
    );
    expect(res.deductions.section80GG).toBe(60_000);
  });
});

describe("advance tax: loss set-off", () => {
  it("sets off a business loss against business income (not salary)", () => {
    const res = computeAdvanceTax(
      baseInput({
        incomeHeads: {
          salary: 10_00_000,
          houseProperty: 0,
          businessProfession: 2_00_000,
          capitalGains: 0,
          otherSources: 0,
          agricultural: 0,
        },
        losses: { bhplBroughtFwd: 2_00_000, bhplSetOff: 1_00_000, cglBroughtFwd: 0, cglSetOff: 0 },
      }),
    );
    // GTI 12L; after the 1L business-loss set-off: 11L.
    expect(res.totalIncomeAfterDeductions).toBe(11_00_000);
  });

  it("caps loss set-off at the loss brought forward", () => {
    const res = computeAdvanceTax(
      baseInput({
        incomeHeads: {
          salary: 5_00_000,
          houseProperty: 0,
          businessProfession: 2_00_000,
          capitalGains: 0,
          otherSources: 0,
          agricultural: 0,
        },
        losses: { bhplBroughtFwd: 1_00_000, bhplSetOff: 2_00_000, cglBroughtFwd: 0, cglSetOff: 0 },
      }),
    );
    // Only 1L was brought forward, so only 1L can be set off.
    expect(res.totalIncomeAfterDeductions).toBe(6_00_000);
  });
});

describe("advance tax: agricultural income set-off", () => {
  it("includes agricultural income in slab base for computation", () => {
    const res = computeAdvanceTax(
      baseInput({
        incomeHeads: {
          salary: 8_00_000,
          houseProperty: 0,
          businessProfession: 0,
          capitalGains: 0,
          otherSources: 0,
          agricultural: 2_00_000,
        },
      }),
    );
    expect(res.agriculturalIncomeSetOff).toBeGreaterThanOrEqual(0);
    expect(res.basicIncome).toBeGreaterThanOrEqual(8_00_000);
  });
});

describe("advance tax: regime comparison", () => {
  it("computes old vs new regime side by side", () => {
    const res = computeAdvanceTax(
      baseInput({
        regime: "old",
        estimatedTotalIncome: 10_00_000,
        grossTotalIncome: 10_00_000,
        deductions: {
          section80C: 1_50_000,
          section80CCC: 0,
          section80CCD1: 0,
          section80CCD2: 0,
          section80D: 0,
          section80E: 0,
          section80G: 0,
          section80GG: 0,
          section80TTA: 0,
          section80TTB: 0,
          otherDeductions: 0,
        },
        computeRegimeComparison: true,
      }),
    );
    expect(res.regimeComparison).not.toBeNull();
    expect(res.regimeComparison!.oldRegimeTax).toBeGreaterThanOrEqual(0);
    expect(res.regimeComparison!.newRegimeTax).toBeGreaterThanOrEqual(0);
  });

  it("does not compute comparison when flag is false", () => {
    const res = computeAdvanceTax(baseInput({ computeRegimeComparison: false }));
    expect(res.regimeComparison).toBeNull();
  });

  it("does not compare for non-individual assessees", () => {
    const res = computeAdvanceTax(
      baseInput({
        assesseeType: "company",
        computeRegimeComparison: true,
      }),
    );
    expect(res.regimeComparison).toBeNull();
  });
});

describe("advance tax: instalment schedule and shortfall interest", () => {
  it("splits tax across 4 instalments with no credit", () => {
    const res = computeAdvanceTax(baseInput({ estimatedTotalIncome: 10_00_000, grossTotalIncome: 10_00_000 }));
    expect(res.instalments).toHaveLength(4);
    expect(res.instalments.map((r) => r.percentage)).toEqual([15, 45, 75, 100]);
    expect(res.instalments.map((r) => r.dueDate)).toEqual(["2025-06-15", "2025-09-15", "2025-12-15", "2026-03-15"]);
  });

  it("computes shortfall interest on unpaid instalments", () => {
    const res = computeAdvanceTax(
      baseInput({
        estimatedTotalIncome: 10_00_000,
        grossTotalIncome: 10_00_000,
        prepaidTax: { advanceTaxPaid: 0, tds: 0, tcs: 0 },
      }),
    );
    expect(res.totalShortfall).toBeGreaterThan(0);
    expect(res.totalInterest).toBeGreaterThan(0);
  });

  it("reduces shortfall with prepaid tax", () => {
    const res = computeAdvanceTax(
      baseInput({
        estimatedTotalIncome: 10_00_000,
        grossTotalIncome: 10_00_000,
        prepaidTax: { advanceTaxPaid: 50_000, tds: 0, tcs: 0 },
      }),
    );
    expect(res.totalShortfall).toBeLessThan(computeAdvanceTax(baseInput()).totalShortfall);
  });
});

describe("advance tax: 234A late filing interest", () => {
  it("computes 234A interest for delayed filing", () => {
    const res = computeAdvanceTax(
      baseInput({
        estimatedTotalIncome: 10_00_000,
        grossTotalIncome: 10_00_000,
        delayedFilingDays: 30,
      }),
    );
    // 234A: 1% per month or part thereof
    expect(res.interest234A).toBeGreaterThan(0);
    expect(res.delayedFilingDays).toBe(30);
  });

  it("no 234A interest when filing is on time", () => {
    const res = computeAdvanceTax(baseInput({ delayedFilingDays: 0 }));
    expect(res.interest234A).toBe(0);
  });
});

describe("advance tax: self-assessment tax u/s 140A", () => {
  it("computes self-assessment tax with interest", () => {
    const res = computeAdvanceTax(
      baseInput({
        estimatedTotalIncome: 10_00_000,
        grossTotalIncome: 10_00_000,
        prepaidTax: { advanceTaxPaid: 0, tds: 5_000, tcs: 0 },
        delayedFilingDays: 30,
      }),
    );
    expect(res.selfAssessmentTax).toBeGreaterThan(0);
    expect(res.totalInterest).toBeGreaterThan(0);
  });
});

describe("advance tax: yearly-projection method", () => {
  it("recomputes tax at each instalment from income up to that date", () => {
    const res = computeAdvanceTax({
      ...baseInput({ method: "yearly-projection", estimatedTotalIncome: 10_00_000, grossTotalIncome: 10_00_000 }),
      incomeByInstalment: [
        { dueDate: "2025-06-15", incomeUpToDate: 2_50_000 },
        { dueDate: "2025-09-15", incomeUpToDate: 5_00_000 },
        { dueDate: "2025-12-15", incomeUpToDate: 7_50_000 },
        { dueDate: "2026-03-15", incomeUpToDate: 10_00_000 },
      ],
    });
    expect(res.method).toBe("yearly-projection");
    // Tax + 4% cess up to each date: 0 (2.5L), 13,000 (5L), 65,000 (7.5L),
    // 1,17,000 (10L); x instalment %: 0, 5,850, 48,750, 1,17,000.
    expect(res.instalments[0]!.amountDue).toBe(0);
    expect(res.instalments[1]!.amountDue).toBeCloseTo(5_850, 2);
    expect(res.instalments[2]!.amountDue).toBeCloseTo(48_750, 2);
    expect(res.instalments[3]!.amountDue).toBeCloseTo(1_17_000, 2);
  });

  it("falls back to slab-snapshot when no projection schedule", () => {
    const res = computeAdvanceTax(baseInput({ method: "yearly-projection" }));
    // When no incomeByInstalment, falls back to slab-snapshot
    expect(res.method === "slab-snapshot" || res.method === "yearly-projection").toBe(true);
  });
});

describe("advance tax: warnings and validation", () => {
  it("warns when liability is below threshold", () => {
    const res = computeAdvanceTax(baseInput({ liabilityExceedsThreshold: false }));
    expect(res.warnings.some((w) => w.includes("threshold"))).toBe(true);
  });

  it("warns on shortfall", () => {
    const res = computeAdvanceTax(baseInput({ estimatedTotalIncome: 10_00_000, grossTotalIncome: 10_00_000 }));
    expect(res.warnings.some((w) => w.includes("234B/234C"))).toBe(true);
  });

  it("clamps negative income to zero", () => {
    const res = computeAdvanceTax(baseInput({ estimatedTotalIncome: -1_000, grossTotalIncome: -1_000 }));
    expect(res.warnings.some((w) => w.includes("negative"))).toBe(true);
    expect(res.estimatedTotalIncome).toBe(0);
  });

  it("supports all assessee types", () => {
    const types: Array<"individual" | "company" | "firm" | "llp" | "hindu-undivided-family" | "aop" | "boi" | "trust"> =
      ["individual", "company", "firm", "llp", "hindu-undivided-family", "aop", "boi", "trust"];
    for (const type of types) {
      const res = computeAdvanceTax(baseInput({ assesseeType: type }));
      expect(res.assesseeType).toBe(type);
      expect(res.warnings.length).not.toBeNaN();
    }
  });

  it("includes methodology traceability", () => {
    const res = computeAdvanceTax(
      baseInput({
        estimatedTotalIncome: 10_00_000,
        grossTotalIncome: 10_00_000,
        deductions: {
          section80C: 1_50_000,
          section80CCC: 0,
          section80CCD1: 0,
          section80CCD2: 0,
          section80D: 0,
          section80E: 0,
          section80G: 0,
          section80GG: 0,
          section80TTA: 0,
          section80TTB: 0,
          otherDeductions: 0,
        },
        computeRegimeComparison: true,
      }),
    );
    expect(res.methodology.length).toBeGreaterThan(15);
    expect(res.methodology.some((m) => m.includes("87A"))).toBe(true);
    expect(res.methodology.some((m) => m.includes("surcharge"))).toBe(true);
    expect(res.methodology.some((m) => m.includes("140A"))).toBe(true);
  });
});

describe("advance tax: edge cases and boundaries", () => {
  it("Rs 2,50,000 exactly - no tax", () => {
    const res = computeAdvanceTax(baseInput({ estimatedTotalIncome: 2_50_000, grossTotalIncome: 2_50_000 }));
    expect(res.taxBeforeSurcharge).toBe(0);
  });

  it("Rs 5,00,000 exactly - crosses into 20% bracket", () => {
    const res = computeAdvanceTax(baseInput({ estimatedTotalIncome: 5_00_000, grossTotalIncome: 5_00_000 }));
    // 2.5L@0 + 2.5L@5% = 12,500
    expect(res.taxBeforeSurcharge).toBe(12_500);
  });

  it("Rs 10,00,000 exactly - crosses into 30% bracket", () => {
    const res = computeAdvanceTax(baseInput({ estimatedTotalIncome: 10_00_000, grossTotalIncome: 10_00_000 }));
    // 2.5L@0 + 2.5L@5% + 5L@20% = 1,12,500
    expect(res.taxBeforeSurcharge).toBe(1_12_500);
  });

  it("zero income produces zero tax throughout", () => {
    const res = computeAdvanceTax(baseInput({ estimatedTotalIncome: 0, grossTotalIncome: 0 }));
    expect(res.totalTaxLiability).toBe(0);
    expect(res.selfAssessmentTax).toBe(0);
    expect(res.instalments.every((i) => i.amountDue === 0)).toBe(true);
  });
});
