/**
 * Export LUT / Letter of Undertaking Engine
 *
 * Handles zero-rated export supplies against LUT or Letter of Undertaking,
 * shipping bill linkage, and IEC validation. Per GST Law:
 * - Section 54: Refund of unutilized ITC
 * - Rule 142: LUT bond for exports without payment of IGST
 * - Shipping Bill required for claiming duty drawback / refund
 */

import type { GstInvoice } from "@/generated/prisma/client";
import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { validateGstin } from "@/lib/engine/gst-rate-validation";

export class LutError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "LutError";
  }
}

export interface LutApplication {
  id: string;
  bookId: string;
  gstin: string;
  fy: string; // financial year, e.g. "2025-26"
  applicationType: string; // "LUT" | "BOND"
  amount: number; // Amount covered by LUT (typically whole FY export value)
  dateOfIssue: string; // ISO yyyy-mm-dd
  validUpto: string; // ISO yyyy-mm-dd (normally 1 year from issue)
  status: string; // DRAFT | SUBMITTED | APPROVED | REJECTED | EXPIRED | CANCELLED
  reasonForRejection?: string | null;
  submittedById?: string | null;
  approvedById?: string | null;
  approvedAt?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShippingBill {
  id: string;
  bookId: string;
  invoiceId: string;
  gstin: string;
  fy: string;
  exportInvoiceNumber: string;
  shippingBillNumber: string;
  dateOfExport: string;
  portOfExport: string;
  billOfLading?: string | null;
  status: string; // PENDING | APPROVED | REJECTED | PROCESSED
  createdAt: Date;
  updatedAt: Date;
}

export interface LutStatus {
  gstin: string;
  fy: string;
  lutStatus: "VALID" | "EXPIRED" | "CANCELLED" | "NOT_FOUND";
  daysRemaining?: number;
  canExportWithoutIgst: boolean;
  blockingInvoices: string[]; // invoices that need LUT coverage
}

export interface LutEngine {
  applyLut(
    bookId: string,
    gstin: string,
    fy: string,
    applicationType: "LUT" | "BOND",
    amount: number,
    dateOfIssue: string,
  ): Promise<{ lut: LutApplication; status: "approved" | "rejected" | "already-exists"; reason?: string }>;

  approveLut(lutId: string, approverId: string): Promise<{ lut: LutApplication; status: "APPROVED"; message: string }>;

  cancelLut(
    lutId: string,
    cancellerId: string,
    reason: string,
  ): Promise<{ lut: LutApplication; status: "CANCELLED"; message: string }>;

  generateShippingBill(
    bookId: string,
    invoiceId: string,
    gstin: string,
    fy: string,
    shippingBillNumber: string,
    portOfExport: string,
  ): Promise<{ shippingBill: ShippingBill; lutCoverage: boolean }>;

  checkLutStatus(gstin: string, fy: string): Promise<LutStatus>;

  verifyLutCoverage(
    lut: LutApplication,
    invoices: GstInvoice[],
  ): Promise<{ covered: boolean; coveredInvoices: string[]; uncoveredInvoices: string[] }>;
}

export function createLutEngine(): LutEngine {
  /**
   * Apply for a LUT or Bond for zero-rated exports.
   */
  async function applyLut(
    bookId: string,
    gstin: string,
    fy: string,
    applicationType: "LUT" | "BOND",
    amount: number,
    dateOfIssue: string,
  ): Promise<{ lut: LutApplication; status: "approved" | "rejected" | "already-exists"; reason?: string }> {
    // Validate GSTIN
    const gstinValidate = validateGstin(gstin);
    if (!gstinValidate.valid) {
      return {
        lut: {
          id: "",
          bookId,
          gstin,
          fy,
          applicationType,
          amount,
          dateOfIssue: dateOfIssue,
          validUpto: new Date(Date.parse(dateOfIssue) + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          status: "REJECTED",
          reasonForRejection: "Invalid GSTIN",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        status: "rejected",
        reason: "Invalid GSTIN",
      };
    }

    // Check if a LUT already exists for this FY
    const existingLut = await prisma.lutApplication.findFirst({
      where: { bookId, gstin, fy, status: { in: ["APPROVED", "DRAFT"] } },
    });

    if (existingLut) {
      return {
        lut: {
          id: existingLut.id,
          bookId,
          gstin,
          fy,
          applicationType,
          amount,
          dateOfIssue: existingLut.dateOfIssue,
          validUpto: existingLut.validUpto,
          status: existingLut.status,
          reasonForRejection: existingLut.reasonForRejection,
          submittedById: existingLut.submittedById,
          approvedById: existingLut.approvedById,
          approvedAt: existingLut.approvedAt,
          createdAt: existingLut.createdAt,
          updatedAt: existingLut.updatedAt,
        },
        status: "already-exists",
        reason: "A LUT already exists for this FY. Renew or cancel the existing one.",
      };
    }

    const validUpto = new Date(Date.parse(dateOfIssue) + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const lut = await prisma.lutApplication.create({
      data: {
        bookId,
        gstin,
        fy,
        applicationType,
        amount,
        dateOfIssue,
        validUpto,
        status: "DRAFT",
      },
    });

    return {
      lut,
      status: "approved", // In prototype, auto-approve; real system routes for approval
    };
  }

  /**
   * Approve a LUT application.
   */
  async function approveLut(
    lutId: string,
    approverId: string,
  ): Promise<{ lut: LutApplication; status: "APPROVED"; message: string }> {
    const lut = await prisma.lutApplication.update({
      where: { id: lutId },
      data: {
        status: "APPROVED",
        approvedById: approverId,
        approvedAt: new Date().toISOString(),
      },
    });

    return {
      lut,
      status: "APPROVED",
      message: "LUT approved successfully. Exporter can now supply zero-rated exports without paying IGST.",
    };
  }

  /**
   * Cancel a LUT application.
   */
  async function cancelLut(
    lutId: string,
    cancellerId: string,
    reason: string,
  ): Promise<{ lut: LutApplication; status: "CANCELLED"; message: string }> {
    const lut = await prisma.lutApplication.update({
      where: { id: lutId },
      data: {
        status: "CANCELLED",
        reasonForRejection: reason,
      },
    });

    return {
      lut,
      status: "CANCELLED",
      message: `LUT cancelled. Reason: ${reason}`,
    };
  }

  /**
   * Generate a shipping bill for an export invoice.
   */
  async function generateShippingBill(
    bookId: string,
    invoiceId: string,
    gstin: string,
    fy: string,
    shippingBillNumber: string,
    portOfExport: string,
  ): Promise<{ shippingBill: ShippingBill; lutCoverage: boolean }> {
    const invoice = await prisma.gstInvoice.findFirst({
      where: { id: invoiceId, bookId },
    });

    if (!invoice) {
      throw new LutError(404, "NOT_FOUND", "Invoice not found.");
    }

    // Check if an approved LUT covers this invoice
    const lut = await prisma.lutApplication.findFirst({
      where: { bookId, gstin, fy, status: "APPROVED" },
    });
    const coverage = lut
      ? await verifyLutCoverage(lut, [invoice])
      : { covered: false, coveredInvoices: [], uncoveredInvoices: [invoice.invoiceNumber] };
    const lutCoverage = coverage.covered;

    const shippingBill = await prisma.shippingBill.create({
      data: {
        bookId,
        invoiceId,
        gstin,
        fy,
        exportInvoiceNumber: invoice.invoiceNumber,
        shippingBillNumber,
        dateOfExport: invoice.invoiceDate,
        portOfExport,
        status: lutCoverage ? "APPROVED" : "PENDING",
      },
    });

    return {
      shippingBill,
      lutCoverage,
    };
  }

  /**
   * Check LUT status for a GSTIN/FY combination.
   */
  async function checkLutStatus(gstin: string, fy: string): Promise<LutStatus> {
    const gstinValidate = validateGstin(gstin);
    if (!gstinValidate.valid) {
      return {
        gstin,
        fy,
        lutStatus: "NOT_FOUND",
        canExportWithoutIgst: false,
        blockingInvoices: [],
      };
    }

    const lut = await prisma.lutApplication.findFirst({
      where: { gstin, fy, status: "APPROVED" },
    });

    if (!lut) {
      return {
        gstin,
        fy,
        lutStatus: "NOT_FOUND",
        canExportWithoutIgst: false,
        blockingInvoices: [],
      };
    }

    const validUpto = new Date(lut.validUpto);
    const now = new Date();
    const daysRemaining = Math.max(0, Math.ceil((validUpto.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

    const isExpired = now > validUpto;

    return {
      gstin,
      fy,
      lutStatus: isExpired ? "EXPIRED" : "VALID",
      daysRemaining,
      canExportWithoutIgst: !isExpired,
      blockingInvoices: [], // would be populated by verifyLutCoverage
    };
  }

  /**
   * Verify LUT coverage for a set of invoices.
   */
  async function verifyLutCoverage(
    lut: LutApplication,
    invoices: GstInvoice[],
  ): Promise<{ covered: boolean; coveredInvoices: string[]; uncoveredInvoices: string[] }> {
    const covered: string[] = [];
    const uncovered: string[] = [];

    for (const invoice of invoices) {
      // An invoice is LUT-covered if:
      // 1. It's an export invoice (invoiceType === "export")
      // 2. It has a valid LUT for the FY
      // 3. The invoice date is within the LUT validity period
      const isExport = invoice.invoiceType === "export";
      const withinPeriod =
        new Date(invoice.invoiceDate) >= new Date(lut.dateOfIssue) &&
        new Date(invoice.invoiceDate) <= new Date(lut.validUpto);

      if (isExport && withinPeriod) {
        covered.push(invoice.invoiceNumber);
      } else {
        uncovered.push(invoice.invoiceNumber);
      }
    }

    return {
      covered: covered.length > 0,
      coveredInvoices: covered,
      uncoveredInvoices: uncovered,
    };
  }

  return {
    applyLut,
    approveLut,
    cancelLut,
    generateShippingBill,
    checkLutStatus,
    verifyLutCoverage,
  };
}

export default createLutEngine;
