/**
 * Professional-tax late-fee oracles. Hand-computed against the rates in the
 * registry; every figure is in paise.
 */

import { computePtLateFee, ptLateRuleFor } from "@/lib/engine/pt-late-fee";

const RULE_MH = ptLateRuleFor("Maharashtra")!;
const RULE_KA = ptLateRuleFor("29")!;
const RULE_GJ = ptLateRuleFor("Gujarat")!;
const RULE_WB = ptLateRuleFor("28")!;

describe("ptLateRuleFor", () => {
  it("resolves by state code and by name", () => {
    expect(ptLateRuleFor("14")?.stateName).toBe("Maharashtra");
    expect(ptLateRuleFor("maharashtra")?.stateCode).toBe("14");
    expect(ptLateRuleFor("Karnataka")?.monthlyInterestBps).toBe(150);
  });

  it("refuses an unknown state or a date before the rule", () => {
    expect(ptLateRuleFor("Delhi")).toBeNull();
    expect(ptLateRuleFor("14", "2017-04-30")).toBeNull();
    expect(ptLateRuleFor("14", "2017-05-01")).not.toBeNull();
  });

  it("marks Tamil Nadu as conflicting instead of quoting one source", () => {
    const rule = ptLateRuleFor("23");
    expect(rule?.status).toBe("conflicting");
    expect(rule?.monthlyInterestBps).toBeNull();
  });
});

describe("computePtLateFee", () => {
  it("applies Maharashtra's graded rates for the first three months", () => {
    // ₹2,500 tax: month 1 1.25% = ₹31.25; month 2 1.5% = ₹37.50; month 3 1.5% = ₹37.50.
    const result = computePtLateFee(RULE_MH, 2_500_00, 3)!;
    expect(result.monthlyBpsApplied).toEqual([125, 150, 150]);
    expect(result.interestMinor).toBe(3_125 + 3_750 + 3_750);
    // Plus the fixed 10% statutory penalty.
    expect(result.penaltyMinor).toBe(25_000);
    expect(result.totalMinor).toBe(3_125 + 3_750 + 3_750 + 25_000);
  });

  it("charges 2% a month from the fourth month in Maharashtra", () => {
    const result = computePtLateFee(RULE_MH, 2_500_00, 4)!;
    expect(result.monthlyBpsApplied).toEqual([125, 150, 150, 200]);
    expect(result.interestMinor).toBe(3_125 + 3_750 + 3_750 + 5_000);
  });

  it("charges Karnataka 1.5% a month plus the 10% penalty", () => {
    const result = computePtLateFee(RULE_KA, 2_500_00, 2)!;
    expect(result.interestMinor).toBe(7_500); // 2 × 1.5% of ₹2,500
    expect(result.penaltyMinor).toBe(25_000);
    expect(result.totalMinor).toBe(32_500);
  });

  it("treats Gujarat's 18% a year as 1.5% a month", () => {
    const result = computePtLateFee(RULE_GJ, 2_500_00, 12)!;
    expect(result.interestMinor).toBe(45_000);
    expect(result.penaltyMinor).toBeNull();
  });

  it("does not invent West Bengal's discretionary penalty", () => {
    const result = computePtLateFee(RULE_WB, 2_500_00, 3)!;
    expect(result.interestMinor).toBe(7_500); // 3 × 1%
    expect(result.penaltyMinor).toBeNull();
    expect(result.totalMinor).toBe(7_500);
  });

  it("returns null when the state is not priced or the tax is missing", () => {
    expect(computePtLateFee(ptLateRuleFor("23")!, 2_500_00, 3)).toBeNull();
    expect(computePtLateFee(RULE_MH, 0, 3)).toBeNull();
    expect(computePtLateFee(RULE_MH, 2_500_00, 0)).toBeNull();
  });
});
