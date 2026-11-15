/**
 * Oracle tests for the statutory calendar.
 *
 * Due dates are the product here: a wrong date is worse than a missing feature,
 * so these assert exact ISO dates and the number of generated obligations.
 */

import {
  buildClientComplianceCalendar,
  complianceTaskState,
  daysUntil,
  financialYearFor,
  parseFinancialYear,
  type ClientComplianceProfileInput,
} from "@/lib/engine/compliance-calendar";

function profile(overrides: Partial<ClientComplianceProfileInput> = {}): ClientComplianceProfileInput {
  return {
    clientId: "e1",
    clientName: "Acme Manufacturing Pvt Ltd",
    entityKind: "company",
    financialYear: "2025-26",
    gstRegistered: true,
    gstFrequency: "monthly",
    tdsDeductor: true,
    taxAuditApplicable: true,
    transferPricingApplicable: false,
    listedCompany: false,
    state: "maharashtra",
    employsStaff: true,
    ...overrides,
  };
}

function tasks(overrides: Partial<ClientComplianceProfileInput> = {}) {
  return buildClientComplianceCalendar(profile(overrides));
}

function find(list: ReturnType<typeof tasks>, code: string, period: string) {
  const row = list.find((t) => t.code === code && t.period === period);
  if (!row) throw new Error(`missing ${code} ${period}`);
  return row;
}

describe("financial year helpers", () => {
  it("parses an Indian FY and derives the assessment year", () => {
    expect(parseFinancialYear("2025-26")).toEqual({ startYear: 2025, endYear: 2026, assessmentYear: "2026-27" });
  });

  it("rejects a malformed FY instead of guessing", () => {
    expect(() => parseFinancialYear("2025")).toThrow(/2025-26/);
  });

  it("rolls the FY at 1 April, not 1 January", () => {
    expect(financialYearFor("2026-03-31")).toBe("2025-26");
    expect(financialYearFor("2026-04-01")).toBe("2026-27");
  });
});

describe("GST", () => {
  it("generates 12 monthly GSTR-1 and 12 GSTR-3B dates", () => {
    const list = tasks();
    const gstr1 = list.filter((t) => t.code === "GSTR-1");
    const gstr3b = list.filter((t) => t.code === "GSTR-3B");
    expect(gstr1).toHaveLength(12);
    expect(gstr3b).toHaveLength(12);

    expect(find(list, "GSTR-1", "Apr 2025").dueDate).toBe("2025-05-11");
    expect(find(list, "GSTR-3B", "Apr 2025").dueDate).toBe("2025-05-20");
    expect(find(list, "GSTR-1", "Mar 2026").dueDate).toBe("2026-04-11");
    expect(find(list, "GSTR-3B", "Mar 2026").dueDate).toBe("2026-04-20");
  });

  it("switches to quarterly QRMP dates on request", () => {
    const list = tasks({ gstFrequency: "quarterly" });
    expect(list.filter((t) => t.code === "GSTR-1")).toHaveLength(4);
    expect(find(list, "GSTR-1", "Apr–Jun 2025").dueDate).toBe("2025-07-13");
    expect(find(list, "GSTR-3B", "Jan–Mar 2026").dueDate).toBe("2026-04-22");
  });

  it("adds no GST obligations for an unregistered client", () => {
    const list = tasks({ gstRegistered: false });
    expect(list.some((t) => t.code.startsWith("GSTR"))).toBe(false);
  });
});

describe("TDS", () => {
  it("uses the 7th for normal months and 30 April for March", () => {
    const list = tasks();
    expect(find(list, "TDS-PAYMENT", "Apr 2025").dueDate).toBe("2025-05-07");
    expect(find(list, "TDS-PAYMENT", "Feb 2026").dueDate).toBe("2026-03-07");
    expect(find(list, "TDS-PAYMENT", "Mar 2026").dueDate).toBe("2026-04-30");
  });

  it("dates the four 26Q returns correctly across the year", () => {
    const list = tasks();
    const returns = list.filter((t) => t.code === "TDS-26Q");
    expect(returns.map((t) => t.dueDate)).toEqual(["2025-07-31", "2025-10-31", "2026-01-31", "2026-05-31"]);
  });

  it("omits TDS entirely when the client is not a deductor", () => {
    const list = tasks({ tdsDeductor: false });
    expect(list.some((t) => t.code === "TDS-PAYMENT" || t.code === "TDS-26Q")).toBe(false);
  });
});

describe("income tax, audit and ROC", () => {
  it("uses 31 October for an audit company and 31 July otherwise", () => {
    expect(find(tasks(), "ITR", "AY 2026-27").dueDate).toBe("2026-10-31");
    expect(
      find(tasks({ entityKind: "proprietorship", taxAuditApplicable: false }), "ITR", "AY 2026-27").dueDate,
    ).toBe("2026-07-31");
  });

  it("moves a transfer-pricing case to 30 November", () => {
    expect(find(tasks({ transferPricingApplicable: true }), "ITR", "AY 2026-27").dueDate).toBe("2026-11-30");
  });

  it("generates the 3CD report only when an audit applies", () => {
    expect(find(tasks(), "TAX-AUDIT-3CD", "FY 2025-26").dueDate).toBe("2026-09-30");
    const noAudit = tasks({ entityKind: "proprietorship", taxAuditApplicable: false });
    expect(noAudit.some((t) => t.code === "TAX-AUDIT-3CD")).toBe(false);
  });

  it("generates the company annual filings, and LLP forms for an LLP", () => {
    const company = tasks();
    expect(find(company, "AOC-4", "FY 2025-26").dueDate).toBe("2026-10-30");
    expect(find(company, "MGT-7", "FY 2025-26").dueDate).toBe("2026-11-29");
    expect(find(company, "DIR-3-KYC", "FY 2025-26").dueDate).toBe("2026-09-30");

    const llp = tasks({ entityKind: "llp", taxAuditApplicable: false });
    expect(find(llp, "LLP-11", "FY 2025-26").dueDate).toBe("2026-05-30");
    expect(find(llp, "LLP-8", "FY 2025-26").dueDate).toBe("2026-10-30");
    expect(llp.some((t) => t.code === "AOC-4")).toBe(false);
  });
});

describe("professional tax", () => {
  it("adds monthly PT only for a PT state that employs staff", () => {
    expect(tasks().filter((t) => t.code === "PT-RETURN")).toHaveLength(12);
    expect(tasks({ state: "delhi" }).some((t) => t.code === "PT-RETURN")).toBe(false);
    expect(tasks({ employsStaff: false }).some((t) => t.code === "PT-RETURN")).toBe(false);
  });
});

describe("task identity and state", () => {
  it("produces stable ids across regeneration", () => {
    const a = tasks().map((t) => t.id);
    const b = tasks().map((t) => t.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it("classifies overdue, due-soon, upcoming and filed", () => {
    expect(complianceTaskState("2026-04-10", "2026-04-11", null)).toBe("overdue");
    expect(complianceTaskState("2026-04-20", "2026-04-11", null)).toBe("due-soon");
    expect(complianceTaskState("2026-06-20", "2026-04-11", null)).toBe("upcoming");
    expect(complianceTaskState("2026-04-10", "2026-04-11", "filed")).toBe("filed");
    expect(complianceTaskState("2026-04-10", "2026-04-11", "waived")).toBe("waived");
    expect(daysUntil("2026-04-11", "2026-04-20")).toBe(9);
  });
});
