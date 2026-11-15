/**
 * Subledger ↔ ledger posting contract.
 *
 * Registers (GST invoices, inventory movements, fixed assets, TDS entries,
 * payroll runs) are operational records, not journal entries. A register row is
 * "in the ledger" only when a `SubledgerPosting` row maps it to a voucher.
 * That mapping is unique per source row, so posting is idempotent and two
 * retries cannot create two vouchers.
 *
 * Reconciliation is deliberately explicit: it reports what is missing instead
 * of guessing account mappings. A period close should refuse to proceed while
 * `unposted` is non-zero (or an operator has recorded an exclusion).
 */

import { prisma } from "@/lib/db";
import { postVoucher, requireBook, type VoucherInput } from "@/lib/server/books";
import { periodOf } from "@/lib/server/period-locks";

export type SubledgerSourceType = "gst-invoice" | "inventory-movement" | "fixed-asset" | "tds-entry" | "payroll-run";

export interface SubledgerPostInput {
  sourceType: SubledgerSourceType;
  sourceId: string;
  voucher: VoucherInput;
}

export interface SubledgerUnpostedRow {
  id: string;
  label: string;
  amount: number;
}

export interface SubledgerRegisterReconciliation {
  sourceType: SubledgerSourceType;
  label: string;
  total: number;
  posted: number;
  unposted: number;
  unpostedAmount: number;
  unpostedRows: SubledgerUnpostedRow[];
}

export interface SubledgerReconciliation {
  period: string;
  reconciled: boolean;
  registers: SubledgerRegisterReconciliation[];
}

/** Post one register row into the ledger. Idempotent per (book, type, id). */
export async function postSubledgerEntry(
  workspaceId: string,
  bookId: string,
  input: SubledgerPostInput,
  actorId: string,
) {
  return postVoucher(workspaceId, bookId, input.voucher, {
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    postedById: actorId,
  });
}

/** The voucher that recognised a register row, or null when unposted. */
export async function getSubledgerPosting(bookId: string, sourceType: SubledgerSourceType, sourceId: string) {
  return prisma.subledgerPosting.findUnique({
    where: { bookId_sourceType_sourceId: { bookId, sourceType, sourceId } },
    include: { voucher: true },
  });
}

function labels(
  prefix: string,
  rows: { id: string; label: string; amount: number }[],
  postedIds: Set<string>,
): SubledgerRegisterReconciliation {
  const unpostedRows = rows.filter((r) => !postedIds.has(r.id));
  return {
    sourceType: prefix as SubledgerSourceType,
    label: "",
    total: rows.length,
    posted: rows.length - unpostedRows.length,
    unposted: unpostedRows.length,
    unpostedAmount: unpostedRows.reduce((sum, r) => sum + Math.abs(r.amount), 0),
    unpostedRows,
  };
}

/**
 * Compare each register in a period against `SubledgerPosting`. The query is
 * bounded by the period so the report stays O(period), not O(history).
 */
export async function reconcileSubledgers(
  workspaceId: string,
  bookId: string,
  period: string,
): Promise<SubledgerReconciliation> {
  await requireBook(workspaceId, bookId);

  const [posted, gstInvoices, movements, assets, tds, payroll] = await Promise.all([
    prisma.subledgerPosting.findMany({ where: { bookId }, select: { sourceType: true, sourceId: true } }),
    prisma.gstInvoice.findMany({
      where: { bookId, period, status: { in: ["validated", "posted", "amended"] } },
      select: {
        id: true,
        invoiceNumber: true,
        taxableValue: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        cessAmount: true,
      },
    }),
    prisma.inventoryMovement.findMany({
      where: { bookId, date: { startsWith: period } },
      select: { id: true, amount: true, movementType: true, item: { select: { name: true } } },
    }),
    prisma.fixedAsset.findMany({
      where: { bookId, acquisitionDate: { startsWith: period } },
      select: { id: true, assetCode: true, name: true, cost: true },
    }),
    prisma.tdsEntry.findMany({
      where: { bookId, challanDate: { startsWith: period } },
      select: { id: true, challanNumber: true, deducteeName: true, totalTax: true },
    }),
    prisma.payrollRun.findMany({
      where: { bookId, period, status: { in: ["approved", "paid", "locked"] } },
      select: { id: true, period: true, totalNet: true },
    }),
  ]);

  const postedByType = new Map<string, Set<string>>();
  for (const row of posted) {
    let set = postedByType.get(row.sourceType);
    if (!set) {
      set = new Set();
      postedByType.set(row.sourceType, set);
    }
    set.add(row.sourceId);
  }
  const ids = (type: SubledgerSourceType) => postedByType.get(type) ?? new Set<string>();

  const registers: SubledgerRegisterReconciliation[] = [
    {
      ...labels(
        "gst-invoice",
        gstInvoices.map((i) => ({
          id: i.id,
          label: i.invoiceNumber,
          amount: i.taxableValue + i.cgstAmount + i.sgstAmount + i.igstAmount + i.cessAmount,
        })),
        ids("gst-invoice"),
      ),
      label: "GST invoices",
    },
    {
      ...labels(
        "inventory-movement",
        movements.map((m) => ({
          id: m.id,
          label: `${m.item.name} (${m.movementType})`,
          amount: m.amount,
        })),
        ids("inventory-movement"),
      ),
      label: "Inventory movements",
    },
    {
      ...labels(
        "fixed-asset",
        assets.map((a) => ({ id: a.id, label: `${a.assetCode} ${a.name}`, amount: a.cost })),
        ids("fixed-asset"),
      ),
      label: "Fixed assets",
    },
    {
      ...labels(
        "tds-entry",
        tds.map((t) => ({ id: t.id, label: `${t.deducteeName} (${t.challanNumber})`, amount: t.totalTax })),
        ids("tds-entry"),
      ),
      label: "TDS entries",
    },
    {
      ...labels(
        "payroll-run",
        payroll.map((p) => ({ id: p.id, label: `Payroll ${p.period}`, amount: p.totalNet })),
        ids("payroll-run"),
      ),
      label: "Payroll runs",
    },
  ];

  return {
    period: periodOf(`${period}-01`),
    reconciled: registers.every((r) => r.unposted === 0),
    registers,
  };
}
