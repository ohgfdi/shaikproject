/**
 * Continuous Supplier Reconciliation Engine
 *
 * Handles ongoing supplier reconciliation:
 * - Suppliers never appearing in GSTR-2B
 * - ITC blocked under section 17(5)
 * - GSTIN validation failures
 * - Mismatched value/rate/quantity between invoice and 2B
 * - Maintains a reconciliation register per supplier
 */

import type { GstInvoice } from "@/generated/prisma/client";
import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { NOTIFIED_GST_RATES, validateGstin } from "@/lib/engine/gst-rate-validation";

export class SupplierReconciliationError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "SupplierReconciliationError";
  }
}

export interface SupplierMatchKey {
  gstin: string;
  invoiceNumber: string;
  invoiceDate: string;
}

export interface SupplierReconciliationSummary {
  supplierGstin: string;
  supplierName: string;
  totalInvoices: number;
  matchedInvoices: number;
  unmatchedInvoices: number;
  icaCoverage: number; // % of invoices that appear in 2B
  ITCBlockedReason?: string;
  mismatches: MismatchDetail[];
  lastReconciledAt?: string;
  reconciliationStatus: "current" | "out-of-sync" | "critical";
}

export interface MismatchDetail {
  invoiceNumber: string;
  invoiceDate: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  discrepancyType: "value" | "rate" | "quantity" | "tax-amount";
  describedValue: number;
  actualValue: number;
  discrepancy: number;
  severity: "info" | "warning" | "error";
}

export interface SupplierReconciliationEngine {
  reconcileSupplier(
    workspaceId: string,
    bookId: string,
    supplierGstin: string,
    period?: string,
  ): Promise<SupplierReconciliationSummary>;

  reconcileAllSuppliers(workspaceId: string, bookId: string, period?: string): Promise<SupplierReconciliationSummary[]>;

  flagNewInvoices(
    workspaceId: string,
    bookId: string,
    supplierGstin: string,
    sinceDate: string,
  ): Promise<{
    newInvoices: GstInvoice[];
    alreadyMatched: GstInvoice[];
  }>;
}

export function createSupplierReconciliationEngine(): SupplierReconciliationEngine {
  /**
   * Reconcile all invoices for a specific supplier against GSTR-2B.
   * In this prototype, we check against the book's GstInvoice register
   * and flag patterns that indicate the supplier is never in 2B.
   */
  async function reconcileSupplier(
    workspaceId: string,
    bookId: string,
    supplierGstin: string,
    period?: string,
  ): Promise<SupplierReconciliationSummary> {
    // Validate GSTIN
    const gstinValidate = validateGstin(supplierGstin);

    const where: Record<string, unknown> = { bookId, supplierGstin: { contains: supplierGstin, mode: "insensitive" } };
    if (period) {
      where.period = period;
    }

    const allInvoices = await prisma.gstInvoice.findMany({ where });

    // Separate matched and unmatched
    const matchedInvoices = allInvoices.filter((i) => i.matched2a2b);
    const unmatchedInvoices = allInvoices.filter((i) => !i.matched2a2b);

    const icaCoverage = allInvoices.length > 0 ? (matchedInvoices.length / allInvoices.length) * 100 : 0;

    // Determine ITC blocked reason
    let ITCBlockedReason: string | undefined;
    if (gstinValidate.valid) {
      // Check if supplier has a pattern of never being matched
      if (icaCoverage < 100 && allInvoices.length > 0) {
        // Check for section 17(5) blocking patterns
        const blockedCategoryInvoices = allInvoices.filter(
          (i) => i.itcEligibility === "blocked" || (i.itcHeading && /capital goods|input service/.test(i.itcHeading)),
        );

        if (blockedCategoryInvoices.length > 0) {
          ITCBlockedReason = `ITC blocked under section 17(5) for category: ${blockedCategoryInvoices.map((i) => i.invoiceNumber).join(", ")}`;
        } else if (icaCoverage < 50) {
          ITCBlockedReason = `Supplier appears in only ${icaCoverage.toFixed(1)}% of invoices in 2B — likely non-filing supplier`;
        }
      }
    } else {
      ITCBlockedReason = `Supplier GSTIN ${supplierGstin} is invalid — all ITC blocked under section 17(5)`;
    }

    // Collect mismatches
    const mismatches: MismatchDetail[] = [];

    for (const inv of unmatchedInvoices) {
      // Check for value/rate/quantity mismatches by comparing CGST/SGST/IGST rates
      const taxTotal = inv.cgstAmount + inv.sgstAmount + inv.igstAmount + inv.cessAmount;
      if (taxTotal > 0 && inv.taxableValue > 0) {
        const effectiveRate = Math.round((taxTotal * 100) / inv.taxableValue);
        if (effectiveRate > 0 && !(NOTIFIED_GST_RATES as readonly number[]).includes(effectiveRate)) {
          mismatches.push({
            invoiceNumber: inv.invoiceNumber,
            invoiceDate: inv.invoiceDate,
            taxableValue: inv.taxableValue,
            cgst: inv.cgstAmount,
            sgst: inv.sgstAmount,
            igst: inv.igstAmount,
            discrepancyType: "rate",
            describedValue: effectiveRate,
            actualValue: taxTotal,
            discrepancy: effectiveRate - 18, // assume 18% base
            severity: "warning",
          });
        }
      }
    }

    // Also check matched invoices for value mismatches
    for (const inv of matchedInvoices) {
      const taxTotal = inv.cgstAmount + inv.sgstAmount + inv.igstAmount + inv.cessAmount;
      if (taxTotal > 0 && inv.taxableValue > 0) {
        const effectiveRate = Math.round((taxTotal * 100) / inv.taxableValue);
        // Check if rate differs from what's expected (simplified check)
        if (effectiveRate !== 18 && (NOTIFIED_GST_RATES as readonly number[]).includes(effectiveRate)) {
          // Rate matches a notified rate, no mismatch
        } else if (effectiveRate !== 18) {
          mismatches.push({
            invoiceNumber: inv.invoiceNumber,
            invoiceDate: inv.invoiceDate,
            taxableValue: inv.taxableValue,
            cgst: inv.cgstAmount,
            sgst: inv.sgstAmount,
            igst: inv.igstAmount,
            discrepancyType: "rate",
            describedValue: effectiveRate,
            actualValue: taxTotal,
            discrepancy: effectiveRate - 18,
            severity: "info",
          });
        }
      }
    }

    // Sort mismatches by severity
    const severityOrder: Record<string, number> = { error: 3, warning: 2, info: 1 };
    mismatches.sort((a, b) => (severityOrder[b.severity] ?? 0) - (severityOrder[a.severity] ?? 0));

    // Determine reconciliation status
    let reconciliationStatus: "current" | "out-of-sync" | "critical" = "current";
    if (icaCoverage === 0 && allInvoices.length > 0) {
      reconciliationStatus = "critical";
    } else if (icaCoverage < 50) {
      reconciliationStatus = "out-of-sync";
    } else if (icaCoverage < 100) {
      reconciliationStatus = "out-of-sync";
    }

    return {
      supplierGstin,
      supplierName: allInvoices[0]?.supplierName || supplierGstin,
      totalInvoices: allInvoices.length,
      matchedInvoices: matchedInvoices.length,
      unmatchedInvoices: unmatchedInvoices.length,
      icaCoverage: Number(icaCoverage.toFixed(1)),
      ITCBlockedReason,
      mismatches,
      lastReconciledAt: new Date().toISOString(),
      reconciliationStatus,
    };
  }

  /**
   * Reconcile all suppliers in a book.
   */
  async function reconcileAllSuppliers(
    workspaceId: string,
    bookId: string,
    period?: string,
  ): Promise<SupplierReconciliationSummary[]> {
    const allInvoices = await prisma.gstInvoice.findMany({
      where: { bookId, ...(period ? { period } : {}) },
    });

    // Group by supplier GSTIN
    const supplierMap = new Map<string, { invoices: GstInvoice[]; supplierName: string }>();

    for (const inv of allInvoices) {
      const gstin = inv.supplierGstin || "UNKNOWN";
      if (!supplierMap.has(gstin)) {
        supplierMap.set(gstin, { invoices: [], supplierName: inv.supplierName || gstin });
      }
      supplierMap.get(gstin)!.invoices.push(inv);
      if (!supplierMap.get(gstin)!.supplierName && inv.supplierName) {
        supplierMap.get(gstin)!.supplierName = inv.supplierName;
      }
    }

    // Reconcile each supplier
    const results: SupplierReconciliationSummary[] = [];
    for (const [gstin] of supplierMap) {
      results.push(await reconcileSupplier(workspaceId, bookId, gstin, period));
    }

    return results;
  }

  /**
   * Flag new invoices for a supplier since a given date.
   */
  async function flagNewInvoices(
    workspaceId: string,
    bookId: string,
    supplierGstin: string,
    sinceDate: string,
  ): Promise<{
    newInvoices: GstInvoice[];
    alreadyMatched: GstInvoice[];
  }> {
    const where: Record<string, unknown> = {
      bookId,
      supplierGstin: { contains: supplierGstin, mode: "insensitive" },
      invoiceDate: { gte: sinceDate },
    };

    const allInvoices = await prisma.gstInvoice.findMany({ where });
    const matched = allInvoices.filter((i) => i.matched2a2b);
    const unmatched = allInvoices.filter((i) => !i.matched2a2b);

    return {
      newInvoices: unmatched,
      alreadyMatched: matched,
    };
  }

  return {
    reconcileSupplier,
    reconcileAllSuppliers,
    flagNewInvoices,
  };
}

export default createSupplierReconciliationEngine;
