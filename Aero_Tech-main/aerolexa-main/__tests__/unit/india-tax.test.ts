/**
 * Indian direct-tax engine — oracle tests.
 *
 * Every expected figure is derived by hand from the statute's slabs/bands, not
 * captured from a previous run. The two rules that matter most are the 87A
 * marginal relief (the new-regime cliff at ₹7L) and surcharge marginal relief
 * (the cliff at each surcharge threshold); both are pinned exactly below.
 */

import {
  CORPORATE_REGIMES,
  INDIVIDUAL_REGIMES,
  INR,
  advanceTaxInstallments,
  computeCorporateTax,
  computeEquityCapitalGains,
  computeHraExemption,
  computeIncomeTax,
  computeInterest234B,
  computeInterest234C,
  formatInr,
  slabTax,
} from "@/lib/engine/india-tax";

const r = (minor: number) => minor / 100;

describe("INR formatting", () => {
  it("groups digits the Indian way", () => {
    expect(formatInr(INR(1234567))).toBe("12,34,567");
    expect(formatInr(INR(100000))).toBe("1,00,000");
    expect(formatInr(INR(1234567.5))).toBe("12,34,567.50");
    expect(formatInr(INR(-500))).toBe("-500");
  });
});

describe("slab tax", () => {
  it("applies each slab only to the income within it", () => {
    // New regime up to ₹10L: 3–7L @5% = 20,000 + 7–10L @10% = 30,000.
    expect(slabTax(INR(1000000), INDIVIDUAL_REGIMES.new!.slabs)).toBe(INR(50000));
  });
});

describe("individual income tax — new regime", () => {
  it("computes tax, surcharge-free, with 4% cess", () => {
    const res = computeIncomeTax({ grossIncome: INR(1000000), regime: INDIVIDUAL_REGIMES.new! });
    expect(r(res.taxableIncome)).toBe(1000000);
    expect(r(res.slabTax)).toBe(50000);
    expect(res.surcharge).toBe(0);
    expect(r(res.cess)).toBe(2000); // 4% of 50,000
    expect(r(res.totalTax)).toBe(52000);
  });

  it("zeroes out tax at ₹7L via the 87A rebate", () => {
    const res = computeIncomeTax({ grossIncome: INR(700000), regime: INDIVIDUAL_REGIMES.new! });
    expect(r(res.slabTax)).toBe(20000); // 3–7L @5%
    expect(r(res.rebate)).toBe(20000);
    expect(res.totalTax).toBe(0);
  });

  it("grants marginal relief just above ₹7L (no cliff)", () => {
    // Income ₹7.10L: slab tax = 20,000 + 1,000 = 21,000. Excess over 7L = 10,000.
    // Relief caps tax at 10,000, so total = 10,000 + 4% cess = 10,400.
    const res = computeIncomeTax({ grossIncome: INR(710000), regime: INDIVIDUAL_REGIMES.new! });
    expect(r(res.slabTax)).toBe(21000);
    expect(r(res.rebateMarginalRelief)).toBe(11000);
    expect(r(res.taxAfterRebate)).toBe(10000);
    expect(r(res.totalTax)).toBe(10400);
  });

  it("applies the standard deduction for salary income", () => {
    const res = computeIncomeTax({ grossIncome: INR(775000), regime: INDIVIDUAL_REGIMES.new!, applyStandardDeduction: true });
    expect(r(res.standardDeduction)).toBe(75000);
    expect(r(res.taxableIncome)).toBe(700000);
    expect(res.totalTax).toBe(0); // rebate at exactly 7L
  });
});

describe("individual income tax — old regime", () => {
  it("computes tax with 4% cess", () => {
    // ₹10L: 2.5–5L @5% = 12,500 + 5–10L @20% = 1,00,000 = 1,12,500; cess 4,500.
    const res = computeIncomeTax({ grossIncome: INR(1000000), regime: INDIVIDUAL_REGIMES.old! });
    expect(r(res.slabTax)).toBe(112500);
    expect(r(res.cess)).toBe(4500);
    expect(r(res.totalTax)).toBe(117000);
  });

  it("rebates up to ₹5L", () => {
    const res = computeIncomeTax({ grossIncome: INR(500000), regime: INDIVIDUAL_REGIMES.old! });
    expect(r(res.slabTax)).toBe(12500);
    expect(res.totalTax).toBe(0);
  });
});

describe("surcharge and marginal relief", () => {
  it("applies the 10% band just above ₹50L with marginal relief", () => {
    // ₹50.10L: slab tax = 1,140 (up to 15L) ... compute directly:
    // up to 15L = 20,000+30,000+30,000+60,000 = 1,40,000; 15L→50.1L = 35.1L @30% = 10,53,000.
    // slabTax = 11,93,000. Surcharge raw = 1,19,300. Cap = tax@50L (11,90,000) + 10,000 = 12,00,000.
    // tax+surcharge = 13,12,300 > cap → surcharge = 12,00,000 - 11,93,000 = 7,000; relief 1,12,300.
    const res = computeIncomeTax({ grossIncome: INR(5010000), regime: INDIVIDUAL_REGIMES.new! });
    expect(r(res.slabTax)).toBe(1193000);
    expect(r(res.surcharge)).toBe(7000);
    expect(r(res.surchargeMarginalRelief)).toBe(112300);
    expect(r(res.taxAfterRebate + res.surcharge)).toBe(1200000);
    expect(r(res.cess)).toBe(48000); // 4% of 12,00,000
    expect(r(res.totalTax)).toBe(1248000);
  });

  it("applies the 10% band at exactly ₹1Cr (strictly-above boundary)", () => {
    // At exactly 1Cr the 15% band does not apply yet; slab tax = 26,90,000.
    const res = computeIncomeTax({ grossIncome: INR(10000000), regime: INDIVIDUAL_REGIMES.new! });
    expect(r(res.slabTax)).toBe(2690000);
    expect(res.surchargeBandPct).toBe(10);
  });
});

describe("HRA exemption", () => {
  it("takes the least of the three amounts (metro)", () => {
    // Salary 6L, HRA 2.4L, rent 3L: least of 2.4L, 3L−60,000=2.4L, 50%=3L = 2.4L.
    const res = computeHraExemption({ salary: INR(600000), hraReceived: INR(240000), rentPaid: INR(300000), metro: true });
    expect(r(res.exempt)).toBe(240000);
    expect(r(res.taxableHra)).toBe(0);
  });

  it("uses 40% for non-metro", () => {
    const res = computeHraExemption({ salary: INR(600000), hraReceived: INR(300000), rentPaid: INR(300000), metro: false });
    expect(r(res.components.basicShare)).toBe(240000);
    expect(r(res.exempt)).toBe(240000);
  });
});

describe("advance tax", () => {
  it("builds the statutory installment schedule", () => {
    const inst = advanceTaxInstallments("2024-25");
    expect(inst.map((i) => i.cumulativePct)).toEqual([15, 45, 75, 100]);
    expect(inst[0]!.dueDate).toBe("2024-06-15");
    expect(inst[3]!.dueDate).toBe("2025-03-15");
  });

  it("computes 234C interest on installment shortfalls", () => {
    // Assessed tax ₹1,00,000. Paid 15k by Jun, 40k cumulative by Sep, 70k by Dec, 100k by Mar.
    const res = computeInterest234C({
      assessedTax: INR(100000),
      fy: "2024-25",
      payments: [
        { date: "2024-06-10", amount: INR(15000) },
        { date: "2024-09-10", amount: INR(25000) }, // cumulative 40,000 vs 45,000 → short 5,000
        { date: "2024-12-10", amount: INR(30000) }, // cumulative 70,000 vs 75,000 → short 5,000
        { date: "2025-03-10", amount: INR(30000) }, // cumulative 1,00,000 → 0
      ],
    });
    expect(r(res.perInstallment[0]!.interest)).toBe(0);
    expect(r(res.perInstallment[1]!.shortfall)).toBe(5000);
    expect(r(res.perInstallment[1]!.interest)).toBe(150); // 5,000 × 1% × 3
    expect(r(res.perInstallment[2]!.interest)).toBe(150);
    expect(r(res.perInstallment[3]!.interest)).toBe(0);
    expect(r(res.totalInterest)).toBe(300);
  });

  it("charges 234B only below the 90% threshold", () => {
    // Assessed ₹1L, paid ₹80k < ₹90k. AY starts 2025-04-01; date 2025-07-20 → 4 months.
    const res = computeInterest234B({
      assessedTax: INR(100000),
      advanceTaxPaid: INR(80000),
      fy: "2024-25",
      determinationDate: "2025-07-20",
    });
    expect(res.thresholdMet).toBe(false);
    expect(r(res.shortfall)).toBe(20000);
    expect(res.months).toBe(4); // Apr, May, Jun + part of Jul
    expect(r(res.interest)).toBe(800); // 20,000 × 1% × 4
  });

  it("waives 234B at or above 90%", () => {
    const res = computeInterest234B({ assessedTax: INR(100000), advanceTaxPaid: INR(90000), fy: "2024-25", determinationDate: "2025-07-20" });
    expect(res.thresholdMet).toBe(true);
    expect(res.interest).toBe(0);
  });
});

describe("corporate tax", () => {
  it("computes 115BAA at an effective 25.168%", () => {
    const res = computeCorporateTax({ totalIncome: INR(10000000), regime: CORPORATE_REGIMES["115BAA"]! });
    // 22% = 22,00,000; surcharge 10% = 2,20,000; cess 4% of 24,20,000 = 96,800.
    expect(r(res.baseTax)).toBe(2200000);
    expect(r(res.surcharge)).toBe(220000);
    expect(r(res.cess)).toBe(96800);
    expect(r(res.totalTax)).toBe(2516800);
    expect(res.effectiveRatePct).toBeCloseTo(25.168, 3);
  });

  it("picks MAT when book profit makes it higher", () => {
    // Total income ₹1Cr at 30% → 30,00,000 + 7% surcharge + cess.
    // Book profit ₹2Cr at 15% MAT → 30,00,000 + 7% surcharge + cess (higher).
    const res = computeCorporateTax({ totalIncome: INR(10000000), bookProfit: INR(20000000), regime: CORPORATE_REGIMES.normal! });
    expect(res.applicable).toBe("mat");
    expect(r(res.matTax!)).toBeGreaterThan(r(res.normalTax));
  });

  it("does not invent book profit when it is not supplied", () => {
    const res = computeCorporateTax({ totalIncome: INR(10000000), regime: CORPORATE_REGIMES.normal! });
    expect(res.matTax).toBeNull();
    expect(res.applicable).toBe("normal");
  });
});

describe("listed-equity capital gains", () => {
  it("applies 20% STCG and 12.5% LTCG over the ₹1.25L exemption", () => {
    const res = computeEquityCapitalGains({ stcg: INR(100000), ltcg: INR(500000) });
    expect(r(res.stcgTax)).toBe(20000); // 20%
    expect(r(res.ltcgExemptionApplied)).toBe(125000);
    expect(r(res.ltcgTaxable)).toBe(375000);
    expect(r(res.ltcgTax)).toBe(46875); // 12.5%
    expect(r(res.cess)).toBe(2675); // 4% of 66,875
    expect(r(res.totalTax)).toBe(69550);
  });
});
