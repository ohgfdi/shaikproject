/**
 * Firm cockpit ranking rules. The properties that matter: a late obligation is
 * critical and comes first, a soon-due one is a warning, a not-yet-due invoice
 * is not work, and nothing is invented when there are no rows.
 */

import { buildCockpit, daysBetween, emptyCockpit } from "@/lib/server/firm-cockpit";

const TODAY = "2026-11-11";

function base() {
  return {
    today: TODAY,
    filings: [],
    deliverables: [],
    invoices: [],
    requests: [],
    unmatchedGstInvoices: 0,
  };
}

describe("daysBetween", () => {
  it("returns whole calendar days and null for bad input", () => {
    expect(daysBetween("2026-11-01", "2026-11-11")).toBe(10);
    expect(daysBetween("2026-11-11", "2026-11-01")).toBe(-10);
    expect(daysBetween("not-a-date", "2026-11-11")).toBeNull();
  });
});

describe("firm cockpit", () => {
  it("puts an overdue filing at the top as critical", () => {
    const summary = buildCockpit({
      ...base(),
      filings: [
        { id: "f1", title: "GSTR-3B", engagementName: "Acme", dueDate: "2026-11-05", stage: "reviewed" },
      ],
    });
    expect(summary.total).toBe(1);
    expect(summary.items[0]!.severity).toBe("critical");
    expect(summary.items[0]!.detail).toContain("overdue by 6 days");
    expect(summary.items[0]!.href).toBe("/compliance/filings");
  });

  it("does not surface a filing beyond the 30-day horizon", () => {
    const summary = buildCockpit({
      ...base(),
      filings: [
        { id: "f1", title: "ITR", engagementName: "Acme", dueDate: "2027-03-31", stage: "computed" },
      ],
    });
    expect(summary.total).toBe(0);
  });

  it("ranks a reviewed deliverable as work waiting on the partner", () => {
    const summary = buildCockpit({
      ...base(),
      deliverables: [
        {
          id: "d1",
          label: "Financials",
          engagementName: "Acme",
          status: "REVIEWED",
          updatedAt: "2026-11-08T10:00:00.000Z",
        },
      ],
    });
    expect(summary.items[0]!.kind).toBe("deliverable");
    expect(summary.items[0]!.detail).toContain("awaiting partner sign-off");
    expect(summary.items[0]!.severity).toBe("info");
  });

  it("treats an issued invoice past its due date as critical and a future one as no work", () => {
    const overdue = buildCockpit({
      ...base(),
      invoices: [
        { id: "i1", number: "INV-1", engagementName: "Acme", dueDate: "2026-11-01", totalMinor: 500000, status: "issued" },
      ],
    });
    expect(overdue.items[0]!.severity).toBe("critical");
    expect(overdue.items[0]!.detail).toContain("₹5,000");

    const future = buildCockpit({
      ...base(),
      invoices: [
        { id: "i1", number: "INV-1", engagementName: "Acme", dueDate: "2026-11-20", totalMinor: 500000, status: "issued" },
      ],
    });
    expect(future.total).toBe(0);
  });

  it("chases a document request due within three days, not one due next month", () => {
    const soon = buildCockpit({
      ...base(),
      requests: [{ id: "r1", title: "Bank statements", clientName: "Acme", dueDate: "2026-11-13" }],
    });
    expect(soon.items[0]!.severity).toBe("warning");

    const later = buildCockpit({
      ...base(),
      requests: [{ id: "r1", title: "Bank statements", clientName: "Acme", dueDate: "2026-12-10" }],
    });
    expect(later.total).toBe(0);
  });

  it("keeps the GST exception as a single informational row", () => {
    const summary = buildCockpit({ ...base(), unmatchedGstInvoices: 3 });
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0]!.kind).toBe("gst");
    expect(summary.items[0]!.severity).toBe("info");
  });

  it("sorts critical before warning before info, then by due date", () => {
    const summary = buildCockpit({
      ...base(),
      filings: [
        { id: "later", title: "Later", engagementName: "Acme", dueDate: "2026-11-15", stage: "computed" },
        { id: "late", title: "Late", engagementName: "Acme", dueDate: "2026-11-01", stage: "prepared" },
      ],
      unmatchedGstInvoices: 1,
    });
    expect(summary.items.map((item) => item.id)).toEqual(["filing:late", "filing:later", "gst:unmatched"]);
    expect(summary.counts).toEqual({ critical: 1, warning: 1, info: 1 });
  });

  it("returns an empty queue when there is nothing stored", () => {
    expect(buildCockpit(base()).total).toBe(0);
    expect(emptyCockpit()).toEqual({ items: [], total: 0, counts: { critical: 0, warning: 0, info: 0 } });
  });
});
