/**
 * TDS Penalty Exposure & Interest Computation Engine — oracle tests.
 *
 * Hand-computed values for 201(1A), 234E, and 271(1)(c) exposure.
 */

import {
  computeTdsExposure,
  monthsOrPartBetween,
  depositDueDate,
  returnFilingDueDate,
  TdsExposureEvent,
  TdsExposureParams,
} from "@/lib/engine/tds-penalty-exposure";

/** Helper: create an exposure event. */
function exposureEvent(
  over: Partial<TdsExposureEvent> & Pick<TdsExposureEvent, "id" | "section" | "payeeName">,
): TdsExposureEvent {
  return {
    id: over.id || `evt-${Math.random().toString(36).slice(2)}`,
    section: over.section,
    payeeName: over.payeeName,
    payeePan: over.payeePan ?? null,
    baseAmount: over.baseAmount ?? 1_00_00_00,
    ratePct: over.ratePct ?? 10,
    taxShouldBe: over.taxShouldBe ?? 10_00_00,
    taxActual: over.taxActual ?? 10_00_00,
    deductibleDate: over.deductibleDate ?? "2025-04-15",
    deductedDate: over.deductedDate ?? null,
    depositedDate: over.depositedDate ?? null,
    returnFiled: over.returnFiled ?? false,
    returnFiledDate: over.returnFiledDate ?? null,
    natureOfPayment: over.natureOfPayment ?? null,
    isTcs: over.isTcs ?? false,
  };
}

describe("monthsOrPartBetween", () => {
  it("counts part months as full for 201(1A)", () => {
    expect(monthsOrPartBetween("2025-04-15", "2025-05-10")).toBe(1); // Apr part + May part = 1
    expect(monthsOrPartBetween("2025-04-15", "2025-04-20")).toBe(1); // Same month, different days = 1
    expect(monthsOrPartBetween("2025-04-15", "2025-04-15")).toBe(0); // Same day = 0
    expect(monthsOrPartBetween("2025-04-15", "2025-03-01")).toBe(0); // to < from
  });

  it("counts full months correctly", () => {
    expect(monthsOrPartBetween("2025-04-01", "2025-05-01")).toBe(1);
    expect(monthsOrPartBetween("2025-04-01", "2025-06-01")).toBe(2);
    expect(monthsOrPartBetween("2025-04-01", "2026-04-01")).toBe(12);
  });
});

describe("depositDueDate", () => {
  it("returns 7th of following month for non-March deductions", () => {
    expect(depositDueDate("2025-04-15")).toBe("2025-05-07");
    expect(depositDueDate("2025-06-15")).toBe("2025-07-07");
    expect(depositDueDate("2025-12-15")).toBe("2026-01-07");
  });

  it("returns 30 April for March deductions", () => {
    expect(depositDueDate("2025-03-15")).toBe("2025-04-30");
    expect(depositDueDate("2025-03-01")).toBe("2025-04-30");
  });
});

describe("returnFilingDueDate", () => {
  it("returns correct due dates for each quarter", () => {
    expect(returnFilingDueDate("Q1", "2025-26")).toBe("2025-07-31");
    expect(returnFilingDueDate("Q2", "2025-26")).toBe("2025-10-31");
    expect(returnFilingDueDate("Q3", "2025-26")).toBe("2026-01-31");
    expect(returnFilingDueDate("Q4", "2025-26")).toBe("2026-05-31");
  });
});

describe("computeTdsExposure — late deduction 201(1A)(i)", () => {
  it("computes 1% per month interest on late deduction", () => {
    const events = [
      exposureEvent({
        id: "e1",
        section: "194C",
        payeeName: "Acme Contractors",
        payeePan: "AAPFU0939F",
        baseAmount: 5_00_00_00,
        ratePct: 2,
        taxShouldBe: 10_00_00, // 2% of 5,00,000
        taxActual: 10_00_00,
        deductibleDate: "2025-04-15",
        deductedDate: "2025-05-20", // 1 part-month late
        depositedDate: "2025-06-10",
      }),
    ];

    const params: TdsExposureParams = {
      tan: "MUMA12345B",
      assessmentYear: "2026-27",
      financialYear: "2025-26",
      deductorName: "Acme Ltd",
      deductorEntityType: "company",
      isGovernmentDeductor: false,
      returnFilingDueDate: "2025-07-31",
      computeMaxPenalty271c: false,
    };

    const result = computeTdsExposure(events, params);
    const lateDeductionInterest = result.exposures.find((e) => e.reason === "late-deduction");

    expect(lateDeductionInterest).toBeTruthy();
    expect(lateDeductionInterest!.amount).toBe(10_00); // 1,00,000 paise × 1% × 1 month = 1,000 paise
    expect(lateDeductionInterest!.months).toBe(1);
    expect(result.totalInterest).toBe(10_00);
  });

  it("computes 1.5% per month interest on late deposit (201(1A)(ii))", () => {
    const events = [
      exposureEvent({
        id: "e2",
        section: "194J",
        payeeName: "Bharat Consultants",
        payeePan: "BBBFU0939F",
        baseAmount: 1_00_00_00,
        ratePct: 10,
        taxShouldBe: 10_00_00,
        taxActual: 10_00_00,
        deductibleDate: "2025-04-15",
        deductedDate: "2025-04-15",
        depositedDate: "2025-06-01", // Due 7 May, paid 1 Jun → 1 part-month late
      }),
    ];

    const params: TdsExposureParams = {
      tan: "MUMA12345B",
      assessmentYear: "2026-27",
      financialYear: "2025-26",
      deductorName: "Acme Ltd",
      deductorEntityType: "company",
      isGovernmentDeductor: false,
      returnFilingDueDate: "2025-07-31",
      computeMaxPenalty271c: false,
      lateDepositRatePctPerMonth: 1.5,
    };

    const result = computeTdsExposure(events, params);
    const lateDepositInterest = result.exposures.find((e) => e.reason === "late-deposit");

    expect(lateDepositInterest).toBeTruthy();
    expect(lateDepositInterest!.amount).toBe(15_00); // 1,00,000 paise × 1.5% × 1 month = 1,500 paise
    expect(lateDepositInterest!.months).toBe(1);
  });
});

describe("computeTdsExposure — 234E late filing fee", () => {
  it("computes ₹200/day fee for late filing, capped at TDS amount", () => {
    const events = [
      exposureEvent({
        id: "e3",
        section: "194C",
        payeeName: "Test Payee",
        taxShouldBe: 15_50_00,
        taxActual: 15_50_00,
        deductibleDate: "2025-04-15",
        deductedDate: "2025-04-15",
        depositedDate: "2025-05-10",
      }),
    ];

    const params: TdsExposureParams = {
      tan: "MUMA12345B",
      assessmentYear: "2026-27",
      financialYear: "2025-26",
      deductorName: "Acme Ltd",
      deductorEntityType: "company",
      isGovernmentDeductor: false,
      returnFilingDueDate: "2025-07-31",
      returnFilingDate: "2025-08-05", // 5 days late
      computeMaxPenalty271c: false,
    };

    const result = computeTdsExposure(events, params);
    const lateFilingFee = result.exposures.find((e) => e.reason === "late-filing");

    expect(lateFilingFee).toBeTruthy();
    expect(lateFilingFee!.amount).toBe(1_00_000); // 5 days × ₹200 (20,000 paise) = 1,00,000 paise
    expect(result.totalFees).toBe(1_00_000);
    expect(result.totalExposure).toBe(result.totalInterest + result.totalFees);
  });

  it("caps 234E fee at TDS amount when late by many days", () => {
    const events = [
      exposureEvent({
        id: "e4",
        section: "194C",
        payeeName: "Test Payee",
        taxShouldBe: 15_50_00,
        taxActual: 15_50_00,
        deductibleDate: "2025-04-15",
        deductedDate: "2025-04-15",
        depositedDate: "2025-05-10",
      }),
    ];

    const params: TdsExposureParams = {
      tan: "MUMA12345B",
      assessmentYear: "2026-27",
      financialYear: "2025-26",
      deductorName: "Acme Ltd",
      deductorEntityType: "company",
      isGovernmentDeductor: false,
      returnFilingDueDate: "2025-07-31",
      returnFilingDate: "2026-02-12", // 196 days late
      computeMaxPenalty271c: false,
    };

    const result = computeTdsExposure(events, params);
    const lateFilingFee = result.exposures.find((e) => e.reason === "late-filing");

    expect(lateFilingFee!.capped).toBe(true);
    expect(lateFilingFee!.capValue).toBe(15_50_00); // Cap at TDS amount
    expect(lateFilingFee!.amount).toBe(15_50_00); // Capped
  });
});

describe("computeTdsExposure — non-deduction (201)", () => {
  it("flags exposure when tax was not deducted at all", () => {
    const events = [
      exposureEvent({
        id: "e5",
        section: "194J",
        payeeName: "Non-Deducted Payee",
        baseAmount: 1_00_00_00,
        ratePct: 10,
        taxShouldBe: 10_00_00,
        taxActual: 0, // Not deducted at all
        deductibleDate: "2025-04-15",
        deductedDate: null,
        depositedDate: null,
      }),
    ];

    const params: TdsExposureParams = {
      tan: "MUMA12345B",
      assessmentYear: "2026-27",
      financialYear: "2025-26",
      deductorName: "Acme Ltd",
      deductorEntityType: "company",
      isGovernmentDeductor: false,
      returnFilingDueDate: "2025-07-31",
      computeMaxPenalty271c: true,
      maxPenalty271cPct: 100,
    };

    const result = computeTdsExposure(events, params);
    const nonDeduction = result.exposures.find((e) => e.reason === "non-deduction");

    expect(nonDeduction).toBeTruthy();
    expect(nonDeduction!.shortfall).toBe(10_00_00);
    expect(result.totalMaxPenalty271c).toBe(10_00_00); // 100% of shortfall
    expect(result.grandTotalWithMaxPenalty).toBeGreaterThan(0);
  });
});

describe("computeTdsExposure — short deduction", () => {
  it("flags exposure when tax was short-deducted", () => {
    const events = [
      exposureEvent({
        id: "e6",
        section: "194C",
        payeeName: "Short-Deducted Payee",
        baseAmount: 5_00_00_00,
        ratePct: 2,
        taxShouldBe: 10_00_00,
        taxActual: 5_00_00, // Only 1% deducted instead of 2%
        deductibleDate: "2025-04-15",
        deductedDate: "2025-04-15",
        depositedDate: "2025-05-10",
      }),
    ];

    const params: TdsExposureParams = {
      tan: "MUMA12345B",
      assessmentYear: "2026-27",
      financialYear: "2025-26",
      deductorName: "Acme Ltd",
      deductorEntityType: "company",
      isGovernmentDeductor: false,
      returnFilingDueDate: "2025-07-31",
      computeMaxPenalty271c: false,
    };

    const result = computeTdsExposure(events, params);
    const shortDeduction = result.exposures.find((e) => e.reason === "short-deduction");

    expect(shortDeduction).toBeTruthy();
    expect(shortDeduction!.shortfall).toBe(5_00_00); // 10,000 - 5,000 = 5,000
    expect(result.totalMaxPenalty271c).toBe(null); // computeMaxPenalty271c is false
  });
});

describe("computeTdsExposure — TCS equivalent", () => {
  it("computes TCS exposure with 206C reason codes", () => {
    const events = [
      exposureEvent({
        id: "e7",
        section: "206C(1H)",
        payeeName: "TCS Buyer",
        baseAmount: 10_00_00_00,
        ratePct: 0.1,
        taxShouldBe: 10_00_00,
        taxActual: 0, // Not collected
        deductibleDate: "2025-04-15",
        deductedDate: null,
        depositedDate: null,
        isTcs: true,
      }),
    ];

    const params: TdsExposureParams = {
      tan: "MUMA12345B",
      assessmentYear: "2026-27",
      financialYear: "2025-26",
      deductorName: "TCS Seller",
      deductorEntityType: "company",
      isGovernmentDeductor: false,
      returnFilingDueDate: "2025-07-31",
      computeMaxPenalty271c: false,
    };

    const result = computeTdsExposure(events, params);
    const nonCollection = result.exposures.find((e) => e.reason === "non-collection");

    expect(nonCollection).toBeTruthy();
    expect(nonCollection!.section).toBe("206C(1H)");
    expect(result.byType["non-collection"].count).toBe(1);
  });
});

describe("computeTdsExposure — summary by section", () => {
  it("aggregates exposure by section correctly", () => {
    const events = [
      exposureEvent({
        id: "e8a",
        section: "194C",
        payeeName: "Payee 1",
        taxShouldBe: 10_00_00,
        taxActual: 10_00_00,
        deductibleDate: "2025-04-15",
        deductedDate: "2025-05-20",
        depositedDate: "2025-06-10",
      }),
      exposureEvent({
        id: "e8b",
        section: "194C",
        payeeName: "Payee 2",
        taxShouldBe: 20_00_00,
        taxActual: 20_00_00,
        deductibleDate: "2025-04-15",
        deductedDate: "2025-05-20",
        depositedDate: "2025-06-10",
      }),
      exposureEvent({
        id: "e8c",
        section: "194J",
        payeeName: "Payee 3",
        taxShouldBe: 15_00_00,
        taxActual: 15_00_00,
        deductibleDate: "2025-04-15",
        deductedDate: "2025-05-20",
        depositedDate: "2025-06-10",
      }),
    ];

    const params: TdsExposureParams = {
      tan: "MUMA12345B",
      assessmentYear: "2026-27",
      financialYear: "2025-26",
      deductorName: "Acme Ltd",
      deductorEntityType: "company",
      isGovernmentDeductor: false,
      returnFilingDueDate: "2025-07-31",
      computeMaxPenalty271c: false,
    };

    const result = computeTdsExposure(events, params);

    expect(result.bySection["194C"]).toBeTruthy();
    expect(result.bySection["194C"]!.eventsCount).toBe(2);
    expect(result.bySection["194C"]!.exposureAmount).toBeGreaterThan(0);

    expect(result.bySection["194J"]).toBeTruthy();
    expect(result.bySection["194J"]!.eventsCount).toBe(1);
  });
});
