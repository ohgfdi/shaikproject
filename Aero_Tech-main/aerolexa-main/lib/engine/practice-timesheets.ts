/**
 * Timesheets, WIP and billing engine — the commercial side of a CA practice.
 *
 * What it actually does: summarises time records into staff utilisation and
 * engagement WIP, ages unbilled work, and builds a GST tax invoice for an
 * engagement's billable time (fee → discount → CGST/SGST or IGST → the client's
 * s.194J deduction → net receivable).
 *
 * SCOPE AND HONESTY: arithmetic on caller-supplied hours, rates and dates. The
 * GST rate, the place-of-supply split and the s.194J rate are DEFAULTS the
 * caller may override — the engine does not decide whether a service is
 * taxable, exempt or a composite supply, and it does not file anything.
 *
 * All amounts are in MINOR UNITS (paise) as integers. Hours are decimal hours.
 */

export class TimesheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimesheetError";
  }
}

export interface TimesheetEntry {
  id: string;
  staffId: string;
  staffName: string;
  /** Engagement this time belongs to. */
  engagementId: string;
  clientName: string;
  /** yyyy-mm-dd. */
  date: string;
  hours: number;
  billable: boolean;
  /** The rate the engagement carries for this person, minor units per hour. */
  ratePerHourMinor: number;
  notes?: string | null;
}

function assertIso(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TimesheetError(`${field} must be yyyy-mm-dd, received "${value}".`);
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t)) throw new TimesheetError(`Unparseable ${field} "${value}".`);
  return t;
}

const DAY_MS = 86_400_000;

function addDays(iso: string, days: number): string {
  return new Date(assertIso(iso, "date") + days * DAY_MS).toISOString().slice(0, 10);
}

/** Days from `fromIso` to `toIso`, positive when `to` is later. */
export function daysElapsed(fromIso: string, toIso: string): number {
  return Math.round((assertIso(toIso, "asOf") - assertIso(fromIso, "date")) / DAY_MS);
}

/** Value of an entry: hours × rate, rounded to the nearest paise. */
export function entryValueMinor(entry: Pick<TimesheetEntry, "hours" | "ratePerHourMinor" | "billable">): number {
  if (!entry.billable) return 0;
  if (entry.hours < 0) throw new TimesheetError("hours must not be negative.");
  return Math.round(entry.hours * entry.ratePerHourMinor);
}

export interface StaffSummary {
  staffId: string;
  staffName: string;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  /** Billable ÷ total, as a percentage rounded to 1 dp. */
  utilisationPct: number;
  wipValueMinor: number;
  belowTarget: boolean;
}

export interface EngagementSummary {
  engagementId: string;
  clientName: string;
  totalHours: number;
  billableHours: number;
  wipValueMinor: number;
  budgetHours: number | null;
  budgetUsedPct: number | null;
  overBudget: boolean;
}

export interface WipAgeingBucket {
  bucket: "0-30" | "31-60" | "61-90" | "over-90";
  hours: number;
  valueMinor: number;
}

export interface TimesheetSummary {
  byStaff: StaffSummary[];
  byEngagement: EngagementSummary[];
  totals: {
    entries: number;
    totalHours: number;
    billableHours: number;
    nonBillableHours: number;
    utilisationPct: number;
    wipValueMinor: number;
  };
  /** Staff whose utilisation is under the practice target. */
  belowTarget: string[];
  wipAgeing: WipAgeingBucket[];
  oldestUnbilledDate: string | null;
  methodology: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Summarise time records into utilisation, WIP and ageing. */
export function buildTimesheetSummary(input: {
  entries: TimesheetEntry[];
  budgets?: Record<string, number>;
  /** Practice utilisation target, percent. */
  targetUtilisationPct?: number;
  /** Age unbilled time as at this date (defaults to the latest entry date). */
  asOfDate?: string;
}): TimesheetSummary {
  const target = input.targetUtilisationPct ?? 70;
  const staff = new Map<string, StaffSummary>();
  const engagements = new Map<string, EngagementSummary>();
  const buckets: Record<WipAgeingBucket["bucket"], WipAgeingBucket> = {
    "0-30": { bucket: "0-30", hours: 0, valueMinor: 0 },
    "31-60": { bucket: "31-60", hours: 0, valueMinor: 0 },
    "61-90": { bucket: "61-90", hours: 0, valueMinor: 0 },
    "over-90": { bucket: "over-90", hours: 0, valueMinor: 0 },
  };

  let totalHours = 0;
  let billableHours = 0;
  let wipValueMinor = 0;
  let oldestUnbilledDate: string | null = null;

  const asOfDate =
    input.asOfDate ??
    [...input.entries]
      .map((e) => e.date)
      .sort()
      .pop() ??
    null;

  for (const entry of input.entries) {
    if (entry.hours < 0) throw new TimesheetError(`Entry ${entry.id}: hours must not be negative.`);
    assertIso(entry.date, `entry ${entry.id} date`);
    const value = entryValueMinor(entry);

    const s = staff.get(entry.staffId) ?? {
      staffId: entry.staffId,
      staffName: entry.staffName,
      totalHours: 0,
      billableHours: 0,
      nonBillableHours: 0,
      utilisationPct: 0,
      wipValueMinor: 0,
      belowTarget: false,
    };
    s.totalHours += entry.hours;
    if (entry.billable) {
      s.billableHours += entry.hours;
      s.wipValueMinor += value;
    } else {
      s.nonBillableHours += entry.hours;
    }
    staff.set(entry.staffId, s);

    const e = engagements.get(entry.engagementId) ?? {
      engagementId: entry.engagementId,
      clientName: entry.clientName,
      totalHours: 0,
      billableHours: 0,
      wipValueMinor: 0,
      budgetHours: input.budgets?.[entry.engagementId] ?? null,
      budgetUsedPct: null,
      overBudget: false,
    };
    e.totalHours += entry.hours;
    if (entry.billable) {
      e.billableHours += entry.hours;
      e.wipValueMinor += value;
    }
    engagements.set(entry.engagementId, e);

    totalHours += entry.hours;

    if (entry.billable) {
      billableHours += entry.hours;
      wipValueMinor += value;
      if (asOfDate) {
        const age = daysElapsed(entry.date, asOfDate);
        const bucket: WipAgeingBucket["bucket"] =
          age <= 30 ? "0-30" : age <= 60 ? "31-60" : age <= 90 ? "61-90" : "over-90";
        buckets[bucket].hours += entry.hours;
        buckets[bucket].valueMinor += value;
        if (oldestUnbilledDate === null || entry.date < oldestUnbilledDate) oldestUnbilledDate = entry.date;
      }
    }
  }

  const byStaff = Array.from(staff.values())
    .map((s) => ({
      ...s,
      utilisationPct: s.totalHours > 0 ? round1((s.billableHours / s.totalHours) * 100) : 0,
      belowTarget: false,
    }))
    .map((s) => ({ ...s, belowTarget: s.utilisationPct < target }))
    .sort((a, b) => a.staffId.localeCompare(b.staffId));

  const byEngagement = Array.from(engagements.values())
    .map((e) => ({
      ...e,
      budgetUsedPct: e.budgetHours && e.budgetHours > 0 ? round1((e.totalHours / e.budgetHours) * 100) : null,
      overBudget: e.budgetHours !== null && e.totalHours > e.budgetHours,
    }))
    .sort((a, b) => a.engagementId.localeCompare(b.engagementId));

  return {
    byStaff,
    byEngagement,
    totals: {
      entries: input.entries.length,
      totalHours,
      billableHours,
      nonBillableHours: totalHours - billableHours,
      utilisationPct: totalHours > 0 ? round1((billableHours / totalHours) * 100) : 0,
      wipValueMinor,
    },
    belowTarget: byStaff.filter((s) => s.belowTarget).map((s) => s.staffId),
    wipAgeing: [buckets["0-30"], buckets["31-60"], buckets["61-90"], buckets["over-90"]],
    oldestUnbilledDate,
    methodology: [
      "Value of billable time = hours × the engagement rate, rounded to the nearest paise per entry.",
      "Utilisation = billable hours ÷ total hours for the period, reported to 1 decimal place.",
      `A staff member is flagged below target when utilisation is under ${target}%.`,
      asOfDate
        ? `WIP aged as at ${asOfDate} in 30-day buckets from the date the time was recorded.`
        : "No unbilled date to age against.",
      "Budget usage compares recorded hours against the engagement's budgeted hours when one is supplied.",
    ],
  };
}

export interface InvoiceLineItem {
  description: string;
  hours: number;
  ratePerHourMinor: number;
  amountMinor: number;
}

export interface TaxInvoice {
  invoiceNumber: string;
  invoiceDate: string;
  supplierName: string;
  supplierGstin: string;
  clientName: string;
  clientGstin: string | null;
  placeOfSupplyStateCode: string;
  interState: boolean;
  lineItems: InvoiceLineItem[];
  subtotalMinor: number;
  discountPct: number;
  discountMinor: number;
  taxableValueMinor: number;
  gstRatePct: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
  tdsSection: string;
  tdsRatePct: number;
  tdsEstimatedMinor: number;
  netReceivableMinor: number;
  narrative: string[];
  methodology: string[];
}

/**
 * Build a GST tax invoice from an engagement's billable time.
 *
 * The intra-state / inter-state split is decided by comparing the supplier's
 * state code with the place of supply (not the client's billing address).
 */
export function buildTaxInvoice(input: {
  invoiceNumber: string;
  invoiceDate: string;
  supplierName: string;
  supplierGstin: string;
  supplierStateCode: string;
  clientName: string;
  clientGstin?: string | null;
  placeOfSupplyStateCode: string;
  entries: TimesheetEntry[];
  discountPct?: number;
  gstRatePct?: number;
  tdsSection?: string;
  tdsRatePct?: number;
  /** Time already billed on an earlier invoice against the same entries. */
  previouslyInvoicedMinor?: number;
}): TaxInvoice {
  assertIso(input.invoiceDate, "invoiceDate");
  if (!input.invoiceNumber.trim()) throw new TimesheetError("invoiceNumber is required.");
  const billable = input.entries.filter((e) => e.billable);
  if (!billable.length) throw new TimesheetError("An invoice needs at least one billable time entry.");

  // Group the billable time by description so the invoice reads as fee lines,
  // not as a dump of individual timesheet rows.
  const grouped = new Map<string, InvoiceLineItem>();
  for (const entry of billable) {
    const key = entry.notes?.trim() || entry.engagementId;
    const item = grouped.get(key) ?? {
      description: key,
      hours: 0,
      ratePerHourMinor: entry.ratePerHourMinor,
      amountMinor: 0,
    };
    item.hours += entry.hours;
    item.amountMinor += entryValueMinor(entry);
    grouped.set(key, item);
  }
  const lineItems = Array.from(grouped.values()).sort((a, b) => a.description.localeCompare(b.description));

  const subtotalMinor = lineItems.reduce((s, l) => s + l.amountMinor, 0);
  const discountPct = input.discountPct ?? 0;
  if (discountPct < 0 || discountPct > 100) throw new TimesheetError("discountPct must be between 0 and 100.");
  const discountMinor = Math.round((subtotalMinor * discountPct) / 100);
  const grossFeeMinor = subtotalMinor - discountMinor;
  const previouslyInvoicedMinor = input.previouslyInvoicedMinor ?? 0;
  const taxableValueMinor = grossFeeMinor - previouslyInvoicedMinor;
  if (taxableValueMinor < 0) {
    throw new TimesheetError("previouslyInvoicedMinor exceeds the fee for these entries — check the billing history.");
  }

  const gstRatePct = input.gstRatePct ?? 18;
  const interState = input.supplierStateCode.trim() !== input.placeOfSupplyStateCode.trim();
  const taxMinor = Math.round((taxableValueMinor * gstRatePct) / 100);
  const cgstMinor = interState ? 0 : Math.round(taxMinor / 2);
  const sgstMinor = interState ? 0 : taxMinor - cgstMinor; // keep the halves additive to the paise
  const igstMinor = interState ? taxMinor : 0;
  const totalMinor = taxableValueMinor + cgstMinor + sgstMinor + igstMinor;

  const tdsSection = input.tdsSection ?? "194J";
  const tdsRatePct = input.tdsRatePct ?? 10;
  const tdsEstimatedMinor = Math.round((taxableValueMinor * tdsRatePct) / 100);
  const netReceivableMinor = totalMinor - tdsEstimatedMinor;

  return {
    invoiceNumber: input.invoiceNumber,
    invoiceDate: input.invoiceDate,
    supplierName: input.supplierName,
    supplierGstin: input.supplierGstin,
    clientName: input.clientName,
    clientGstin: input.clientGstin ?? null,
    placeOfSupplyStateCode: input.placeOfSupplyStateCode,
    interState,
    lineItems,
    subtotalMinor,
    discountPct,
    discountMinor,
    taxableValueMinor,
    gstRatePct,
    cgstMinor,
    sgstMinor,
    igstMinor,
    totalMinor,
    tdsSection,
    tdsRatePct,
    tdsEstimatedMinor,
    netReceivableMinor,
    narrative: [
      `Professional fees for the period to ${input.invoiceDate}`,
      previouslyInvoicedMinor > 0 ? `Net of ₹${previouslyInvoicedMinor / 100} already billed on earlier invoices.` : "",
      interState
        ? `Inter-state supply (supplier ${input.supplierStateCode} → place of supply ${input.placeOfSupplyStateCode}): IGST at ${gstRatePct}%.`
        : `Intra-state supply to ${input.placeOfSupplyStateCode}: CGST + SGST at ${gstRatePct}% (${gstRatePct / 2}% + ${gstRatePct / 2}%).`,
      `TDS u/s ${tdsSection} at ${tdsRatePct}% may be deducted by the client on the professional fee.`,
    ].filter(Boolean),
    methodology: [
      "Fee value per line = hours × rate, rounded per timesheet entry before grouping.",
      "Taxable value = subtotal − discount − time already invoiced.",
      "Place of supply compared with the supplier's state code decides CGST+SGST vs IGST.",
      `TDS is estimated at ${tdsRatePct}% u/s ${tdsSection} on the taxable fee; net receivable = invoice total − estimated TDS.`,
      "Rates and the TDS section are caller-supplied defaults, not a determination of taxability.",
    ],
  };
}

/**
 * Effective realisation: what a fee was billed at against the standard rate.
 */
export function realisationPct(standardValueMinor: number, billedValueMinor: number): number {
  if (standardValueMinor <= 0) throw new TimesheetError("standardValueMinor must be positive.");
  return round1((billedValueMinor / standardValueMinor) * 100);
}

/** Date an invoice falls due, given the credit period the engagement allows. */
export function invoiceDueDate(invoiceDate: string, creditDays: number): string {
  if (creditDays < 0) throw new TimesheetError("creditDays must not be negative.");
  return addDays(invoiceDate, creditDays);
}
