/**
 * Late-filing exposure oracles — hand-computed against the rates in the module
 * docstring. Every figure is in paise.
 */

import {
  daysBetween,
  lateFilingExposure,
  monthsOrPartBetween,
  regimeForTaskCode,
} from "@/lib/engine/late-filing-exposure";

describe("regime mapping", () => {
  it("maps only the return codes whose rules are encoded", () => {
    expect(regimeForTaskCode("GSTR-3B")).toBe("gst-return");
    expect(regimeForTaskCode("GSTR-1")).toBe("gst-return");
    expect(regimeForTaskCode("TDS-26Q")).toBe("tds-return");
    expect(regimeForTaskCode("TDS-27Q")).toBe("tds-return");
    expect(regimeForTaskCode("ITR")).toBe("income-tax-return");
    // A deposit is not a return under these schedules.
    expect(regimeForTaskCode("TDS-PAYMENT")).toBe("other");
    expect(regimeForTaskCode("ADVANCE-TAX")).toBe("other");
    // Company-law forms and professional tax have their own, named regimes.
    expect(regimeForTaskCode("AOC-4")).toBe("mca-return");
    expect(regimeForTaskCode("MGT-7")).toBe("mca-return");
    expect(regimeForTaskCode("DIR-3-KYC")).toBe("mca-return");
    expect(regimeForTaskCode("PT-RETURN")).toBe("professional-tax");
  });
});

describe("date arithmetic", () => {
  it("counts whole days", () => {
    expect(daysBetween("2026-10-20", "2026-10-25")).toBe(5);
    expect(daysBetween("2026-10-20", "2026-10-20")).toBe(0);
    expect(daysBetween("2026-10-20", "2026-10-18")).toBe(-2);
    expect(daysBetween("nope", "2026-10-18")).toBeNull();
  });

  it("counts months or part of a month (s.234A convention)", () => {
    expect(monthsOrPartBetween("2026-03-31", "2026-04-01")).toBe(1);
    expect(monthsOrPartBetween("2026-03-31", "2026-04-30")).toBe(1);
    expect(monthsOrPartBetween("2026-03-31", "2026-05-01")).toBe(2);
    expect(monthsOrPartBetween("2026-01-31", "2026-02-28")).toBe(1);
    expect(monthsOrPartBetween("2026-01-01", "2026-01-01")).toBe(0);
  });
});

describe("GST returns", () => {
  it("charges ₹50/day, capped at ₹5,000, and does not invent interest", () => {
    const result = lateFilingExposure({
      regime: "gst-return",
      dueDate: "2026-10-20",
      filedDate: "2026-10-25",
      asOf: "2026-10-25",
    });
    expect(result.daysLate).toBe(5);
    expect(result.feeMinor).toBe(25_000); // 5 × ₹50
    expect(result.interestMinor).toBeNull();
    expect(result.totalMinor).toBe(25_000);
    expect(result.basis).toBe("partial");
  });

  it("caps a nil return at ₹2,000", () => {
    const result = lateFilingExposure({
      regime: "gst-return",
      dueDate: "2026-01-20",
      filedDate: "2026-08-08",
      asOf: "2026-08-08",
      nilReturn: true,
    });
    expect(result.daysLate).toBe(200);
    expect(result.feeMinor).toBe(2_000_00);
    expect(result.basis).toBe("partial");
  });

  it("caps a taxable return at ₹5,000", () => {
    const result = lateFilingExposure({
      regime: "gst-return",
      dueDate: "2026-01-20",
      filedDate: "2026-08-08",
      asOf: "2026-08-08",
    });
    expect(result.feeMinor).toBe(5_000_00);
  });

  it("adds 18% p.a. interest when the tax paid late is recorded", () => {
    const result = lateFilingExposure({
      regime: "gst-return",
      dueDate: "2026-10-20",
      filedDate: "2026-10-25",
      asOf: "2026-10-25",
      taxMinor: 10_000_00, // ₹10,000
    });
    // 10,000 × 0.18 × 5/365 = ₹24.6575 → 2,466 paise (rounded once)
    expect(result.interestMinor).toBe(2_466);
    expect(result.totalMinor).toBe(25_000 + 2_466);
    expect(result.basis).toBe("exact");
  });
});

describe("TDS returns", () => {
  it("reports the uncapped maximum when the TDS amount is not recorded", () => {
    const result = lateFilingExposure({
      regime: "tds-return",
      dueDate: "2026-10-31",
      filedDate: "2026-11-10",
      asOf: "2026-11-10",
    });
    expect(result.feeMinor).toBe(10 * 200_00);
    expect(result.interestMinor).toBeNull();
    expect(result.basis).toBe("upper-bound");
  });

  it("caps u/s 234E at the TDS amount when it is recorded", () => {
    const result = lateFilingExposure({
      regime: "tds-return",
      dueDate: "2026-07-31",
      filedDate: "2026-11-10",
      asOf: "2026-11-10",
      taxMinor: 5_000_00,
    });
    expect(result.daysLate).toBe(102);
    expect(result.feeMinor).toBe(5_000_00);
    expect(result.basis).toBe("exact");
  });
});

describe("income-tax returns", () => {
  it("charges 234A interest at 1% per month or part month", () => {
    const result = lateFilingExposure({
      regime: "income-tax-return",
      dueDate: "2026-03-31",
      filedDate: "2026-04-01",
      asOf: "2026-04-01",
      taxMinor: 10_000_00,
    });
    expect(result.daysLate).toBe(1);
    expect(result.interestMinor).toBe(100_00); // 1% of ₹10,000
    expect(result.basis).toBe("partial");
  });

  it("does not guess when unpaid tax is not recorded", () => {
    const result = lateFilingExposure({
      regime: "income-tax-return",
      dueDate: "2026-10-31",
      filedDate: null,
      asOf: "2026-11-10",
    });
    expect(result.basis).toBe("unknown");
    expect(result.totalMinor).toBeNull();
  });
});

describe("MCA returns", () => {
  it("charges ₹100/day for AOC-4 and cites the schedule", () => {
    const result = lateFilingExposure({
      regime: "mca-return",
      code: "AOC-4",
      dueDate: "2026-10-30",
      filedDate: "2026-11-02",
      asOf: "2026-11-02",
    });
    expect(result.daysLate).toBe(3);
    expect(result.feeMinor).toBe(30_000); // 3 × ₹100
    expect(result.basis).toBe("exact");
    expect(result.rule).toContain("s.403");
  });

  it("flags the per-day product as an upper bound beyond 180 days", () => {
    const result = lateFilingExposure({
      regime: "mca-return",
      code: "MGT-7",
      dueDate: "2025-11-29",
      filedDate: "2026-07-01",
      asOf: "2026-07-01",
    });
    expect(result.basis).toBe("upper-bound");
    expect(result.totalMinor).toBe(result.daysLate * 100_00);
  });

  it("charges the flat DIR-3 KYC fee regardless of days late", () => {
    const result = lateFilingExposure({
      regime: "mca-return",
      code: "DIR-3-KYC",
      dueDate: "2026-09-30",
      filedDate: "2026-10-20",
      asOf: "2026-10-20",
    });
    expect(result.feeMinor).toBe(5_000_00);
    expect(result.basis).toBe("exact");
  });

  it("does not price an MCA code with no supplied code", () => {
    const result = lateFilingExposure({
      regime: "mca-return",
      dueDate: "2026-10-30",
      filedDate: "2026-11-02",
      asOf: "2026-11-02",
    });
    expect(result.totalMinor).toBeNull();
    expect(result.basis).toBe("unknown");
  });
});

describe("professional tax", () => {
  it("names the state gap instead of guessing a rate", () => {
    const result = lateFilingExposure({
      regime: "professional-tax",
      code: "PT-RETURN",
      dueDate: "2026-10-15",
      filedDate: null,
      asOf: "2026-11-10",
    });
    expect(result.totalMinor).toBeNull();
    expect(result.basis).toBe("unknown");
    expect(result.assumptions.join(" ")).toContain("state is not recorded");
  });

  it("prices Maharashtra interest once the state and tax are recorded", () => {
    const result = lateFilingExposure({
      regime: "professional-tax",
      code: "PT-RETURN",
      state: "Maharashtra",
      dueDate: "2026-09-30",
      filedDate: "2026-11-10",
      asOf: "2026-11-10",
      taxMinor: 2_500_00,
    });
    // 30 Sep → 10 Nov spans two month-or-part periods: 1.25% + 1.5% = ₹68.75,
    // plus the 10% statutory penalty (₹250).
    expect(result.interestMinor).toBe(6_875);
    expect(result.feeMinor).toBe(25_000);
    expect(result.basis).toBe("partial");
  });

  it("does not price interest when the tax paid late is missing", () => {
    const result = lateFilingExposure({
      regime: "professional-tax",
      code: "PT-RETURN",
      state: "Karnataka",
      dueDate: "2026-09-30",
      filedDate: "2026-11-10",
      asOf: "2026-11-10",
    });
    expect(result.totalMinor).toBeNull();
    expect(result.basis).toBe("unknown");
  });
});

describe("honesty edges", () => {
  it("returns zero for a return filed on its due date", () => {
    const result = lateFilingExposure({
      regime: "gst-return",
      dueDate: "2026-10-20",
      filedDate: "2026-10-20",
      asOf: "2026-10-20",
    });
    expect(result.totalMinor).toBe(0);
    expect(result.basis).toBe("exact");
  });

  it("does not estimate obligations outside the encoded schedules", () => {
    const result = lateFilingExposure({
      regime: "other",
      dueDate: "2026-10-30",
      filedDate: "2026-11-05",
      asOf: "2026-11-05",
    });
    expect(result.daysLate).toBe(6);
    expect(result.feeMinor).toBeNull();
    expect(result.interestMinor).toBeNull();
    expect(result.totalMinor).toBeNull();
    expect(result.basis).toBe("unknown");
  });

  it("reports an unreadable date as unknown rather than late", () => {
    const result = lateFilingExposure({
      regime: "gst-return",
      dueDate: "not-a-date",
      filedDate: "2026-11-05",
      asOf: "2026-11-05",
    });
    expect(result.daysLate).toBe(0);
    expect(result.totalMinor).toBeNull();
    expect(result.basis).toBe("unknown");
  });
});
