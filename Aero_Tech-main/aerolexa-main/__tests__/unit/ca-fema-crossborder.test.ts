/**
 * FEMA / cross-border engine — oracle tests.
 *
 * Hand-computed expectations. Pinned properties:
 *
 *  1. FC-GPR due date is EXACTLY 30 days after allotment, and lateness is
 *     measured against the due date, not the allotment date.
 *  2. Pricing tests are directional: R→N must not be BELOW fair value;
 *     N→R must not EXCEED fair value — symmetric-looking inputs get opposite
 *     verdicts.
 *  3. ODI headroom uses 400% of net worth (or the RBI-approved amount, when
 *     larger), and the LRS limit is inclusive (exactly 250k is within limit).
 */

import { ecbRate, fcgpr, fctrs, lrsTcs, odiLimit } from "@/lib/engine/ca-fema-crossborder";

describe("FC-GPR reporting deadline", () => {
  it("due date is exactly 30 days after allotment", () => {
    const res = fcgpr({ allotmentDate: "2026-01-01", issuePriceMinor: 100_00, fairValueMinor: 90_00 });
    expect(res.dueDate).toBe("2026-01-31");
  });

  it("a filing on the due date is on time — inclusive", () => {
    const res = fcgpr({
      allotmentDate: "2026-01-01",
      filedOn: "2026-01-31",
      issuePriceMinor: 100_00,
      fairValueMinor: 90_00,
    });
    expect(res.daysLate).toBe(0);
    expect(res.onTime).toBe(true);
  });

  it("one day late is measured from the due date", () => {
    const res = fcgpr({
      allotmentDate: "2026-01-01",
      filedOn: "2026-02-01",
      issuePriceMinor: 100_00,
      fairValueMinor: 90_00,
    });
    expect(res.daysLate).toBe(1);
    expect(res.onTime).toBe(false);
  });

  it("an unfiled allotment accrues no days late yet", () => {
    const res = fcgpr({ allotmentDate: "2026-01-01", issuePriceMinor: 100_00, fairValueMinor: 90_00 });
    expect(res.filedOn).toBeNull();
    expect(res.daysLate).toBe(0);
  });

  it("flags the pricing shortfall when issued below fair value", () => {
    const res = fcgpr({ allotmentDate: "2026-01-01", issuePriceMinor: 80_00, fairValueMinor: 100_00 });
    expect(res.pricing.compliant).toBe(false);
    expect(res.pricing.shortfallMinor).toBe(20_00);
  });
});

describe("FC-TRS directional pricing tests", () => {
  it("R→N below fair value is non-compliant with the shortfall stated", () => {
    const res = fctrs({ direction: "resident-to-non-resident", transferPriceMinor: 90_00, fairValueMinor: 100_00 });
    expect(res.compliant).toBe(false);
    expect(res.deviationMinor).toBe(10_00);
  });

  it("R→N at exactly fair value is compliant — inclusive", () => {
    const res = fctrs({ direction: "resident-to-non-resident", transferPriceMinor: 100_00, fairValueMinor: 100_00 });
    expect(res.compliant).toBe(true);
    expect(res.deviationMinor).toBe(0);
  });

  it("N→R above fair value is non-compliant — the symmetric opposite", () => {
    const res = fctrs({ direction: "non-resident-to-resident", transferPriceMinor: 110_00, fairValueMinor: 100_00 });
    expect(res.compliant).toBe(false);
    expect(res.deviationMinor).toBe(10_00);
  });

  it("N→R below fair value is compliant", () => {
    const res = fctrs({ direction: "non-resident-to-resident", transferPriceMinor: 95_00, fairValueMinor: 100_00 });
    expect(res.compliant).toBe(true);
  });
});

describe("ODI financial commitment limit", () => {
  it("400% of net worth is the statutory limit", () => {
    // net worth ₹10 crore → limit ₹40 crore; commitment ₹35 crore → within
    const res = odiLimit({ netWorthMinor: 10_00_00_000 * 100, totalFinancialCommitmentMinor: 35_00_00_000 * 100 });
    expect(res.limitMinor).toBe(40_00_00_000 * 100);
    expect(res.withinLimit).toBe(true);
    expect(res.headroomMinor).toBe(5_00_00_000 * 100);
  });

  it("the RBI-approved amount can exceed the statutory computation", () => {
    const res = odiLimit({
      netWorthMinor: 10_00_00_000 * 100,
      approvedByRbiMinor: 50_00_00_000 * 100,
      totalFinancialCommitmentMinor: 45_00_00_000 * 100,
    });
    expect(res.limitMinor).toBe(50_00_00_000 * 100);
    expect(res.withinLimit).toBe(true);
  });

  it("exceeding the larger of the two limits is flagged", () => {
    const res = odiLimit({ netWorthMinor: 10_00_00_000 * 100, totalFinancialCommitmentMinor: 41_00_00_000 * 100 });
    expect(res.withinLimit).toBe(false);
    expect(res.headroomMinor).toBe(0);
  });
});

describe("ECB ceiling rate", () => {
  it("ceiling = benchmark + 4.5% spread cap by default", () => {
    // benchmark 5% + spread 4% → all-in 9% ≤ 9.5% ceiling → compliant
    const res = ecbRate({ benchmarkPct: 5, spreadPct: 4 });
    expect(res.ceilingPct).toBe(9.5);
    expect(res.allInPct).toBe(9);
    expect(res.compliant).toBe(true);
    expect(res.excessPct).toBe(0);
  });

  it("excess is computed to six decimals when the spread breaches the cap", () => {
    // benchmark 5% + spread 4.75% → all-in 9.75% vs 9.5% → excess 0.25%
    const res = ecbRate({ benchmarkPct: 5, spreadPct: 4.75 });
    expect(res.compliant).toBe(false);
    expect(res.excessPct).toBeCloseTo(0.25, 6);
  });

  it("exactly at the ceiling is compliant — inclusive", () => {
    const res = ecbRate({ benchmarkPct: 5, spreadPct: 4.5 });
    expect(res.compliant).toBe(true);
  });

  it("honours a caller-supplied spread cap (master-direction override)", () => {
    const res = ecbRate({ benchmarkPct: 5, spreadPct: 5.5, spreadCapPct: 5 });
    expect(res.compliant).toBe(false);
    expect(res.excessPct).toBeCloseTo(0.5, 6);
  });
});

describe("LRS limit + TCS", () => {
  it("USD 250,000 is the inclusive limit — exactly at it is within", () => {
    const res = lrsTcs({ amountUsdMinor: 25_000_000 });
    expect(res.withinLimit).toBe(true);
    expect(res.remittancesLeftUsdMinor).toBe(0);
  });

  it("prior remittances count against the same limit", () => {
    const res = lrsTcs({ amountUsdMinor: 60_000_00, priorYearRemittancesUsdMinor: 200_000_00 });
    expect(res.withinLimit).toBe(false);
    expect(res.remittancesLeftUsdMinor).toBe(0);
  });

  it("TCS is 5% while the INR value stays within ₹7 lakh", () => {
    const res = lrsTcs({ amountUsdMinor: 6_00_000, inrEquivalentMinor: 6_00_000 * 100 });
    expect(res.tcsRatePct).toBe(5);
    expect(res.tcsAmountMinor).toBe(Math.round((6_00_000 * 5) / 100));
  });

  it("TCS jumps to 20% when the ₹7 lakh INR threshold is crossed", () => {
    const res = lrsTcs({ amountUsdMinor: 8_00_000, inrEquivalentMinor: 8_00_000 * 100 });
    expect(res.tcsRatePct).toBe(20);
    expect(res.tcsAmountMinor).toBe(1_60_000);
  });

  it("defaults to 5% with an explicit note when no INR equivalent is supplied", () => {
    // $8,000 with NO inrEquivalentMinor: the engine must NOT guess the
    // threshold test by comparing USD against an INR limit.
    const res = lrsTcs({ amountUsdMinor: 8_00_000 });
    expect(res.tcsRatePct).toBe(5);
    expect(res.basis).toContain("never compared directly");
  });
});
