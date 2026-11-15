/**
 * ROC/MCA compliance engine — oracle tests.
 *
 * The engine anchors AOC-4/MGT-7 to the AGM date where one is supplied, so the
 * due dates are exact and hand-checkable (AGM + 30 / + 60 days). Status is
 * compared against the current date, so the tests deliberately use a FAR-PAST
 * financial year: everything is overdue forever, which keeps the assertions
 * deterministic instead of rotting as the calendar moves.
 */

import { buildRocCompliance } from "@/lib/engine/ca-roc-compliance";

describe("buildRocCompliance: annual filing calendar", () => {
  it("derives AOC-4/MGT-7 due dates from the AGM date", () => {
    const res = buildRocCompliance({
      cin: "U12345MH2020PTC123456",
      companyType: "private-limited",
      financialYearEnd: "2020-03-31",
      events: [{ kind: "agm-date", date: "2020-09-30" }],
      charges: [],
      directors: [],
    });

    expect(res.filings.map((f) => f.formType)).toEqual([
      "AOC-4 (financial statements)",
      "MGT-7 (annual return)",
      "DIR-3 KYC (annual)",
      "D&O declaration",
    ]);

    const aoc4 = res.filings.find((f) => f.formType.startsWith("AOC-4"))!;
    const mgt7 = res.filings.find((f) => f.formType.startsWith("MGT-7"))!;
    expect(aoc4.dueDate).toBe("2020-10-30"); // AGM + 30 days
    expect(mgt7.dueDate).toBe("2020-11-29"); // AGM + 60 days
    expect(res.filings.every((f) => f.status === "overdue")).toBe(true);
    // For an overdue filing daysToDue is the (non-negative) days past due.
    expect(res.filings.every((f) => f.daysToDue >= 0)).toBe(true);
  });

  it("falls back to illustrative due dates and warns when no AGM date is supplied", () => {
    const res = buildRocCompliance({
      cin: "U12345MH2020PTC123456",
      companyType: "public-limited",
      financialYearEnd: "2020-03-31",
      events: [],
      charges: [],
      directors: [],
    });

    const aoc4 = res.filings.find((f) => f.formType.startsWith("AOC-4"))!;
    expect(aoc4.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.warnings.some((w) => w.includes("AGM date"))).toBe(true);
  });
});

describe("buildRocCompliance: charges and directors", () => {
  it("maps a charge to a CHG-4 filing with a creation + 30 day due date", () => {
    const res = buildRocCompliance({
      cin: "U12345MH2020PTC123456",
      companyType: "private-limited",
      financialYearEnd: "2020-03-31",
      events: [{ kind: "agm-date", date: "2020-09-30" }],
      charges: [{ dateOfCreation: "2020-01-01", amount: 500_000, securedDebts: 400_000, asset: "Plant" }],
      directors: [],
    });

    expect(res.charges).toHaveLength(1);
    expect(res.charges[0]).toMatchObject({
      filing: "CHG-4 (charge created)",
      dueDate: "2020-01-31", // creation + 30 days
      status: "overdue",
      asset: "Plant",
    });
  });

  it("marks a director KYC done regardless of date and pending by date", () => {
    const res = buildRocCompliance({
      cin: "U12345MH2020PTC123456",
      companyType: "private-limited",
      financialYearEnd: "2020-03-31",
      events: [{ kind: "agm-date", date: "2020-09-30" }],
      charges: [],
      directors: [
        { name: "A", din: "00000001", kycStatus: "done" },
        { name: "B", din: "00000002", kycStatus: "pending" },
      ],
    });

    expect(res.directors[0]!.status).toBe("done");
    expect(res.directors[1]!.status).toBe("overdue");
    expect(res.directors[0]!.filing).toBe("DIR-3 KYC");
  });
});

describe("buildRocCompliance: disclosures and validation", () => {
  it("surfaces the reviewer warnings and methodology", () => {
    const res = buildRocCompliance({
      cin: "U12345MH2020PTC123456",
      companyType: "llp",
      financialYearEnd: "2020-03-31",
      events: [{ kind: "agm-date", date: "2020-09-30" }],
      charges: [],
      directors: [],
    });

    expect(res.warnings).toHaveLength(3);
    expect(res.methodology.length).toBe(4);
    expect(res.cin).toBe("U12345MH2020PTC123456");
    expect(res.companyType).toBe("llp");
  });

  it("rejects a malformed financial-year-end date", () => {
    expect(() =>
      buildRocCompliance({
        cin: "U12345MH2020PTC123456",
        companyType: "private-limited",
        financialYearEnd: "not-a-date",
        events: [],
        charges: [],
        directors: [],
      }),
    ).toThrow(/Invalid ISO date/);
  });
});
