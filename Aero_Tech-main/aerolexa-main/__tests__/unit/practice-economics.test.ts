/**
 * Practice economics maths — hand-computed WIP values, age buckets and invoice
 * totals. The engine must never count an hour twice: an entry is either
 * unbilled WIP or frozen into exactly one invoice.
 */

import {
  entryValueMinor,
  summarisePracticeEconomics,
  wipBucket,
} from "@/lib/server/practice-economics";

describe("time valuation", () => {
  it("values minutes at the recorded hourly rate, in paise", () => {
    expect(entryValueMinor({ minutes: 60, ratePerHourMinor: 100_000, billable: true })).toBe(100_000);
    expect(entryValueMinor({ minutes: 90, ratePerHourMinor: 100_000, billable: true })).toBe(150_000);
  });

  it("rounds once to the nearest paise", () => {
    // ₹10.00/hour = 1000 paise/hour; one minute = 16.66… paise.
    expect(entryValueMinor({ minutes: 1, ratePerHourMinor: 1_000, billable: true })).toBe(17);
    expect(entryValueMinor({ minutes: 7, ratePerHourMinor: 1_000, billable: true })).toBe(117);
  });

  it("values non-billable time at zero", () => {
    expect(entryValueMinor({ minutes: 120, ratePerHourMinor: 100_000, billable: false })).toBe(0);
  });

  it("buckets WIP age on the documented boundaries", () => {
    expect(wipBucket(0)).toBe("0-30");
    expect(wipBucket(30)).toBe("0-30");
    expect(wipBucket(31)).toBe("31-60");
    expect(wipBucket(60)).toBe("31-60");
    expect(wipBucket(61)).toBe("61-90");
    expect(wipBucket(90)).toBe("61-90");
    expect(wipBucket(91)).toBe("90+");
  });
});

describe("practice economics summary", () => {
  const asOf = "2026-11-10";
  const entries = [
    // Unbilled, recent, ₹30/h for 2h = ₹60 = 6000 paise.
    {
      engagementId: "eng-a",
      engagementName: "Sharma Textiles",
      workDate: "2026-11-09",
      minutes: 120,
      ratePerHourMinor: 3_000,
      billable: true,
      invoiceId: null,
    },
    // Unbilled, 70 days old → the 61-90 bucket.
    {
      engagementId: "eng-a",
      engagementName: "Sharma Textiles",
      workDate: "2026-09-01",
      minutes: 60,
      ratePerHourMinor: 3_000,
      billable: true,
      invoiceId: null,
    },
    // Non-billable: recorded, never WIP.
    {
      engagementId: "eng-b",
      engagementName: "Patel Foods",
      workDate: "2026-11-01",
      minutes: 60,
      ratePerHourMinor: 3_000,
      billable: false,
      invoiceId: null,
    },
    // Billed: frozen into inv1, so not WIP.
    {
      engagementId: "eng-b",
      engagementName: "Patel Foods",
      workDate: "2026-10-01",
      minutes: 60,
      ratePerHourMinor: 3_000,
      billable: true,
      invoiceId: "inv1",
    },
  ];
  const invoices = [
    {
      id: "inv1",
      engagementId: "eng-b",
      number: "PI-1",
      subtotalMinor: 3_000,
      taxMinor: 540,
      totalMinor: 3_540,
      status: "issued",
      issuedOn: "2026-10-01",
      dueDate: "2026-10-15",
    },
    {
      id: "inv2",
      engagementId: "eng-a",
      number: "PI-2",
      subtotalMinor: 1_000,
      taxMinor: 180,
      totalMinor: 1_180,
      status: "paid",
      issuedOn: "2026-10-20",
      dueDate: "2026-11-04",
    },
    {
      id: "inv3",
      engagementId: "eng-a",
      number: "PI-3",
      subtotalMinor: 500,
      taxMinor: 0,
      totalMinor: 500,
      status: "void",
      issuedOn: "2026-10-25",
      dueDate: "2026-11-09",
    },
  ];

  it("counts only unbilled billable time as WIP", () => {
    const summary = summarisePracticeEconomics({ asOf, entries, invoices });
    expect(summary.totals.unbilledMinor).toBe(9_000);
    expect(summary.totals.unbilledMinutes).toBe(180);
  });

  it("ages unbilled time into the right buckets", () => {
    const summary = summarisePracticeEconomics({ asOf, entries, invoices });
    expect(summary.aging).toEqual([
      { bucket: "0-30", unbilledMinor: 6_000, minutes: 120 },
      { bucket: "31-60", unbilledMinor: 0, minutes: 0 },
      { bucket: "61-90", unbilledMinor: 3_000, minutes: 60 },
      { bucket: "90+", unbilledMinor: 0, minutes: 0 },
    ]);
  });

  it("reports invoiced, outstanding and overdue money without double counting", () => {
    const summary = summarisePracticeEconomics({ asOf, entries, invoices });
    // Void invoices never count as revenue.
    expect(summary.totals.invoicedMinor).toBe(4_720);
    // Only issued invoices are outstanding.
    expect(summary.totals.outstandingMinor).toBe(3_540);
    expect(summary.totals.overdueInvoiceMinor).toBe(3_540);
  });

  it("attributes unbilled WIP to the client that did the work", () => {
    const summary = summarisePracticeEconomics({ asOf, entries, invoices });
    const sharma = summary.clients.find((client) => client.engagementId === "eng-a");
    const patel = summary.clients.find((client) => client.engagementId === "eng-b");
    expect(sharma?.unbilledMinor).toBe(9_000);
    expect(patel?.unbilledMinor).toBe(0);
    expect(patel?.outstandingMinor).toBe(3_540);
    expect(patel?.overdueMinor).toBe(3_540);
  });

  it("reports days overdue on issued invoices only", () => {
    const summary = summarisePracticeEconomics({ asOf, entries, invoices });
    const overdue = summary.invoices.find((invoice) => invoice.id === "inv1");
    const paid = summary.invoices.find((invoice) => invoice.id === "inv2");
    expect(overdue?.daysOverdue).toBe(26);
    expect(paid?.daysOverdue).toBe(0);
  });
});
