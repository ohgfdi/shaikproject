/**
 * GST Invoice Capture & Classification Engine
 *
 * Handles invoice-level data capture with proper classification:
 * - Supply type (intra/inter state)
 * - Place of supply vs supplier state mismatch detection
 * - HSN/SAC classification
 * - Reverse Charge Mechanism (RCM) flags
 * - E-Way Bill linkage
 * - Credit/nil/suppressed handling
 * - ITC eligibility classification (eligible | ineligible | blocked | reversed | partial)
 */

import type { GstInvoice } from "@/generated/prisma/client";
import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { validateGstin, isValidRate, classifyHsnSac } from "@/lib/engine/gst-rate-validation";
import { gstinStateCode } from "@/lib/engine/india-tax";
import { stringifyJson } from "@/lib/json";
import { appendAuditEntry } from "@/lib/server/audit-chain";

export class GstInvoiceCaptureError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "GstInvoiceCaptureError";
  }
}

export interface GstInvoiceCaptureInput {
  invoiceNumber: string;
  invoiceDate: string;
  invoiceType: "b2b" | "b2c" | "export" | "sezwop" | "deemed" | "credit-note" | "debit-note";
  supplyType: "intra" | "inter";
  placeOfSupply: string;
  supplierGstin?: string | null;
  supplierName?: string | null;
  recipientGstin?: string | null;
  recipientName?: string | null;
  recipientState?: string | null;
  taxableValue: number; // minor units
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  cessAmount: number;
  rcm?: boolean;
  hsnSac?: string;
  ewayBillNumber?: string | null;
  ewayBillDate?: string | null;
  itcEligibility?: "eligible" | "ineligible" | "blocked" | "reversed" | "partial";
  source?: string; // manual | tally | gst-portal | gsp | api
}

export interface GstInvoiceCaptureResult {
  invoice: GstInvoice;
  mismatchFlags: MismatchFlag[];
  itcClassification: {
    eligibility: string;
    reason: string;
    blockedSection?: string;
  };
  ewayBillStatus: "linked" | "pending" | "invalid";
}

interface MismatchFlag {
  type: "pos-supplier-mismatch" | "gstin-invalid" | "rate-mismatch" | "hsn-invalid" | "rcm-flagged";
  severity: "info" | "warning" | "error";
  message: string;
  field: string;
}

/**
 * Capture and classify a new GST invoice with full validation.
 */
export async function captureGstInvoice(
  workspaceId: string,
  bookId: string,
  input: GstInvoiceCaptureInput,
  actorId: string,
): Promise<GstInvoiceCaptureResult> {
  // Validate supplier GSTIN if provided
  const gstinValidation = input.supplierGstin ? validateGstin(input.supplierGstin) : { valid: true, errors: [] };

  // Validate HSN/SAC if provided
  const hsnValidation = input.hsnSac
    ? classifyHsnSac(input.hsnSac)
    : { type: "invalid", errors: ["HSN/SAC code required"] };

  // Detect place-of-supply vs supplier state mismatch
  const mismatchFlags: MismatchFlag[] = [];

  // POS vs supplier state mismatch
  if (input.placeOfSupply && input.supplierGstin) {
    const supplierState = gstinStateCode(input.supplierGstin);
    if (supplierState && input.placeOfSupply !== supplierState) {
      mismatchFlags.push({
        type: "pos-supplier-mismatch",
        severity: "warning",
        message: `Place of supply (${input.placeOfSupply}) differs from supplier GSTIN state (${supplierState}).`,
        field: "placeOfSupply",
      });
    }
  }

  // GSTIN invalid
  if (input.supplierGstin && !gstinValidation.valid) {
    mismatchFlags.push({
      type: "gstin-invalid",
      severity: "error",
      message: `Supplier GSTIN is invalid: ${gstinValidation.errors.join(", ")}`,
      field: "supplierGstin",
    });
  }

  // HSN/SAC invalid
  if (hsnValidation.type === "invalid") {
    mismatchFlags.push({
      type: "hsn-invalid",
      severity: "error",
      message: `HSN/SAC code invalid: ${hsnValidation.errors.join(", ")}`,
      field: "hsnSac",
    });
  }

  // RCM flagged
  if (input.rcm && !gstinValidation.valid) {
    mismatchFlags.push({
      type: "rcm-flagged",
      severity: "warning",
      message: "Reverse Charge Mechanism invoice with invalid supplier GSTIN - ITC may be blocked under section 17(4).",
      field: "rcm",
    });
  }

  // Determine ITC eligibility
  let itcEligibility: "eligible" | "ineligible" | "blocked" | "reversed" | "partial" | "nil" = "eligible";
  const itcReason = "Standard ITC eligibility";
  let blockedSection: string | undefined;

  // Check for blocked credits under section 17(5)
  if (input.itcEligibility) {
    itcEligibility = input.itcEligibility;
  } else {
    // Auto-classify ITC eligibility
    itcEligibility = classifyItcEligibility(input, gstinValidation, hsnValidation, mismatchFlags, blockedSection);
  }

  // Create the invoice and its audit row atomically: a captured invoice
  // without an audit trail is not an auditable record.
  const invoice = await prisma.$transaction(async (tx) => {
    const created = await tx.gstInvoice.create({
      data: {
        bookId,
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate,
        invoiceType: input.invoiceType,
        supplyType: input.supplyType,
        placeOfSupply: input.placeOfSupply,
        supplierGstin: input.supplierGstin ?? null,
        supplierName: input.supplierName ?? null,
        recipientGstin: input.recipientGstin ?? null,
        recipientName: input.recipientName ?? null,
        recipientState: input.recipientState ?? null,
        taxableValue: Math.round(input.taxableValue),
        cgstAmount: Math.round(input.cgstAmount),
        sgstAmount: Math.round(input.sgstAmount),
        igstAmount: Math.round(input.igstAmount),
        cessAmount: Math.round(input.cessAmount),
        itcEligibility,
        itcHeading: input.hsnSac ? `HSN ${input.hsnSac}` : undefined,
        rcm: input.rcm ?? false,
        irn: null,
        irnDate: null,
        ackNumber: null,
        ackDate: null,
        source: input.source ?? "manual",
        status: "draft",
        period: input.invoiceDate.slice(0, 7), // yyyy-mm
        reference: null,
        createdById: actorId,
      },
    });

    await appendAuditEntry(tx, {
      bookId,
      entityType: "GstInvoice",
      entityId: created.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    });
    return created;
  });

  // Determine E-Way Bill status
  const ewayBillStatus = input.ewayBillNumber ? "linked" : "pending";

  return {
    invoice,
    mismatchFlags,
    itcClassification: {
      eligibility: itcEligibility,
      reason: itcReason,
      blockedSection,
    },
    ewayBillStatus,
  };
}

/**
 * Classify ITC eligibility based on invoice characteristics.
 */
function classifyItcEligibility(
  input: GstInvoiceCaptureInput,
  gstinValidation: { valid: boolean; errors: string[] },
  hsnValidation: { type: string; errors: string[] },
  mismatchFlags: MismatchFlag[],
  _blockedSection: string | undefined,
): "eligible" | "ineligible" | "blocked" | "reversed" | "partial" | "nil" {
  // If GSTIN is invalid, ITC is blocked
  if (!gstinValidation.valid) {
    return "blocked";
  }

  // If RCM is true and supplier GSTIN is valid, ITC is eligible for the recipient (goes to 4(A)(3))
  if (input.rcm) {
    return "eligible"; // RCM credit goes to 4(A)(3), eligible but separate
  }

  // If HSN/SAC is invalid, ITC is blocked
  if (hsnValidation.type === "invalid") {
    return "blocked";
  }

  // Check for mismatches that affect eligibility
  const hasPosMismatch = mismatchFlags.some((f) => f.type === "pos-supplier-mismatch");
  const hasGstinInvalid = mismatchFlags.some((f) => f.type === "gstin-invalid");

  if (hasGstinInvalid || hasPosMismatch) {
    return "blocked";
  }

  // Check for rate mismatch
  if (input.taxableValue > 0) {
    const effectiveRate = Math.round(
      ((input.cgstAmount + input.sgstAmount + input.igstAmount + input.cessAmount) * 100) / input.taxableValue,
    );
    if (!isValidRate(effectiveRate)) {
      return "ineligible";
    }
  }

  // Check if it's a nil-rated or exempt supply
  if (input.taxableValue === 0) {
    return "nil"; // No ITC on nil-rated supplies
  }

  // Default: eligible
  return "eligible";
}

/**
 * Update an existing GST invoice with classification updates.
 */
export async function updateGstInvoiceClassification(
  workspaceId: string,
  bookId: string,
  invoiceId: string,
  input: Partial<GstInvoiceCaptureInput>,
  actorId: string,
): Promise<GstInvoiceCaptureResult> {
  const existing = await prisma.gstInvoice.findFirst({ where: { id: invoiceId, bookId } });
  if (!existing) {
    throw new GstInvoiceCaptureError(404, "NOT_FOUND", "Invoice not found.");
  }

  // Merge with existing values
  const mergedInput = { ...existing, ...input } as GstInvoiceCaptureInput;

  // Re-run validation and classification
  return await captureGstInvoice(workspaceId, bookId, mergedInput, actorId);
}

/**
 * Link E-Way Bill to an existing invoice.
 */
export async function linkEwayBill(
  workspaceId: string,
  bookId: string,
  invoiceId: string,
  ewayBillNumber: string,
  ewayBillDate: string,
  actorId: string,
): Promise<GstInvoice> {
  const invoice = await prisma.gstInvoice.update({
    where: { id: invoiceId },
    data: {
      status: "validated",
      reference: `EWB-${ewayBillNumber}`,
      updatedById: actorId,
    },
  });

  // Audit trail
  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "GstInvoice",
      entityId: invoiceId,
      action: "eway-bill-link",
      fieldChanges: stringifyJson({ ewayBillNumber, ewayBillDate }),
      actorId,
    },
  });

  return invoice;
}

/**
 * Suppress an invoice (mark as suppressed - not eligible for ITC).
 */
export async function suppressInvoice(
  workspaceId: string,
  bookId: string,
  invoiceId: string,
  actorId: string,
): Promise<GstInvoice> {
  const invoice = await prisma.gstInvoice.update({
    where: { id: invoiceId },
    data: {
      itcEligibility: "blocked",
      status: "cancelled",
      updatedById: actorId,
    },
  });

  // Audit trail
  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "GstInvoice",
      entityId: invoiceId,
      action: "suppress",
      fieldChanges: stringifyJson({ itcEligibility: "blocked" }),
      actorId,
    },
  });

  return invoice;
}

/**
 * Mark an invoice as nil-rated (no tax, no ITC).
 */
export async function markInvoiceNil(
  workspaceId: string,
  bookId: string,
  invoiceId: string,
  actorId: string,
): Promise<GstInvoice> {
  const invoice = await prisma.gstInvoice.update({
    where: { id: invoiceId },
    data: {
      itcEligibility: "nil",
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: 0,
      cessAmount: 0,
      updatedById: actorId,
    },
  });

  // Audit trail
  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "GstInvoice",
      entityId: invoiceId,
      action: "mark-nil",
      fieldChanges: stringifyJson({
        itcEligibility: "nil",
        cgstAmount: 0,
        sgstAmount: 0,
        igstAmount: 0,
        cessAmount: 0,
      }),
      actorId,
    },
  });

  return invoice;
}

const gstInvoiceCaptureApi = {
  captureGstInvoice,
  updateGstInvoiceClassification,
  linkEwayBill,
  suppressInvoice,
  markInvoiceNil,
};

export default gstInvoiceCaptureApi;
