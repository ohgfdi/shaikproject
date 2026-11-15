/**
 * Indian direct-tax engine — oracle tests.
 *
 * Every expected figure is derived by hand from the Finance Act 2025 tables
 * (FY 2025-26): the 4/8/12/16/20/24 lakh slabs, the ₹60,000 s.87A rebate up to
 * ₹12L with marginal relief, surcharge at 10%/15%/25% of ₹50L/₹1Cr/₹2Cr with
 * marginal relief, and 4% cess. The FY 2024-25 tables (3/7/10/12/15, ₹25,000
 * rebate at ₹7L) are pinned too, so prior-year work cannot silently use the new
 * year's rates.
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
  getIndividualRegime,
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
    // FY 2025-26 new regime: 0–4L nil, 4–8L 5%, 8–12L 10%.
    // ₹10L → 4L @ 5% = 20,000 + 2L @ 10% = 20,000.
    expect(slabTax(INR(1000000), INDIVIDUAL_REGIMES.new!.slabs)).toBe(INR(40000));
  });

  it("uses the FY 2024-25 table when that year is asked for", () => {
    // 3L nil, 3–7L @5% = 20,000, 7–10L @10% = 30,000.
    const fy24 = getIndividualRegime("new", "2024-25");
    expect(slabTax(INR(1000000), fy24.slabs)).toBe(INR(50000));
    expect(fy24.rebate!.threshold).toBe(INR(700000));
    expect(fy24.rebate!.maxRebate).toBe(INR(25000));
  });
});

describe("individual income tax — new regime (FY 2025-26)", () => {
  it("zeroes out a ₹10L salary through the ₹60,000 / ₹12L rebate", () => {
    // Gross 10L − 75K standard deduction = taxable 9.25L.
    // Slab: 4–8L @5% = 20,000; 8–9.25L @10% = 12,500 → 32,500.
    // 87A: taxable ≤ ₹12L → rebate min(32,500, 60,000) = 32,500 → tax nil.
    const res = computeIncomeTax({ grossIncome: INR(1000000), regime: INDIVIDUAL_REGIMES.new! });
    expect(r(res.taxableIncome)).toBe(925000);
    expect(r(res.slabTax)).toBe(32500);
    expect(r(res.rebate)).toBe(32500);
    expect(res.surcharge).toBe(0);
    expect(res.totalTax).toBe(0);
  });

  it("zeroes out a ₹12.75L salary (taxable exactly ₹12L)", () => {
    // Taxable 12L: 20,000 + 40,000 = 60,000; rebate min(60,000, 60,000) = 60,000.
    const res = computeIncomeTax({ grossIncome: INR(1275000), regime: INDIVIDUAL_REGIMES.new! });
    expect(r(res.taxableIncome)).toBe(1200000);
    expect(r(res.slabTax)).toBe(60000);
    expect(r(res.rebate)).toBe(60000);
    expect(res.totalTax).toBe(0);
  });

  it("grants marginal relief just above ₹12L (no cliff)", () => {
    // Taxable 12.25L: slab 60,000 + 25,000 @15% (3,750) = 63,750.
    // Tax may not exceed income above ₹12L = 25,000; relief 38,750.
    const res = computeIncomeTax({ grossIncome: INR(1300000), regime: INDIVIDUAL_REGIMES.new! });
    expect(r(res.taxableIncome)).toBe(1225000);
    expect(r(res.slabTax)).toBe(63750);
    expect(res.rebate).toBe(0);
    expect(r(res.rebateMarginalRelief)).toBe(38750);
    expect(r(res.taxAfterRebate)).toBe(25000);
    expect(r(res.cess)).toBe(1000); // 4% of 25,000
    expect(r(res.totalTax)).toBe(26000);
  });

  it("applies the 10% surcharge above ₹50L with marginal relief", () => {
    // Gross 51.1L − 75K = taxable 50.35L.
    // Slab: 20,000+40,000+60,000+80,000+100,000 (up to 24L) = 3,00,000
    //        + 26.35L @ 30% = 7,90,500 → 10,90,500.
    // 10% = 1,09,050 raw; cap = tax at 50L (10,80,000, no surcharge) + 35,000
    // = 11,15,000 → surcharge capped at 24,500; relief 84,550.
    const res = computeIncomeTax({ grossIncome: INR(5110000), regime: INDIVIDUAL_REGIMES.new! });
    expect(r(res.taxableIncome)).toBe(5035000);
    expect(r(res.slabTax)).toBe(1090500);
    expect(res.surchargeBandPct).toBe(10);
    expect(r(res.surcharge)).toBe(24500);
    expect(r(res.surchargeMarginalRelief)).toBe(84550);
    expect(r(res.cess)).toBe(44600); // 4% of 11,15,000
    expect(r(res.totalTax)).toBe(1159600);
  });

  it("applies the 15% surcharge band above ₹1Cr", () => {
    // Gross 1.1Cr − 75K = taxable 1,09,25,000.
    // Slab: 3,00,000 + 85.25L @30% = 25,57,500 → 28,57,500.
    // 15% surcharge = 4,28,625 (below the marginal-relief cap). Cess 4% of
    // 32,86,125 = 1,31,445.
    const res = computeIncomeTax({ grossIncome: INR(11000000), regime: INDIVIDUAL_REGIMES.new! });
    expect(r(res.taxableIncome)).toBe(10925000);
    expect(r(res.slabTax)).toBe(2857500);
    expect(res.surchargeBandPct).toBe(15);
    expect(r(res.surcharge)).toBe(428625);
    expect(r(res.cess)).toBe(131445);
    expect(r(res.totalTax)).toBe(3417570);
  });

  it("does not set the 87A rebate against special-rate capital gains", () => {
    // Taxable 9.25L, of which 1L is 112A LTCG taxed at 12,500.
    // Normal slice 8.25L → 20,000 + 2,500 = 22,500. Rebate only against that.
    const res = computeIncomeTax({
      grossIncome: INR(1000000),
      regime: INDIVIDUAL_REGIMES.new!,
      specialRateIncome: INR(100000),
      specialRateTax: INR(12500),
    });
    expect(r(res.normalIncome)).toBe(825000);
    expect(r(res.slabTax)).toBe(35000); // 22,500 normal + 12,500 special
    expect(r(res.rebate)).toBe(22500);
    expect(r(res.taxAfterRebate)).toBe(12500);
    expect(r(res.totalTax)).toBe(13000); // + 4% cess
  });

  it("denies the rebate to a non-resident", () => {
    const res = computeIncomeTax({
      grossIncome: INR(1000000),
      regime: INDIVIDUAL_REGIMES.new!,
      residentIndividual: false,
    });
    expect(res.rebate).toBe(0);
    expect(r(res.totalTax)).toBe(33800); // 32,500 + 4%
  });
});

describe("individual income tax — old regime", () => {
  it("computes tax with 4% cess", () => {
    // Gross 10L − 50K = taxable 9.5L: 12,500 + 90,000 = 1,02,500.
    const res = computeIncomeTax({ grossIncome: INR(1000000), regime: INDIVIDUAL_REGIMES.old! });
    expect(r(res.taxableIncome)).toBe(950000);
    expect(r(res.slabTax)).toBe(102500);
    expect(res.rebate).toBe(0);
    expect(r(res.cess)).toBe(4100);
    expect(r(res.totalTax)).toBe(106600);
  });

  it("rebates up to ₹5L", () => {
    const res = computeIncomeTax({ grossIncome: INR(500000), regime: INDIVIDUAL_REGIMES.old! });
    expect(r(res.taxableIncome)).toBe(450000);
    expect(r(res.slabTax)).toBe(10000);
    expect(r(res.rebate)).toBe(10000);
    expect(res.totalTax).toBe(0);
  });

  it("caps each Chapter VI-A section by statute", () => {
    // 80C 2L→1.5L; 80D 40K→25K; 80TTA 15K→10K; 80E 80K and 80G 50K uncapped.
    // Allowed 3,15,000. Taxable 15L − 50K − 3,15,000 = 11,35,000.
    const res = computeIncomeTax({
      grossIncome: INR(1500000),
      regime: INDIVIDUAL_REGIMES.old!,
      deductionBreakup: {
        section80C: INR(200000),
        section80D: INR(40000),
        section80TTA: INR(15000),
        section80E: INR(80000),
        section80G: INR(50000),
      },
    });
    expect(r(res.deductions)).toBe(315000);
    expect(r(res.taxableIncome)).toBe(1135000);
    const lines = Object.fromEntries(res.deductionLines.map((l) => [l.section, l.allowed / 100]));
    expect(lines["80C"]).toBe(150000);
    expect(lines["80D"]).toBe(25000);
    expect(lines["80TTA"]).toBe(10000);
    expect(lines["80E"]).toBe(80000);
    expect(lines["80G"]).toBe(50000);
    // 12,500 + 1,00,000 + 1.35L @30% (40,500) = 1,53,000; cess 6,120.
    expect(r(res.slabTax)).toBe(153000);
    expect(r(res.totalTax)).toBe(159120);
  });

  it("allows 80TTB (and a ₹50,000 80D cap) for a senior citizen instead of 80TTA", () => {
    const res = computeIncomeTax({
      grossIncome: INR(1200000),
      regime: INDIVIDUAL_REGIMES.old!,
      seniorCitizen: true,
      deductionBreakup: { section80D: INR(60000), section80TTA: INR(10000), section80TTB: INR(60000) },
    });
    expect(r(res.deductions)).toBe(50000 + 0 + 50000);
  });

  it("drops every Chapter VI-A claim except 80CCD(2) in the new regime", () => {
    const res = computeIncomeTax({
      grossIncome: INR(2000000),
      regime: INDIVIDUAL_REGIMES.new!,
      deductionBreakup: { section80C: INR(150000), section80D: INR(25000), section80CCD2: INR(60000) },
    });
    expect(r(res.deductions)).toBe(60000);
    expect(res.deductionLines).toHaveLength(1);
    expect(res.deductionLines[0]!.section).toBe("80CCD(2)");
  });

  it("honours applyStandardDeduction: false and never exceeds gross income", () => {
    const noStd = computeIncomeTax({
      grossIncome: INR(1000000),
      regime: INDIVIDUAL_REGIMES.new!,
      applyStandardDeduction: false,
    });
    expect(noStd.standardDeduction).toBe(0);
    expect(r(noStd.taxableIncome)).toBe(1000000);
    const tiny = computeIncomeTax({ grossIncome: INR(30000), regime: INDIVIDUAL_REGIMES.new! });
    expect(tiny.standardDeduction).toBe(INR(30000));
    expect(tiny.taxableIncome).toBe(0);
  });
});

describe("HRA exemption", () => {
  it("takes the least of the three amounts (metro)", () => {
    const res = computeHraExemption({
      salary: INR(600000),
      hraReceived: INR(240000),
      rentPaid: INR(300000),
      metro: true,
    });
    expect(r(res.exempt)).toBe(240000);
    expect(r(res.taxableHra)).toBe(0);
  });

  it("uses 40% for non-metro", () => {
    const res = computeHraExemption({
      salary: INR(600000),
      hraReceived: INR(300000),
      rentPaid: INR(300000),
      metro: false,
    });
    expect(r(res.components.basicShare)).toBe(240000);
    expect(r(res.exempt)).toBe(240000);
  });
});

describe("advance tax", () => {
  it("builds the statutory instalment schedule", () => {
    const inst = advanceTaxInstallments("2024-25");
    expect(inst.map((i) => i.cumulativePct)).toEqual([15, 45, 75, 100]);
    expect(inst[0]!.dueDate).toBe("2024-06-15");
    expect(inst[3]!.dueDate).toBe("2025-03-15");
  });

  it("computes 234C on cumulative shortfalls with the 12%/36% proviso", () => {
    // Assessed ₹1L. Only ₹10,000 paid by June (10% < 12%): Q1 short 5,000 →
    // 5,000 × 1% × 3 = 150. Q2 required 45,000, paid 10,000 → 35,000 × 3% =
    // 1,050. Q3 required 75,000 → 65,000 × 3% = 1,950. Q4 paid in full → 0.
    const res = computeInterest234C({
      assessedTax: INR(100000),
      fy: "2024-25",
      payments: [
        { date: "2024-06-10", amount: INR(10000) },
        { date: "2025-03-10", amount: INR(90000) },
      ],
    });
    expect(r(res.perInstallment[0]!.interest)).toBe(150);
    expect(r(res.perInstallment[1]!.interest)).toBe(1050);
    expect(r(res.perInstallment[2]!.interest)).toBe(1950);
    expect(r(res.perInstallment[3]!.interest)).toBe(0);
    expect(r(res.totalInterest)).toBe(3150);
  });

  it("relieves the first two instalments at 12% / 36% paid", () => {
    // 12,000 by June and 36,000 cumulative by September satisfy the proviso
    // even though the statutory instalments are 15,000 / 45,000.
    const res = computeInterest234C({
      assessedTax: INR(100000),
      fy: "2024-25",
      payments: [
        { date: "2024-06-10", amount: INR(12000) },
        { date: "2024-09-10", amount: INR(24000) },
        { date: "2024-12-10", amount: INR(39000) },
        { date: "2025-03-10", amount: INR(25000) },
      ],
    });
    expect(res.perInstallment[0]!.provisoRelief).toBe(true);
    expect(res.perInstallment[1]!.provisoRelief).toBe(true);
    expect(res.perInstallment[2]!.shortfall).toBe(0); // 75,000 paid by December
    expect(res.perInstallment.every((p) => p.interest === 0)).toBe(true);
    expect(res.totalInterest).toBe(0);
  });

  it("never charges 234C below ₹10,000 of assessed tax", () => {
    const res = computeInterest234C({
      assessedTax: INR(9000),
      fy: "2024-25",
      payments: [{ date: "2024-06-10", amount: INR(1) }],
    });
    expect(res.belowThreshold).toBe(true);
    expect(res.totalInterest).toBe(0);
  });

  it("charges 234B only below the 90% threshold", () => {
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
    const res = computeInterest234B({
      assessedTax: INR(100000),
      advanceTaxPaid: INR(90000),
      fy: "2024-25",
      determinationDate: "2025-07-20",
    });
    expect(res.thresholdMet).toBe(true);
    expect(res.interest).toBe(0);
  });
});

describe("corporate tax", () => {
  it("computes 115BAA at an effective 25.168%", () => {
    const res = computeCorporateTax({ totalIncome: INR(10000000), regime: CORPORATE_REGIMES["115BAA"]! });
    expect(r(res.baseTax)).toBe(2200000);
    expect(r(res.surcharge)).toBe(220000);
    expect(r(res.cess)).toBe(96800);
    expect(r(res.totalTax)).toBe(2516800);
    expect(res.effectiveRatePct).toBeCloseTo(25.168, 3);
  });

  it("computes 115BAB at an effective 17.16%", () => {
    const res = computeCorporateTax({ totalIncome: INR(10000000), regime: CORPORATE_REGIMES["115BAB"]! });
    expect(r(res.baseTax)).toBe(1500000);
    expect(r(res.surcharge)).toBe(150000);
    expect(r(res.cess)).toBe(66000);
    expect(r(res.totalTax)).toBe(1716000);
    expect(res.effectiveRatePct).toBeCloseTo(17.16, 2);
  });

  it("applies the 25% rate when turnover is within ₹400 crore", () => {
    const res = computeCorporateTax({
      totalIncome: INR(10000000),
      regime: CORPORATE_REGIMES.normal!,
      turnover: INR(1000000000), // ₹100 crore
    });
    expect(res.appliedRatePct).toBe(25);
    expect(r(res.baseTax)).toBe(2500000);
    // ₹1Cr is not ABOVE ₹1Cr, so no 7% surcharge; cess 4% of 25L = 1L.
    expect(r(res.surcharge)).toBe(0);
    expect(r(res.totalTax)).toBe(2600000);
  });

  it("gives marginal relief at the ₹1 crore surcharge threshold", () => {
    const res = computeCorporateTax({
      totalIncome: INR(10100000), // ₹1.01Cr
      regime: CORPORATE_REGIMES.normal!,
      turnover: INR(1000000000),
    });
    // 25% = 25,25,000; 7% raw = 1,76,750; cap = 25,00,000 + 1,00,000.
    expect(r(res.baseTax)).toBe(2525000);
    expect(r(res.surcharge)).toBe(75000);
    expect(r(res.marginalRelief)).toBe(101750);
    expect(r(res.totalTax)).toBe(2704000); // 26,00,000 + 4% cess
  });

  it("picks MAT when book profit makes it higher", () => {
    const res = computeCorporateTax({
      totalIncome: INR(10000000),
      bookProfit: INR(20000000),
      regime: CORPORATE_REGIMES.normal!,
    });
    expect(res.applicable).toBe("mat");
    // Normal 30L + 4% = 31.2L; MAT 15% of 2Cr = 30L + 7% + 4% = 33,38,400.
    expect(r(res.normalTax)).toBe(3120000);
    expect(r(res.matTax!)).toBe(3338400);
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
    expect(r(res.stcgTax)).toBe(20000);
    expect(r(res.ltcgExemptionApplied)).toBe(125000);
    expect(r(res.ltcgTaxable)).toBe(375000);
    expect(r(res.ltcgTax)).toBe(46875);
    expect(r(res.cess)).toBe(2675); // 4% of 66,875
    expect(r(res.totalTax)).toBe(69550);
  });

  it("caps the surcharge on 111A/112A tax at 15%", () => {
    const res = computeEquityCapitalGains({ stcg: INR(1000000), surchargePct: 37 });
    expect(r(res.stcgTax)).toBe(200000);
    expect(r(res.surcharge)).toBe(30000); // 15% of 2,00,000, not 37%
    expect(r(res.cess)).toBe(9200); // 4% of 2,30,000
    expect(r(res.totalTax)).toBe(239200);
  });
});
