/**
 * Monthly compliance report oracles.
 *
 * The month, the outcomes and the exposure total are hand-computed so a change
 * to a rate, a bucket or a filter is caught here rather than in a client email.
 */

import { buildMonthlyComplianceReport, isReportMonth } from "@/lib/engine/compliance-report";

const engagement = { id: "eng-1", name: "Sharma Textiles" };

const obligations = [
  {
    taskId: "eng-1:GSTR-3B:2026-10",
    code: "GSTR-3B",
    title: "GSTR-3B Oct 2026",
    authority: "GSTN",
    dueDate: "2026-10-20",
    filedDate: "2026-10-25",
    status: "filed",
    reference: "ARN-1",
    proofDigest: "abc123",
    clientApprovedAt: "2026-10-22T10:00:00.000Z",
  },
  {
    taskId: "eng-1:TDS-26Q:Q2",
    code: "TDS-26Q",
    title: "TDS Q2 FY2026-27",
    authority: "Income Tax Department",
    dueDate: "2026-10-07",
    filedDate: "2026-10-07",
    status: "filed",
    reference: null,
    proofDigest: null,
    clientApprovedAt: null,
  },
  {
    taskId: "eng-1:ITR:2026",
    code: "ITR",
    title: "ITR FY2025-26",
    authority: "Income Tax Department",
    dueDate: "2026-10-31",
    filedDate: null,
    status: "in-progress",
    reference: null,
    proofDigest: null,
    clientApprovedAt: null,
  },
  {
    taskId: "eng-1:AOC-4:2026",
    code: "AOC-4",
    title: "AOC-4 FY2025-26",
    authority: "MCA",
    dueDate: "2026-10-30",
    filedDate: "2026-11-02",
    status: "filed",
    reference: "SRN-1",
    proofDigest: null,
    clientApprovedAt: null,
  },
  {
    taskId: "eng-1:PT-RETURN:2026",
    code: "PT-RETURN",
    title: "Professional tax",
    authority: "State",
    dueDate: "2026-10-15",
    filedDate: null,
    status: "waived",
    reference: null,
    proofDigest: null,
    clientApprovedAt: null,
  },
  {
    taskId: "eng-1:GSTR-1:2026-11",
    code: "GSTR-1",
    title: "GSTR-1 Nov 2026",
    authority: "GSTN",
    dueDate: "2026-11-11",
    filedDate: null,
    status: "pending",
    reference: null,
    proofDigest: null,
    clientApprovedAt: null,
  },
];

describe("isReportMonth", () => {
  it("accepts yyyy-mm and rejects everything else", () => {
    expect(isReportMonth("2026-10")).toBe(true);
    expect(isReportMonth("2026-13")).toBe(false);
    expect(isReportMonth("2026-1")).toBe(false);
    expect(isReportMonth("10-2026")).toBe(false);
  });
});

describe("buildMonthlyComplianceReport", () => {
  const report = buildMonthlyComplianceReport({
    month: "2026-10",
    asOf: "2026-11-05",
    engagement,
    obligations,
  });

  it("includes only obligations due in the month", () => {
    expect(report.rows).toHaveLength(5);
    expect(report.rows.map((row) => row.code)).not.toContain("GSTR-1");
  });

  it("classifies each row from the dates, not from the stored status", () => {
    const byCode = new Map(report.rows.map((row) => [row.code, row]));
    expect(byCode.get("GSTR-3B")?.outcome).toBe("filed-late");
    expect(byCode.get("GSTR-3B")?.daysLate).toBe(5);
    expect(byCode.get("TDS-26Q")?.outcome).toBe("filed-on-time");
    expect(byCode.get("ITR")?.outcome).toBe("overdue");
    expect(byCode.get("ITR")?.daysLate).toBe(5);
    expect(byCode.get("AOC-4")?.outcome).toBe("filed-late");
    expect(byCode.get("PT-RETURN")?.outcome).toBe("waived");
  });

  it("totals the month", () => {
    expect(report.totals).toMatchObject({
      due: 5,
      filed: 3,
      onTime: 1,
      late: 2,
      pending: 0,
      overdue: 1,
      waived: 1,
    });
  });

  it("sums only computable exposure and says how many rows it could not price", () => {
    // GSTR-3B: 5 days × ₹50 = ₹250 (interest unknown → partial).
    // AOC-4: 3 days × ₹100 = ₹300 (encoded MCA additional fee → exact).
    // TDS: on time, zero and excluded. ITR: unpaid tax missing → unpriced.
    expect(report.totals.exposureMinor).toBe(25_000 + 30_000);
    expect(report.totals.exposureRows).toBe(2);
    expect(report.totals.exposureIncomplete).toBe(1);
    expect(report.totals.exposureUpperBound).toBe(0);
  });

  it("carries the evidence a client can check", () => {
    const gstr3b = report.rows.find((row) => row.code === "GSTR-3B");
    expect(gstr3b?.reference).toBe("ARN-1");
    expect(gstr3b?.proofDigest).toBe("abc123");
    expect(gstr3b?.clientApprovedAt).toBe("2026-10-22T10:00:00.000Z");
  });

  it("writes a deterministic narrative that admits the estimate", () => {
    expect(report.narrative[0]).toBe("5 obligations fell due in 2026-10.");
    expect(report.narrative.join(" ")).toContain("Estimated late-filing exposure: ₹550 across 2 obligations");
    expect(report.narrative.join(" ")).toContain("1 late or overdue obligation could not be priced");
    expect(report.narrative.join(" ")).toContain("not a legal opinion or a demand");
  });

  it("sorts rows by due date", () => {
    expect(report.rows.map((row) => row.dueDate)).toEqual([
      "2026-10-07",
      "2026-10-15",
      "2026-10-20",
      "2026-10-30",
      "2026-10-31",
    ]);
  });

  it("handles a month with nothing due", () => {
    const empty = buildMonthlyComplianceReport({
      month: "2026-12",
      asOf: "2026-12-31",
      engagement,
      obligations,
    });
    expect(empty.rows).toEqual([]);
    expect(empty.totals.exposureMinor).toBe(0);
    expect(empty.narrative[0]).toContain("No statutory obligation");
  });

  it("rejects a malformed month", () => {
    expect(() =>
      buildMonthlyComplianceReport({ month: "October", asOf: "2026-11-01", engagement, obligations }),
    ).toThrow(/yyyy-mm/);
  });
});
