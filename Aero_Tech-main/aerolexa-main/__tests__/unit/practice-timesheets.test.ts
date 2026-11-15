/**
 * Timesheets / WIP / billing engine — oracle tests.
 *
 * Money is integer paise; hours are decimal hours. Every figure below is
 * hand-computed: ₹1,00,000 = 10,000,000 paise.
 */

import {
  buildTaxInvoice,
  buildTimesheetSummary,
  daysElapsed,
  entryValueMinor,
  invoiceDueDate,
  realisationPct,
  type TimesheetEntry,
} from "@/lib/engine/practice-timesheets";

const p = (rupees: number) => rupees * 100;

function entry(over: Partial<TimesheetEntry> & Pick<TimesheetEntry, "id">): TimesheetEntry {
  return {
    staffId: "S1",
    staffName: "R. Iyer",
    engagementId: "ENG-1",
    clientName: "Sharma Textiles Pvt Ltd",
    date: "2025-06-01",
    hours: 1,
    billable: true,
    ratePerHourMinor: p(2_000),
    notes: null,
    ...over,
  };
}

describe("entryValueMinor", () => {
  it("values billable time at hours × rate, rounding to the paise", () => {
    expect(entryValueMinor({ hours: 10, ratePerHourMinor: p(2_000), billable: true })).toBe(p(20_000));
    expect(entryValueMinor({ hours: 1.5, ratePerHourMinor: p(1_000), billable: true })).toBe(p(1_500));
  });

  it("values non-billable time at zero", () => {
    expect(entryValueMinor({ hours: 8, ratePerHourMinor: p(2_000), billable: false })).toBe(0);
  });

  it("refuses negative hours", () => {
    expect(() => entryValueMinor({ hours: -1, ratePerHourMinor: p(1_000), billable: true })).toThrow(/negative/);
  });
});

describe("buildTimesheetSummary", () => {
  const entries: TimesheetEntry[] = [
    entry({ id: "T1", staffId: "S1", staffName: "R. Iyer", hours: 10, date: "2025-06-01", notes: "Statutory audit" }),
    entry({ id: "T2", staffId: "S1", staffName: "R. Iyer", hours: 5, date: "2025-06-05", notes: "Statutory audit" }),
    entry({
      id: "T3",
      staffId: "S1",
      staffName: "R. Iyer",
      hours: 3,
      date: "2025-06-06",
      billable: false,
      notes: "Admin",
    }),
    entry({
      id: "T4",
      staffId: "S2",
      staffName: "A. Rao",
      hours: 8,
      date: "2025-04-15",
      billable: false,
      notes: "Training",
    }),
    entry({
      id: "T5",
      staffId: "S3",
      staffName: "N. Bose",
      hours: 4,
      date: "2025-01-10",
      ratePerHourMinor: p(3_000),
      notes: "Tax return prep",
    }),
  ];

  it("computes utilisation, WIP value and engagement totals", () => {
    const s = buildTimesheetSummary({ entries, asOfDate: "2025-06-30" });
    const iyer = s.byStaff.find((x) => x.staffId === "S1")!;
    expect(iyer.totalHours).toBe(18);
    expect(iyer.billableHours).toBe(15);
    expect(iyer.nonBillableHours).toBe(3);
    expect(iyer.utilisationPct).toBe(83.3); // 15 / 18
    expect(iyer.wipValueMinor).toBe(p(30_000)); // 15 h × ₹2,000

    expect(s.totals.totalHours).toBe(30);
    expect(s.totals.billableHours).toBe(19);
    expect(s.totals.nonBillableHours).toBe(11);
    expect(s.totals.utilisationPct).toBe(63.3); // 19 / 30
    expect(s.totals.wipValueMinor).toBe(p(42_000)); // ₹30,000 + 4 h × ₹3,000
  });

  it("flags staff under the practice utilisation target", () => {
    const s = buildTimesheetSummary({ entries, asOfDate: "2025-06-30" });
    // S1 83.3%, S2 0%, S3 100% — default target 70%.
    expect(s.belowTarget).toEqual(["S2"]);
    const s2 = buildTimesheetSummary({ entries, asOfDate: "2025-06-30", targetUtilisationPct: 90 });
    expect(s2.belowTarget.sort()).toEqual(["S1", "S2"]);
  });

  it("ages unbilled time into 30-day buckets", () => {
    const s = buildTimesheetSummary({ entries, asOfDate: "2025-06-30" });
    const bucket = (name: string) => s.wipAgeing.find((b) => b.bucket === name)!;
    expect(bucket("0-30").hours).toBe(15); // 2025-06-01 / -05
    expect(bucket("0-30").valueMinor).toBe(p(30_000));
    expect(bucket("61-90").hours).toBe(0);
    expect(bucket("over-90").hours).toBe(4); // 2025-01-10 → 171 days
    expect(bucket("over-90").valueMinor).toBe(p(12_000));
    expect(s.oldestUnbilledDate).toBe("2025-01-10");
    expect(daysElapsed("2025-06-01", "2025-06-30")).toBe(29);
  });

  it("reports budget usage per engagement and flags an overrun", () => {
    const s = buildTimesheetSummary({ entries, asOfDate: "2025-06-30", budgets: { "ENG-1": 20 } });
    const eng = s.byEngagement.find((e) => e.engagementId === "ENG-1")!;
    expect(eng.totalHours).toBe(30);
    expect(eng.budgetUsedPct).toBe(150);
    expect(eng.overBudget).toBe(true);
    const s2 = buildTimesheetSummary({ entries, asOfDate: "2025-06-30", budgets: { "ENG-1": 40 } });
    expect(s2.byEngagement.find((e) => e.engagementId === "ENG-1")!.overBudget).toBe(false);
  });

  it("rejects a malformed date and negative hours", () => {
    expect(() => buildTimesheetSummary({ entries: [entry({ id: "X", date: "01-06-2025" })] })).toThrow(/yyyy-mm-dd/);
    expect(() => buildTimesheetSummary({ entries: [entry({ id: "X", hours: -2 })] })).toThrow(/negative/);
  });
});

describe("buildTaxInvoice", () => {
  const entries: TimesheetEntry[] = [
    entry({ id: "T1", hours: 10, ratePerHourMinor: p(2_000), notes: "Audit fee" }),
    entry({ id: "T2", hours: 5, ratePerHourMinor: p(2_000), notes: "Audit fee" }),
    entry({ id: "T3", hours: 2, ratePerHourMinor: p(3_000), engagementId: "ENG-2", notes: "Tax return prep" }),
    entry({ id: "T4", hours: 3, ratePerHourMinor: p(2_000), billable: false, notes: "Admin" }),
  ];

  const base = {
    invoiceNumber: "INV/2025-26/014",
    invoiceDate: "2025-06-30",
    supplierName: "Iyer & Co., Chartered Accountants",
    supplierGstin: "27AAAAA0000A1Z5",
    supplierStateCode: "27",
    clientName: "Sharma Textiles Pvt Ltd",
    clientGstin: "27BBBBB1111B1Z5",
    placeOfSupplyStateCode: "27",
    entries,
  };

  it("groups billable time into fee lines and ignores non-billable time", () => {
    const inv = buildTaxInvoice(base);
    expect(inv.lineItems.map((l) => l.description)).toEqual(["Audit fee", "Tax return prep"]);
    expect(inv.lineItems[0]!.hours).toBe(15);
    expect(inv.lineItems[0]!.amountMinor).toBe(p(30_000));
    expect(inv.lineItems[1]!.amountMinor).toBe(p(6_000));
    expect(inv.subtotalMinor).toBe(p(36_000));
  });

  it("applies the discount, then splits an intra-state supply into CGST + SGST", () => {
    const inv = buildTaxInvoice({ ...base, discountPct: 10, previouslyInvoicedMinor: p(2_400) });
    expect(inv.discountMinor).toBe(p(3_600));
    expect(inv.taxableValueMinor).toBe(p(30_000)); // 36,000 − 3,600 − 2,400
    expect(inv.interState).toBe(false);
    expect(inv.gstRatePct).toBe(18);
    expect(inv.cgstMinor).toBe(p(2_700));
    expect(inv.sgstMinor).toBe(p(2_700));
    expect(inv.igstMinor).toBe(0);
    expect(inv.totalMinor).toBe(p(35_400));
    // CGST + SGST must always add back to the full tax.
    expect(inv.cgstMinor + inv.sgstMinor).toBe(p(5_400));
  });

  it("charges IGST when the place of supply is another state", () => {
    const inv = buildTaxInvoice({
      ...base,
      placeOfSupplyStateCode: "29",
      discountPct: 10,
      previouslyInvoicedMinor: p(2_400),
    });
    expect(inv.interState).toBe(true);
    expect(inv.igstMinor).toBe(p(5_400));
    expect(inv.cgstMinor).toBe(0);
    expect(inv.sgstMinor).toBe(0);
    expect(inv.totalMinor).toBe(p(35_400));
  });

  it("estimates the client's s.194J deduction and the net receivable", () => {
    const inv = buildTaxInvoice({ ...base, discountPct: 10, previouslyInvoicedMinor: p(2_400) });
    expect(inv.tdsSection).toBe("194J");
    expect(inv.tdsRatePct).toBe(10);
    expect(inv.tdsEstimatedMinor).toBe(p(3_000)); // 10% of the ₹30,000 taxable fee
    expect(inv.netReceivableMinor).toBe(p(32_400)); // 35,400 − 3,000
    expect(inv.narrative.join(" ")).toMatch(/194J/);
  });

  it("refuses an invoice with no billable time and a bad discount", () => {
    expect(() => buildTaxInvoice({ ...base, entries: [entry({ id: "X", billable: false })] })).toThrow(/billable/);
    expect(() => buildTaxInvoice({ ...base, discountPct: 120 })).toThrow(/discountPct/);
  });

  it("refuses a previously-invoiced amount larger than the fee", () => {
    expect(() => buildTaxInvoice({ ...base, previouslyInvoicedMinor: p(99_000) })).toThrow(/previouslyInvoicedMinor/);
  });
});

describe("realisation and due dates", () => {
  it("computes realisation against the standard rate", () => {
    expect(realisationPct(p(40_000), p(36_000))).toBe(90);
    expect(() => realisationPct(0, p(1_000))).toThrow(/positive/);
  });

  it("adds the credit period to the invoice date", () => {
    expect(invoiceDueDate("2025-06-30", 30)).toBe("2025-07-30");
    expect(invoiceDueDate("2025-12-15", 45)).toBe("2026-01-29");
    expect(() => invoiceDueDate("2025-06-30", -1)).toThrow(/negative/);
  });
});
