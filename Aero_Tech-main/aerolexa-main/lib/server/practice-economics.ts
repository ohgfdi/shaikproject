/**
 * Practice economics — billable time, WIP and client invoices.
 *
 * The firm already knows what work exists (filing runs, document requests);
 * this module records what that work is worth and what has actually been
 * collected. Three rules keep it honest:
 *
 *  - Time is valued in paise at the rate recorded on the entry. A later rate
 *    change never rewrites an earlier hour.
 *  - An invoice freezes the entries it bills (`invoiceId`), so WIP and invoiced
 *    work can never be double-counted.
 *  - "Outstanding" is issued invoices only, and "collected" is paid invoices
 *    only. Marking an invoice paid is the only thing that moves money between
 *    them — there is no derived figure that pretends it was paid.
 *  - The summary maths is a pure function (`summarisePracticeEconomics`) and is
 *    oracle-tested without a database.
 */

import { randomBytes } from "node:crypto";

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { requireEngagementRole } from "@/lib/server/engagement";
import { requireOrgRole } from "@/lib/server/members";

const DAY_MS = 86_400_000;

export type WipBucket = "0-30" | "31-60" | "61-90" | "90+";
export type InvoiceAgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export interface EconomicsEntry {
  engagementId: string;
  engagementName: string;
  workDate: string;
  minutes: number;
  ratePerHourMinor: number;
  billable: boolean;
  invoiceId: string | null;
}

export interface EconomicsInvoice {
  id: string;
  engagementId: string;
  number: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  status: string;
  issuedOn: string;
  dueDate: string;
  /** Set when the invoice was settled; null for issued/void rows. */
  paidOn?: string | null;
  paymentReference?: string | null;
  paymentMethod?: string | null;
}

export interface ClientEconomics {
  engagementId: string;
  engagementName: string;
  unbilledMinor: number;
  unbilledMinutes: number;
  invoicedMinor: number;
  collectedMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
}

export interface InvoiceAgingRow {
  bucket: InvoiceAgingBucket;
  invoices: number;
  outstandingMinor: number;
}

export interface PracticeEconomics {
  asOf: string;
  totals: {
    clients: number;
    unbilledMinor: number;
    unbilledMinutes: number;
    invoicedMinor: number;
    collectedMinor: number;
    voidedMinor: number;
    outstandingMinor: number;
    overdueInvoiceMinor: number;
  };
  aging: { bucket: WipBucket; unbilledMinor: number; minutes: number }[];
  invoiceAging: InvoiceAgingRow[];
  clients: ClientEconomics[];
  invoices: (EconomicsInvoice & { engagementName: string; daysOverdue: number })[];
}

/** Value of an entry in paise: minutes × hourly rate ÷ 60, rounded once. */
export function entryValueMinor(entry: Pick<EconomicsEntry, "minutes" | "ratePerHourMinor" | "billable">): number {
  if (!entry.billable) return 0;
  return Math.round((entry.minutes * entry.ratePerHourMinor) / 60);
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / DAY_MS);
}

/** WIP age bucket: how long an unbilled hour has been sitting there. */
export function wipBucket(daysOld: number): WipBucket {
  if (daysOld <= 30) return "0-30";
  if (daysOld <= 60) return "31-60";
  if (daysOld <= 90) return "61-90";
  return "90+";
}

/**
 * How late an issued invoice is. A `paid` invoice is never late — its lateness
 * is history, and the money has already moved. A void invoice is never late
 * either: it was withdrawn, not owed.
 */
export function invoiceDaysOverdue(invoice: Pick<EconomicsInvoice, "status" | "dueDate">, asOf: string): number {
  if (invoice.status !== "issued") return 0;
  return Math.max(0, daysBetween(invoice.dueDate, asOf));
}

/** Receivables bucket. Not-yet-due is `current`, then days past due. */
export function invoiceAgingBucket(daysOverdue: number): InvoiceAgingBucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "1-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "90+";
}

/**
 * Everything the partner needs about unbilled work, receivables and collected
 * money, computed from rows the caller already loaded. No percentages are
 * invented: realisation is reported as paise in vs paise out, not a made-up
 * utilisation figure.
 */
export function summarisePracticeEconomics(input: {
  asOf: string;
  entries: EconomicsEntry[];
  invoices: EconomicsInvoice[];
}): PracticeEconomics {
  const { asOf, entries, invoices } = input;
  const unbilled = entries.filter((entry) => entry.invoiceId === null && entry.billable);
  const byEngagement = new Map<string, ClientEconomics>();

  const rowFor = (engagementId: string, engagementName: string): ClientEconomics => {
    let row = byEngagement.get(engagementId);
    if (!row) {
      row = {
        engagementId,
        engagementName,
        unbilledMinor: 0,
        unbilledMinutes: 0,
        invoicedMinor: 0,
        collectedMinor: 0,
        outstandingMinor: 0,
        overdueMinor: 0,
      };
      byEngagement.set(engagementId, row);
    }
    return row;
  };

  for (const entry of unbilled) {
    const row = rowFor(entry.engagementId, entry.engagementName);
    row.unbilledMinor += entryValueMinor(entry);
    row.unbilledMinutes += entry.minutes;
  }
  for (const invoice of invoices) {
    const row = rowFor(invoice.engagementId, "");
    if (invoice.status === "void") continue;
    row.invoicedMinor += invoice.totalMinor;
    if (invoice.status === "paid") row.collectedMinor += invoice.totalMinor;
    if (invoice.status === "issued") {
      row.outstandingMinor += invoice.totalMinor;
      if (invoice.dueDate < asOf) row.overdueMinor += invoice.totalMinor;
    }
  }
  for (const entry of entries) {
    if (entry.invoiceId === null) continue;
    const row = byEngagement.get(entry.engagementId);
    if (row && !row.engagementName) row.engagementName = entry.engagementName;
  }
  for (const invoice of invoices) {
    const row = byEngagement.get(invoice.engagementId);
    if (row && !row.engagementName) row.engagementName = invoice.engagementId;
  }

  const buckets: WipBucket[] = ["0-30", "31-60", "61-90", "90+"];
  const aging = buckets.map((bucket) => {
    const inBucket = unbilled.filter((entry) => wipBucket(daysBetween(entry.workDate, asOf)) === bucket);
    return {
      bucket,
      unbilledMinor: inBucket.reduce((sum, entry) => sum + entryValueMinor(entry), 0),
      minutes: inBucket.reduce((sum, entry) => sum + entry.minutes, 0),
    };
  });

  const issued = invoices.filter((invoice) => invoice.status === "issued");
  const agingBuckets: InvoiceAgingBucket[] = ["current", "1-30", "31-60", "61-90", "90+"];
  const invoiceAging: InvoiceAgingRow[] = agingBuckets.map((bucket) => {
    const inBucket = issued.filter(
      (invoice) => invoiceAgingBucket(invoiceDaysOverdue(invoice, asOf)) === bucket,
    );
    return {
      bucket,
      invoices: inBucket.length,
      outstandingMinor: inBucket.reduce((sum, invoice) => sum + invoice.totalMinor, 0),
    };
  });

  const clients = [...byEngagement.values()].sort(
    (a, b) => b.unbilledMinor - a.unbilledMinor || a.engagementName.localeCompare(b.engagementName),
  );

  return {
    asOf,
    totals: {
      clients: clients.length,
      unbilledMinor: unbilled.reduce((sum, entry) => sum + entryValueMinor(entry), 0),
      unbilledMinutes: unbilled.reduce((sum, entry) => sum + entry.minutes, 0),
      invoicedMinor: invoices
        .filter((invoice) => invoice.status !== "void")
        .reduce((sum, invoice) => sum + invoice.totalMinor, 0),
      collectedMinor: invoices
        .filter((invoice) => invoice.status === "paid")
        .reduce((sum, invoice) => sum + invoice.totalMinor, 0),
      voidedMinor: invoices
        .filter((invoice) => invoice.status === "void")
        .reduce((sum, invoice) => sum + invoice.totalMinor, 0),
      outstandingMinor: issued.reduce((sum, invoice) => sum + invoice.totalMinor, 0),
      overdueInvoiceMinor: issued
        .filter((invoice) => invoice.dueDate < asOf)
        .reduce((sum, invoice) => sum + invoice.totalMinor, 0),
    },
    aging,
    invoiceAging,
    clients,
    invoices: invoices.map((invoice) => ({
      ...invoice,
      engagementName: clients.find((client) => client.engagementId === invoice.engagementId)?.engagementName ?? "",
      daysOverdue: invoiceDaysOverdue(invoice, asOf),
    })),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function requireOrganization(ctx: AuthContext): string {
  if (!ctx.organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  return ctx.organization.id;
}

function assertIsoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw new ApiError(400, "VALIDATION", `${field} must be a yyyy-mm-dd date.`);
  }
  return value;
}

export interface TimeEntryInput {
  engagementId: string;
  taskId?: string | null;
  workDate: string;
  minutes: number;
  ratePerHourMinor: number;
  billable?: boolean;
  narrative?: string | null;
}

/** Log one piece of billable (or non-billable) work against a client. */
export async function logTimeEntry(ctx: AuthContext, input: TimeEntryInput) {
  const organizationId = requireOrganization(ctx);
  const { engagement } = await requireEngagementRole(ctx, input.engagementId, "ASSISTANT");
  if (engagement.organizationId !== organizationId) {
    throw new ApiError(404, "NOT_FOUND", "Engagement not found.");
  }

  const workDate = assertIsoDate(input.workDate, "workDate");
  const minutes = Math.trunc(input.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
    throw new ApiError(400, "VALIDATION", "Minutes must be between 1 and 1440.");
  }
  const rate = Math.trunc(input.ratePerHourMinor);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100_000_000) {
    throw new ApiError(400, "VALIDATION", "The hourly rate must be a non-negative amount in paise.");
  }

  const entry = await prisma.practiceTimeEntry.create({
    data: {
      organizationId,
      engagementId: engagement.id,
      taskId: input.taskId?.trim() || null,
      userId: ctx.user.id,
      workDate,
      minutes,
      ratePerHourMinor: rate,
      billable: input.billable ?? true,
      narrative: input.narrative?.trim().slice(0, 1000) || null,
    },
  });

  await logActivity(ctx, "PRACTICE_TIME_LOGGED", `Logged ${minutes} min on ${engagement.name}`, null, {
    engagementId: engagement.id,
    entryId: entry.id,
  });
  return entry;
}

/** The current economics view for the organization. */
export async function getPracticeEconomics(
  ctx: AuthContext,
  opts: { asOf?: string } = {},
): Promise<PracticeEconomics> {
  const organizationId = requireOrganization(ctx);
  await requireOrgRole(ctx, organizationId, "MEMBER");

  const asOf = opts.asOf && /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf) ? opts.asOf : new Date().toISOString().slice(0, 10);

  const [entries, invoices] = await Promise.all([
    prisma.practiceTimeEntry.findMany({
      where: { organizationId },
      select: {
        engagementId: true,
        workDate: true,
        minutes: true,
        ratePerHourMinor: true,
        billable: true,
        invoiceId: true,
        engagement: { select: { name: true } },
      },
      take: 20_000,
    }),
    prisma.practiceInvoice.findMany({
      where: { organizationId },
      select: {
        id: true,
        engagementId: true,
        number: true,
        subtotalMinor: true,
        taxMinor: true,
        totalMinor: true,
        status: true,
        issuedOn: true,
        dueDate: true,
        paidOn: true,
        paymentReference: true,
        paymentMethod: true,
      },
      orderBy: { issuedOn: "desc" },
      take: 500,
    }),
  ]);

  return summarisePracticeEconomics({
    asOf,
    entries: entries.map((entry) => ({
      engagementId: entry.engagementId,
      engagementName: entry.engagement.name,
      workDate: entry.workDate,
      minutes: entry.minutes,
      ratePerHourMinor: entry.ratePerHourMinor,
      billable: entry.billable,
      invoiceId: entry.invoiceId,
    })),
    invoices,
  });
}

export interface InvoiceInput {
  engagementId: string;
  issuedOn?: string;
  creditDays?: number;
  gstRatePct?: number;
  notes?: string | null;
}

/** Freeze every unbilled billable hour for one client into an invoice. */
export async function issuePracticeInvoice(ctx: AuthContext, input: InvoiceInput) {
  const organizationId = requireOrganization(ctx);
  const { engagement } = await requireEngagementRole(ctx, input.engagementId, "MANAGER");
  if (engagement.organizationId !== organizationId) {
    throw new ApiError(404, "NOT_FOUND", "Engagement not found.");
  }

  const issuedOn = assertIsoDate(input.issuedOn ?? new Date().toISOString().slice(0, 10), "issuedOn");
  const creditDays = Math.min(Math.max(Math.trunc(input.creditDays ?? 15), 0), 180);
  const gstRatePct = Math.min(Math.max(Number(input.gstRatePct ?? 18), 0), 28);

  const entries = await prisma.practiceTimeEntry.findMany({
    where: { organizationId, engagementId: engagement.id, invoiceId: null, billable: true },
    select: { id: true, minutes: true, ratePerHourMinor: true, billable: true },
    take: 20_000,
  });
  const subtotalMinor = entries.reduce((sum, entry) => sum + entryValueMinor(entry), 0);
  if (entries.length === 0 || subtotalMinor <= 0) {
    throw new ApiError(400, "NO_UNBILLED_TIME", "There is no unbilled billable time for this client.");
  }

  const taxMinor = Math.round((subtotalMinor * gstRatePct) / 100);
  const dueDate = new Date(Date.parse(`${issuedOn}T00:00:00Z`) + creditDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const number = `PI-${issuedOn.replace(/-/g, "")}-${randomBytes(3).toString("hex").toUpperCase()}`;

  const invoice = await prisma.$transaction(async (tx) => {
    const created = await tx.practiceInvoice.create({
      data: {
        organizationId,
        engagementId: engagement.id,
        number,
        subtotalMinor,
        taxMinor,
        totalMinor: subtotalMinor + taxMinor,
        issuedOn,
        dueDate,
        notes: input.notes?.trim().slice(0, 1000) || `GST at ${gstRatePct}% · ${entries.length} time entries`,
        createdById: ctx.user.id,
      },
    });
    await tx.practiceTimeEntry.updateMany({
      where: { id: { in: entries.map((entry) => entry.id) }, invoiceId: null },
      data: { invoiceId: created.id },
    });
    return created;
  });

  await logActivity(
    ctx,
    "PRACTICE_INVOICE_ISSUED",
    `Raised ${invoice.number} for ${engagement.name} (₹${(invoice.totalMinor / 100).toFixed(2)})`,
    null,
    { engagementId: engagement.id, invoiceId: invoice.id },
  );
  return invoice;
}

async function requireInvoice(ctx: AuthContext, invoiceId: string) {
  const organizationId = requireOrganization(ctx);
  const invoice = await prisma.practiceInvoice.findFirst({
    where: { id: invoiceId, organizationId },
    include: { engagement: { select: { id: true, name: true, organizationId: true } } },
  });
  if (!invoice) throw new ApiError(404, "NOT_FOUND", "Client invoice not found.");
  await requireEngagementRole(ctx, invoice.engagementId, "MANAGER");
  return invoice;
}

export interface MarkPaidInput {
  paidOn?: string;
  reference: string;
  method?: string;
}

/**
 * Record that the client paid. This is the only transition into `paid`, so
 * outstanding can actually fall. The reference is mandatory: an invoice marked
 * paid without a payment reference is an unverifiable claim, not a receipt.
 */
export async function markPracticeInvoicePaid(ctx: AuthContext, invoiceId: string, input: MarkPaidInput) {
  const invoice = await requireInvoice(ctx, invoiceId);
  if (invoice.status === "paid") {
    if (!input.reference || input.reference.trim() === invoice.paymentReference) return invoice;
    throw new ApiError(409, "ALREADY_PAID", "This invoice is already paid.");
  }
  if (invoice.status !== "issued") {
    throw new ApiError(409, "INVALID_TRANSITION", "Only an issued invoice can be marked paid.");
  }
  const reference = input.reference?.trim();
  if (!reference || reference.length < 3) {
    throw new ApiError(400, "VALIDATION", "Record the payment reference (UTR, cheque or Razorpay payment id).");
  }
  const paidOn = assertIsoDate(input.paidOn ?? new Date().toISOString().slice(0, 10), "paidOn");
  if (paidOn < invoice.issuedOn) {
    throw new ApiError(400, "VALIDATION", "The payment date cannot be before the invoice date.");
  }
  const method = (input.method?.trim() || "manual").slice(0, 40);

  const updated = await prisma.practiceInvoice.update({
    where: { id: invoice.id },
    data: {
      status: "paid",
      paidOn,
      paymentReference: reference.slice(0, 120),
      paymentMethod: method,
      razorpayPaymentId: method === "razorpay" ? reference.slice(0, 120) : invoice.razorpayPaymentId,
    },
  });

  await logActivity(
    ctx,
    "PRACTICE_INVOICE_PAID",
    `${invoice.number} settled (${method}, ref ${reference.slice(0, 40)})`,
    null,
    { engagementId: invoice.engagementId, invoiceId: invoice.id, paidOn },
  );
  return updated;
}

/**
 * Withdraw an invoice that should never have been raised. Paid money cannot be
 * voided — it needs a credit note, which is a different record and deliberately
 * not implemented here.
 */
export async function voidPracticeInvoice(ctx: AuthContext, invoiceId: string, reason: string) {
  const invoice = await requireInvoice(ctx, invoiceId);
  if (invoice.status === "void") return invoice;
  if (invoice.status === "paid") {
    throw new ApiError(409, "ALREADY_PAID", "A paid invoice cannot be voided. Raise a credit note instead.");
  }
  const trimmed = reason?.trim();
  if (!trimmed || trimmed.length < 3) {
    throw new ApiError(400, "VALIDATION", "Say why the invoice is being voided.");
  }
  const voidedOn = new Date().toISOString().slice(0, 10);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.practiceInvoice.update({
      where: { id: invoice.id },
      data: { status: "void", voidedOn, voidReason: trimmed.slice(0, 500) },
    });
    // The time is billable again: a withdrawn invoice must not strand WIP.
    await tx.practiceTimeEntry.updateMany({
      where: { invoiceId: invoice.id },
      data: { invoiceId: null },
    });
    return row;
  });

  await logActivity(ctx, "PRACTICE_INVOICE_VOIDED", `${invoice.number} voided: ${trimmed.slice(0, 80)}`, null, {
    engagementId: invoice.engagementId,
    invoiceId: invoice.id,
  });
  return updated;
}
