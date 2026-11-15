import { summariseHubTotals } from "@/lib/server/deliverables-hub";

/**
 * Oracle tests for the deliverable register's roll-up. The hub's headline
 * numbers (outstanding vs issued) decide what a partner chases, so they are
 * asserted exactly rather than snapshotted.
 */
describe("summariseHubTotals", () => {
  it("counts every status and separates issued from outstanding work", () => {
    const totals = summariseHubTotals([
      { status: "DRAFT", count: 2 },
      { status: "IN_REVIEW", count: 3 },
      { status: "REVIEWED", count: 1 },
      { status: "SIGNED_OFF", count: 4 },
      { status: "ISSUED", count: 5 },
      { status: "SUPERSEDED", count: 2 },
      { status: "WITHDRAWN", count: 1 },
      { status: "ARCHIVED", count: 6 },
    ]);

    expect(totals.total).toBe(24);
    expect(totals.issued).toBe(5);
    // DRAFT + IN_REVIEW + REVIEWED + SIGNED_OFF = 10
    expect(totals.outstanding).toBe(10);
    expect(totals.byStatus.SIGNED_OFF).toBe(4);
  });

  it("treats an empty register as zero, never NaN", () => {
    expect(summariseHubTotals([])).toEqual({ total: 0, byStatus: {}, outstanding: 0, issued: 0 });
  });

  it("sums duplicate status rows instead of overwriting them", () => {
    const totals = summariseHubTotals([
      { status: "DRAFT", count: 2 },
      { status: "DRAFT", count: 3 },
    ]);
    expect(totals.byStatus.DRAFT).toBe(5);
    expect(totals.outstanding).toBe(5);
  });
});
