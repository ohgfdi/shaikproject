/**
 * Transfer-pricing engine — oracle tests.
 *
 * Every expected number below is hand-computed. The properties pinned:
 *
 *  1. The Rule 10B band is INCLUSIVE at both ends (a price exactly at the
 *     band edge is not adjusted).
 *  2. Outside the band the adjustment runs to the ARITHMETIC MEAN, not to the
 *     band edge — that is the S.92C(1) as-amended computation.
 *  3. S.94B: disallowance = interest − max(30% EBITDA, ₹1 crore), and the
 *     ₹1 crore de-minimis protects small interest entirely.
 */

import {
  arithmeticMean,
  applyArmLengthTest,
  armLengthRange,
  form3cebSummary,
  methodPriceTest,
  methodTnmm,
  multipleYearWeightedMean,
  profitSplit,
  thinCapitalisation94B,
  tolerancePctFor,
} from "@/lib/engine/ca-transfer-pricing";

describe("Rule 10B tolerance bands", () => {
  it("surfaces the labelled bands: 1% wholesale, 5% retail, 3% other", () => {
    expect(tolerancePctFor("wholesale-trading")).toBe(1);
    expect(tolerancePctFor("retail-trading")).toBe(5);
    expect(tolerancePctFor("other")).toBe(3);
  });

  it("computes the band symmetric around the arithmetic mean", () => {
    // comparables 100, 102, 104 → mean 102; ±3% → 102 ± 3.06 → ±3 (paise-rounded)
    const range = armLengthRange([100_00, 102_00, 104_00], 3);
    expect(range.arithmeticMean).toBe(102_00);
    expect(range.lower).toBe(102_00 - Math.round((102_00 * 3) / 100));
    expect(range.upper).toBe(102_00 + Math.round((102_00 * 3) / 100));
  });
});

describe("S.92C arm's length test", () => {
  const comparables = [100_00, 102_00, 104_00]; // mean 10,200 paise

  it("is inclusive at the band edges — no adjustment at exactly the edge", () => {
    const range = armLengthRange(comparables, 3);
    const res = applyArmLengthTest(range.upper, comparables, 3);
    expect(res.verdict).toBe("within-band");
    expect(res.adjustment).toBe(0);
    // And the within-band arm's length figure is the ACTUAL price itself.
    expect(res.armLengthFigure).toBe(range.upper);
  });

  it("adjusts down to the arithmetic mean, not the band edge", () => {
    // actual 11,000 > mean 10,200 → adjusted down by 800
    const res = applyArmLengthTest(11_000, comparables, 3);
    expect(res.verdict).toBe("adjusted-down");
    expect(res.armLengthFigure).toBe(10_200);
    expect(res.adjustment).toBe(800);
  });

  it("adjusts up when the actual price is below the mean", () => {
    const res = applyArmLengthTest(9_000, comparables, 3);
    expect(res.verdict).toBe("adjusted-up");
    expect(res.armLengthFigure).toBe(10_200);
    expect(res.adjustment).toBe(1_200);
  });

  it("keeps the method label on price-method results", () => {
    const res = methodPriceTest("CUP", 11_000, comparables, 3);
    expect(res.method).toBe("CUP");
    expect(res.testedFigure).toBe("price");
    expect(res.adjustment).toBe(800);
  });
});

describe("TNMM operating-margin test", () => {
  it("tests the OM against comparable OMs with the same band logic", () => {
    // tested OM 8%, comparables mean 10% ± 3% → band [9.7, 10.3] → adjusted up
    const res = methodTnmm(8, [10, 10.5, 9.5], 3);
    expect(res.method).toBe("TNMM");
    expect(res.testedFigure).toBe("operating margin (%)");
    expect(res.omResult.verdict).toBe("adjusted-up");
    // mean of [10, 10.5, 9.5] = 10
    expect(res.omResult.armLengthFigure).toBe(10);
  });

  it("is silent when the OM sits inside the band", () => {
    const res = methodTnmm(10.2, [10, 10.5, 9.5], 3);
    expect(res.omResult.verdict).toBe("within-band");
    expect(res.omResult.adjustment).toBe(0);
  });
});

describe("Profit split (Rule 10B(f))", () => {
  it("splits by relative contribution weights", () => {
    // 100,000 paise, weights 2:1 → 66,667 + 33,333 = 100,000
    const res = profitSplit(100_000, [2, 1]);
    expect(res.splits[0]).toBe(66_667);
    expect(res.splits[1]).toBe(33_333);
    expect(res.totalCheck).toBe(100_000);
  });

  it("re-sums exactly to the combined profit after rounding", () => {
    // weights 1:1:1 over 100 → 33+33+34-style drift repair
    const res = profitSplit(100, [1, 1, 1]);
    expect(res.totalCheck).toBe(100);
  });
});

describe("Multiple-year data (Rule 10B(4))", () => {
  it("weights years 3-2-1 by default (oldest lightest)", () => {
    // values [10, 20, 30] with weights [1, 2, 3] → (10 + 40 + 90)/6 = 23.33 → 23
    const res = multipleYearWeightedMean([10, 20, 30]);
    expect(res.weightsUsed).toEqual([1, 2, 3]);
    expect(res.weightedMean).toBe(Math.round(140 / 6));
  });

  it("honours explicit weights", () => {
    const res = multipleYearWeightedMean([10, 20], [1, 1]);
    expect(res.weightedMean).toBe(15);
  });
});

describe("S.94B thin capitalisation", () => {
  it("disallows interest above max(30% EBITDA, ₹1 crore)", () => {
    // interest ₹20 crore, EBITDA ₹40 crore → 30% = 12 crore → disallow 8 crore
    const res = thinCapitalisation94B(20_00_00_000 * 100, 40_00_00_000 * 100);
    expect(res.thirtyPctEbitda).toBe(12_00_00_000 * 100);
    expect(res.disallowance).toBe(8_00_00_000 * 100);
    expect(res.carryForward).toBe(8_00_00_000 * 100);
  });

  it("leaves interest entirely untouched at or below ₹1 crore", () => {
    const res = thinCapitalisation94B(1_00_00_000, 0);
    expect(res.excessInterest).toBe(0);
    expect(res.disallowance).toBe(0);
  });

  it("uses the ₹1 crore floor when 30% EBITDA is smaller", () => {
    // interest ₹5 crore, EBITDA ₹1 crore → 30% = 30 lakh < 1 crore → cap is 1 crore → disallow 4 crore
    const res = thinCapitalisation94B(5_00_00_000 * 100, 1_00_00_000 * 100);
    expect(res.disallowance).toBe(4_00_00_000 * 100);
  });
});

describe("Form 3CEB aggregation", () => {
  const txns = [
    {
      description: "Sale of goods to AE",
      type: "international" as const,
      method: "CUP" as const,
      valueMinor: 500_00_000,
      adjustmentMinor: 10_000,
    },
    {
      description: "Royalty to AE",
      type: "international" as const,
      method: "CUP" as const,
      valueMinor: 300_00_000,
      adjustmentMinor: 0,
    },
    {
      description: "Management fees",
      type: "international" as const,
      method: "TNMM" as const,
      valueMinor: 200_00_000,
      adjustmentMinor: 5_000,
    },
    {
      description: "Payment > ₹20k to director relative",
      type: "sdt" as const,
      method: "CUP" as const,
      valueMinor: 50_000,
      adjustmentMinor: 0,
    },
  ];

  it("aggregates international vs SDT values separately", () => {
    const res = form3cebSummary(txns);
    expect(res.internationalValue).toBe(1_000_00_000);
    expect(res.sdtValue).toBe(50_000);
    expect(res.totalValue).toBe(1_000_50_000);
    expect(res.totalAdjustment).toBe(15_000);
  });

  it("counts per method and names the highest-valued transaction per method", () => {
    const res = form3cebSummary(txns);
    const cup = res.byMethod.find((m) => m.method === "CUP")!;
    expect(cup.count).toBe(3);
    expect(cup.value).toBe(800_50_000);
    const highestCup = res.highestByMethod.find((m) => m.method === "CUP")!;
    expect(highestCup.description).toBe("Sale of goods to AE");
    expect(highestCup.value).toBe(500_00_000);
  });
});

describe("mean helper", () => {
  it("rounds to the nearest paise", () => {
    // [1, 2] → 1.5 → rounds to 2 (Math.round half-up)
    expect(arithmeticMean([100, 200])).toBe(150);
    expect(arithmeticMean([101, 102])).toBe(102);
  });
});
