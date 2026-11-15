/**
 * Penalty-schedule oracles.
 *
 * The registry is the only place a company-law fee is written down. These tests
 * pin the arithmetic, the effective window, and the refusal to price an
 * obligation whose schedule is not encoded.
 */

import { applyPenaltySchedule, penaltyScheduleFor } from "@/lib/engine/penalty-schedule";

describe("penalty schedule lookup", () => {
  it("resolves the MCA schedule for a form and date inside its window", () => {
    const schedule = penaltyScheduleFor("AOC-4", "2026-10-30");
    expect(schedule?.id).toBe("mca-additional-fee-2014");
    expect(schedule?.feePerDayMinor).toBe(100_00);
    expect(schedule?.citation).toContain("s.403");
  });

  it("does not apply a schedule before it took effect", () => {
    expect(penaltyScheduleFor("AOC-4", "2013-06-01")).toBeNull();
  });

  it("resolves the flat DIR-3 KYC fee only from its own start date", () => {
    expect(penaltyScheduleFor("DIR-3-KYC", "2018-03-31")).toBeNull();
    expect(penaltyScheduleFor("DIR-3-KYC", "2018-04-01")?.flatFeeMinor).toBe(5_000_00);
  });

  it("returns null for a code with no published schedule", () => {
    expect(penaltyScheduleFor("PT-RETURN", "2026-10-15")).toBeNull();
    expect(penaltyScheduleFor("GSTR-3B", "2026-10-20")).toBeNull();
  });

  it("returns null for a malformed date rather than the newest schedule", () => {
    expect(penaltyScheduleFor("AOC-4", "30-10-2026")).toBeNull();
  });
});

describe("penalty arithmetic", () => {
  const mca = penaltyScheduleFor("AOC-4", "2026-10-30")!;
  const kyc = penaltyScheduleFor("DIR-3-KYC", "2026-09-30")!;

  it("multiplies the daily fee and stays exact inside 180 days", () => {
    expect(applyPenaltySchedule(mca, 1)).toEqual({ feeMinor: 10_000, basis: "exact" });
    expect(applyPenaltySchedule(mca, 180)).toEqual({ feeMinor: 1_800_000, basis: "exact" });
  });

  it("turns the product into an upper bound after the alternative-fee threshold", () => {
    expect(applyPenaltySchedule(mca, 181)).toEqual({ feeMinor: 1_810_000, basis: "upper-bound" });
  });

  it("charges the flat fee once, however late", () => {
    expect(applyPenaltySchedule(kyc, 1)).toEqual({ feeMinor: 500_000, basis: "exact" });
    expect(applyPenaltySchedule(kyc, 400)).toEqual({ feeMinor: 500_000, basis: "exact" });
  });

  it("returns null when there is nothing late to price", () => {
    expect(applyPenaltySchedule(mca, 0)).toBeNull();
    expect(applyPenaltySchedule(mca, Number.NaN)).toBeNull();
  });
});
