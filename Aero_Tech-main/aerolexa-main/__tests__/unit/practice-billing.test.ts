/**
 * Receivables maths: collected vs outstanding vs void, and the aging bucket an
 * issued invoice falls into. Hand-computed against the asOf date.
 */

import {
  invoiceAgingBucket,
  invoiceDaysOverdue,
  summarisePracticeEconomics,
  type EconomicsInvoice,
} from "@/lib/server/practice-economics";

const asOf = "2026-11-10";
const noEntries: [] = [];

function invoice(overrides: Partial<EconomicsInvoice> & Pick<EconomicsInvoice, "id">): EconomicsInvoice {
  return {
    engagementId: "eng-a",
    number: `PI-${overrides.id}`,
    subtotalMinor: 1_000,
    taxMinor: 180,
    totalMinor: 1_180,
    status: "issued",
    issuedOn: "2026-10-01",
    dueDate: "2026-10-15",
    ...overrides,
  };
}

describe("invoice aging", () => {
  it("counts days past due only for issued invoices", () => {
    expect(invoiceDaysOverdue({ status: "issued", dueDate: "2026-10-15" }, asOf)).toBe(26);
    expect(invoiceDaysOverdue({ status: "paid", dueDate: "2026-10-15" }, asOf)).toBe(0);
    expect(invoiceDaysOverdue({ status: "void", dueDate: "2026-10-15" }, asOf)).toBe(0);
    expect(invoiceDaysOverdue({ status: "issued", dueDate: "2026-11-20" }, asOf)).toBe(0);
  });

  it("buckets on the documented boundaries", () => {
    expect(invoiceAgingBucket(0)).toBe("current");
    expect(invoiceAgingBucket(1)).toBe("1-30");
    expect(invoiceAgingBucket(30)).toBe("1-30");
    expect(invoiceAgingBucket(31)).toBe("31-60");
    expect(invoiceAgingBucket(60)).toBe("31-60");
    expect(invoiceAgingBucket(61)).toBe("61-90");
    expect(invoiceAgingBucket(90)).toBe("61-90");
    expect(invoiceAgingBucket(91)).toBe("90+");
  });
});

describe("collected vs outstanding", () => {
  it("moves money from outstanding to collected exactly once", () => {
    const summary = summarisePracticeEconomics({
      asOf,
      entries: noEntries,
      invoices: [
        invoice({ id: "issued", totalMinor: 1_180 }),
        invoice({ id: "paid", totalMinor: 2_360, status: "paid", paidOn: "2026-10-20", paymentReference: "UTR-1" }),
        invoice({ id: "void", totalMinor: 9_999, status: "void" }),
      ],
    });

    expect(summary.totals.invoicedMinor).toBe(3_540);
    expect(summary.totals.collectedMinor).toBe(2_360);
    expect(summary.totals.outstandingMinor).toBe(1_180);
    expect(summary.totals.voidedMinor).toBe(9_999);
    expect(summary.invoices.find((row) => row.id === "issued")?.daysOverdue).toBe(26);
    expect(summary.invoices.find((row) => row.id === "paid")?.daysOverdue).toBe(0);
  });

  it("puts each issued invoice in exactly one aging bucket", () => {
    const summary = summarisePracticeEconomics({
      asOf,
      entries: noEntries,
      invoices: [
        invoice({ id: "current", dueDate: "2026-11-30", totalMinor: 100 }),
        invoice({ id: "late-20", dueDate: "2026-10-21", totalMinor: 200 }),
        invoice({ id: "late-80", dueDate: "2026-08-22", totalMinor: 300 }),
        invoice({ id: "paid-late", dueDate: "2026-08-01", status: "paid", paidOn: "2026-08-02", totalMinor: 400 }),
      ],
    });

    expect(summary.invoiceAging).toEqual([
      { bucket: "current", invoices: 1, outstandingMinor: 100 },
      { bucket: "1-30", invoices: 1, outstandingMinor: 200 },
      { bucket: "31-60", invoices: 0, outstandingMinor: 0 },
      { bucket: "61-90", invoices: 1, outstandingMinor: 300 },
      { bucket: "90+", invoices: 0, outstandingMinor: 0 },
    ]);
    // Every issued rupee is counted once across the buckets.
    expect(summary.invoiceAging.reduce((sum, row) => sum + row.outstandingMinor, 0)).toBe(
      summary.totals.outstandingMinor,
    );
  });

  it("reports collected per client without counting void invoices as revenue", () => {
    const summary = summarisePracticeEconomics({
      asOf,
      entries: noEntries,
      invoices: [
        invoice({ id: "a1", totalMinor: 1_000 }),
        invoice({ id: "a2", totalMinor: 500, status: "paid", paidOn: "2026-10-10" }),
        invoice({ id: "a3", totalMinor: 700, status: "void" }),
      ],
    });
    const client = summary.clients.find((row) => row.engagementId === "eng-a");
    expect(client?.invoicedMinor).toBe(1_500);
    expect(client?.collectedMinor).toBe(500);
    expect(client?.outstandingMinor).toBe(1_000);
  });
});
