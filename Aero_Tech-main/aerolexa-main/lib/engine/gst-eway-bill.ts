/**
 * E-Way Bill Generation and Linkage Engine
 *
 * Handles:
 * - E-Way Bill generation (FORM EWB-01)
 * - Consolidated E-Way Bill (FORM EWB-02)
 * - E-Way Bill linkage with GST invoices
 * - Validity calculation (distance-based)
 * - Multi-vehicle / transshipment handling
 * - Cancellation and rejection workflows
 * - Verification and penalty provisions
 */

import { INR, formatInr, gstinStateCode, isValidGstin } from "./india-tax";

export class EwayBillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EwayBillError";
  }
}

// ---------------------------------------------------------------------------
// E-Way Bill Types
// ---------------------------------------------------------------------------

export type EwayBillType =
  "outward" | "inward" | "return" | "job-work" | "exhibition" | "own-use" | "skd-ckd" | "other";
export type EwayBillStatus = "generated" | "valid" | "expired" | "cancelled" | "rejected" | "verified";
export type TransportMode = "road" | "rail" | "air" | "ship";
export type VehicleType = "regular" | "over-dimensional" | "container" | "tanker";

export interface EwayBillItem {
  slNo: number;
  productName: string;
  description?: string;
  hsnCode: string;
  quantity: number;
  unit: string; // UQC codes: PCS, MTR, KGS, LTR, etc.
  taxableValue: number; // minor units
  taxRate: number; // GST rate %
  sgstRate?: number;
  cgstRate?: number;
  igstRate?: number;
  cessRate?: number;
}

export interface EwayBillPayloadItem {
  slNo: number;
  prdDesc: string;
  hsnCode: string;
  qty: number;
  unit: string;
  taxableValue: number;
  taxRate: number;
  cgstRate?: number;
  sgstRate?: number;
  igstRate?: number;
  cessRate?: number;
  cgstAmt?: number;
  sgstAmt?: number;
  igstAmt?: number;
  cessAmt?: number;
}

export interface EwayBillPayload {
  version: string;
  billType: string;
  docType: string;
  docNo: string;
  docDate: string;
  docValue: number;
  fromGstin: string;
  fromTrdName: string;
  fromAddr1: string;
  fromAddr2: string;
  fromPlace: string;
  fromPincode: number;
  fromStateCode: number;
  toGstin: string;
  toTrdName: string;
  toAddr1: string;
  toAddr2: string;
  toPlace: string;
  toPincode: number;
  toStateCode: number;
  transactionType: number;
  dispatchFromGstin: string;
  dispatchFromTrdName: string;
  dispatchFromAddr1: string;
  dispatchFromAddr2: string;
  dispatchFromPlace: string;
  dispatchFromPincode: number;
  dispatchFromStateCode: number;
  shipToGstin: string;
  shipToTrdName: string;
  shipToAddr1: string;
  shipToAddr2: string;
  shipToPlace: string;
  shipToPincode: number;
  shipToStateCode: number;
  itemList: EwayBillPayloadItem[];
  transMode: number;
  transDistance: number;
  transDocNo: string;
  transDocDate: string;
  vehicleNo: string;
  vehicleType: string;
  transporterId: string;
  transporterName: string;
  cewbNo?: string;
  irn?: string;
  irnDate?: string;
  subSupplyType: number;
}

export interface EwayBillParty {
  gstin: string;
  name: string;
  address: string;
  place: string;
  pincode: number;
  stateCode: string;
}

export interface EwayBillTransport {
  mode: TransportMode;
  distance: number; // km
  vehicleNo?: string;
  vehicleType?: VehicleType;
  transDocNo?: string; // Railway receipt, airway bill, bill of lading
  transDocDate?: string;
  transporterId?: string;
  transporterName?: string;
  fromPlace: string;
  fromStateCode: string;
  fromPincode: number;
  toPlace: string;
  toStateCode: string;
  toPincode: number;
}

export interface EwayBillGenerateInput {
  // Document details
  docType: "INV" | "BIL" | "CHL" | "CRN" | "DBN" | "OTH"; // Invoice, Bill of Supply, Challan, Credit Note, Debit Note, Other
  docNo: string;
  docDate: string; // yyyy-mm-dd
  docValue: number; // minor units
  // Supply type
  supplyType: "B2B" | "B2C" | "EXP" | "IMP" | "SEZ" | "JOB" | "EXH" | "OWN" | "SKD" | "OTH";
  // Transaction type
  transactionType: "regular" | "bill-to-ship-to" | "bill-from-dispatch-from" | "combination";
  // Sub-type for specific cases
  subType?: "outward" | "inward" | "return" | "job-work" | "exhibition" | "own-use" | "skd-ckd";
  // Parties
  supplier: EwayBillParty;
  recipient: EwayBillParty;
  // Dispatch/Delivery (if different from supplier/recipient)
  dispatchFrom?: EwayBillParty;
  shipTo?: EwayBillParty;
  // Items
  items: EwayBillItem[];
  // Transport
  transport: EwayBillTransport;
  // Optional
  cewbNo?: string; // Consolidated EWB number if part of consolidated
  irn?: string; // IRN if e-invoice generated
  irnDate?: string;
}

export interface EwayBillGenerated {
  ewayBillNo: string;
  ewayBillDate: string;
  validUpto: string;
  ewayBillType: EwayBillType;
  status: EwayBillStatus;
  qrCode?: string;
  printData?: string;
  jsonPayload: Record<string, unknown>; // Full payload for API submission
}

// ---------------------------------------------------------------------------
// Distance-based Validity Calculation
// ---------------------------------------------------------------------------

/**
 * Calculate E-Way Bill validity based on distance (Rule 138(10)).
 * Normal cargo: 1 day per 200 km or part thereof.
 * Over-dimensional cargo: 1 day per 20 km or part thereof.
 * Validity starts from the date/time of generation.
 */
export function calculateEwayBillValidity(
  distanceKm: number,
  vehicleType: VehicleType = "regular",
  generationDateTime: string, // ISO string
): { validFrom: string; validUpto: string; days: number } {
  const kmPerDay = vehicleType === "over-dimensional" ? 20 : 200;
  const days = Math.ceil(distanceKm / kmPerDay);

  const genDate = new Date(generationDateTime);
  const validFrom = genDate.toISOString().slice(0, 10);
  const validUptoDate = new Date(genDate);
  validUptoDate.setDate(validUptoDate.getDate() + days);
  // Validity ends at midnight of the last day
  validUptoDate.setHours(23, 59, 59, 999);
  const validUpto = validUptoDate.toISOString();

  return { validFrom, validUpto, days };
}

// ---------------------------------------------------------------------------
// E-Way Bill Payload Builder (for NIC/GSP API)
// ---------------------------------------------------------------------------

/**
 * Build E-Way Bill payload for NIC portal / GSP API submission.
 * Follows FORM EWB-01 schema.
 */
export function buildEwayBillPayload(input: EwayBillGenerateInput): EwayBillPayload {
  const isInterState = input.supplier.stateCode !== input.recipient.stateCode;

  // Calculate tax amounts
  let totalTaxable = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;
  let totalCess = 0;

  const itemList = input.items.map((item, idx) => {
    const taxableValue = item.taxableValue;
    totalTaxable += taxableValue;

    let igstAmt = 0,
      cgstAmt = 0,
      sgstAmt = 0,
      cessAmt = 0;
    if (isInterState) {
      igstAmt = Math.round((taxableValue * (item.igstRate ?? item.taxRate)) / 100);
      totalIgst += igstAmt;
    } else {
      cgstAmt = Math.round((taxableValue * (item.cgstRate ?? item.taxRate / 2)) / 100);
      sgstAmt = Math.round((taxableValue * (item.sgstRate ?? item.taxRate / 2)) / 100);
      totalCgst += cgstAmt;
      totalSgst += sgstAmt;
    }
    if (item.cessRate) {
      cessAmt = Math.round((taxableValue * item.cessRate) / 100);
      totalCess += cessAmt;
    }

    return {
      slNo: idx + 1,
      prdDesc: item.productName,
      hsnCode: item.hsnCode,
      qty: item.quantity,
      unit: item.unit,
      taxableValue: taxableValue,
      taxRate: item.taxRate,
      cgstRate: item.cgstRate,
      sgstRate: item.sgstRate,
      igstRate: item.igstRate,
      cessRate: item.cessRate,
      cgstAmt: cgstAmt,
      sgstAmt: sgstAmt,
      igstAmt: igstAmt,
      cessAmt: cessAmt,
    };
  });

  const totalValue = totalTaxable + totalCgst + totalSgst + totalIgst + totalCess;

  // Build payload
  return {
    version: "1.0.0221", // EWB schema version
    billType: input.supplyType === "IMP" ? "I" : "O", // I=Inward, O=Outward
    docType: input.docType,
    docNo: input.docNo,
    docDate: input.docDate.replace(/-/g, "/"), // dd/mm/yyyy
    docValue: totalValue,
    fromGstin: input.supplier.gstin,
    fromTrdName: input.supplier.name,
    fromAddr1: input.supplier.address,
    fromAddr2: "",
    fromPlace: input.supplier.place,
    fromPincode: input.supplier.pincode,
    fromStateCode: parseInt(input.supplier.stateCode, 10),
    toGstin: input.recipient.gstin,
    toTrdName: input.recipient.name,
    toAddr1: input.recipient.address,
    toAddr2: "",
    toPlace: input.recipient.place,
    toPincode: input.recipient.pincode,
    toStateCode: parseInt(input.recipient.stateCode, 10),
    transactionType:
      input.transactionType === "regular"
        ? 1
        : input.transactionType === "bill-to-ship-to"
          ? 2
          : input.transactionType === "bill-from-dispatch-from"
            ? 3
            : 4,
    // Dispatch from
    dispatchFromGstin: input.dispatchFrom?.gstin ?? input.supplier.gstin,
    dispatchFromTrdName: input.dispatchFrom?.name ?? input.supplier.name,
    dispatchFromAddr1: input.dispatchFrom?.address ?? input.supplier.address,
    dispatchFromAddr2: "",
    dispatchFromPlace: input.dispatchFrom?.place ?? input.supplier.place,
    dispatchFromPincode: input.dispatchFrom?.pincode ?? input.supplier.pincode,
    dispatchFromStateCode: parseInt(input.dispatchFrom?.stateCode ?? input.supplier.stateCode, 10),
    // Ship to
    shipToGstin: input.shipTo?.gstin ?? input.recipient.gstin,
    shipToTrdName: input.shipTo?.name ?? input.recipient.name,
    shipToAddr1: input.shipTo?.address ?? input.recipient.address,
    shipToAddr2: "",
    shipToPlace: input.shipTo?.place ?? input.recipient.place,
    shipToPincode: input.shipTo?.pincode ?? input.recipient.pincode,
    shipToStateCode: parseInt(input.shipTo?.stateCode ?? input.recipient.stateCode, 10),
    // Items
    itemList,
    // Transport
    transMode:
      input.transport.mode === "road"
        ? 1
        : input.transport.mode === "rail"
          ? 2
          : input.transport.mode === "air"
            ? 3
            : 4,
    transDistance: input.transport.distance,
    transDocNo: input.transport.transDocNo ?? "",
    transDocDate: input.transport.transDocDate ? input.transport.transDocDate.replace(/-/g, "/") : "",
    vehicleNo: input.transport.vehicleNo ?? "",
    vehicleType: input.transport.vehicleType === "over-dimensional" ? "O" : "R",
    transporterId: input.transport.transporterId ?? "",
    transporterName: input.transport.transporterName ?? "",
    // Optional
    cewbNo: input.cewbNo ?? "",
    irn: input.irn ?? "",
    irnDate: input.irnDate ? input.irnDate.replace(/-/g, "/") : "",
    // Sub-type
    subSupplyType:
      input.subType === "outward"
        ? 1
        : input.subType === "inward"
          ? 2
          : input.subType === "return"
            ? 3
            : input.subType === "job-work"
              ? 4
              : input.subType === "exhibition"
                ? 5
                : input.subType === "own-use"
                  ? 6
                  : input.subType === "skd-ckd"
                    ? 7
                    : 0,
  };
}

// ---------------------------------------------------------------------------
// E-Way Bill Validation
// ---------------------------------------------------------------------------

export interface EwayBillValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateEwayBillInput(input: EwayBillGenerateInput): EwayBillValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // GSTIN validation
  if (!isValidGstin(input.supplier.gstin)) {
    errors.push(`Supplier GSTIN ${input.supplier.gstin} is invalid.`);
  }
  if (!isValidGstin(input.recipient.gstin)) {
    errors.push(`Recipient GSTIN ${input.recipient.gstin} is invalid.`);
  }

  // State code consistency
  if (input.supplier.stateCode !== gstinStateCode(input.supplier.gstin)) {
    errors.push(`Supplier state code (${input.supplier.stateCode}) doesn't match GSTIN.`);
  }
  if (input.recipient.stateCode !== gstinStateCode(input.recipient.gstin)) {
    errors.push(`Recipient state code (${input.recipient.stateCode}) doesn't match GSTIN.`);
  }

  // Document value
  if (input.docValue <= 0) {
    errors.push("Document value must be greater than zero.");
  }

  // Distance
  if (input.transport.distance <= 0) {
    errors.push("Transport distance must be greater than zero.");
  }

  // Vehicle number for road transport
  if (input.transport.mode === "road" && !input.transport.vehicleNo) {
    warnings.push("Vehicle number not provided for road transport — may be updated later (Part B).");
  }

  // HSN codes
  for (const item of input.items) {
    if (!/^\d{4,8}$/.test(item.hsnCode)) {
      warnings.push(`Item ${item.slNo}: HSN code ${item.hsnCode} may not be valid (4-8 digits expected).`);
    }
    if (item.quantity <= 0) {
      errors.push(`Item ${item.slNo}: Quantity must be positive.`);
    }
    if (item.taxableValue < 0) {
      errors.push(`Item ${item.slNo}: Taxable value cannot be negative.`);
    }
  }

  // Pin codes
  if (input.supplier.pincode < 100000 || input.supplier.pincode > 999999) {
    errors.push("Supplier pincode must be 6 digits.");
  }
  if (input.recipient.pincode < 100000 || input.recipient.pincode > 999999) {
    errors.push("Recipient pincode must be 6 digits.");
  }

  // E-way bill threshold check
  if (input.docValue <= INR(50000) && input.supplyType !== "EXP" && input.supplyType !== "IMP") {
    warnings.push(
      `Document value ${formatInr(input.docValue)} is below ₹50,000 threshold — E-way bill not mandatory but can be generated voluntarily.`,
    );
  }

  // Inter-state check for specific supplies
  if (input.supplyType === "EXP" && input.supplier.stateCode === input.recipient.stateCode) {
    warnings.push("Export supply should typically be inter-state.");
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Consolidated E-Way Bill (FORM EWB-02)
// ---------------------------------------------------------------------------

export interface ConsolidatedEwayBillInput {
  cewbNo?: string; // if updating
  generatorGstin: string;
  generatorName: string;
  fromStateCode: string;
  fromPlace: string;
  vehicleNo: string;
  vehicleType: VehicleType;
  ewayBills: Array<{
    ewayBillNo: string;
    ewayBillDate: string;
    fromGstin: string;
    toGstin: string;
    fromPlace: string;
    toPlace: string;
    distance: number;
  }>;
}

export function buildConsolidatedEwayBillPayload(input: ConsolidatedEwayBillInput): Record<string, unknown> {
  return {
    version: "1.0.0221",
    cewbNo: input.cewbNo ?? "",
    genGstin: input.generatorGstin,
    genName: input.generatorName,
    fromStateCode: parseInt(input.fromStateCode, 10),
    fromPlace: input.fromPlace,
    vehicleNo: input.vehicleNo,
    vehicleType: input.vehicleType === "over-dimensional" ? "O" : "R",
    ewbList: input.ewayBills.map((ewb) => ({
      ewbNo: ewb.ewayBillNo,
      ewbDate: ewb.ewayBillDate.replace(/-/g, "/"),
      fromGstin: ewb.fromGstin,
      toGstin: ewb.toGstin,
      fromPlace: ewb.fromPlace,
      toPlace: ewb.toPlace,
      distance: ewb.distance,
    })),
  };
}

// ---------------------------------------------------------------------------
// E-Way Bill Linkage with GST Invoice
// ---------------------------------------------------------------------------

export interface EwayBillInvoiceLink {
  ewayBillNo: string;
  ewayBillDate: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  linkageType: "direct" | "consolidated" | "multi-invoice";
  status: "linked" | "pending" | "mismatch" | "cancelled";
  mismatchDetails?: string;
}

/**
 * Validate linkage between E-Way Bill and GST Invoice.
 * Checks: value match, party match, HSN match, date proximity.
 */
export function validateEwayBillInvoiceLink(
  ewayBill: {
    docNo: string;
    docDate: string;
    docValue: number;
    fromGstin: string;
    toGstin: string;
    items: Array<{ hsnCode?: string }>;
  },
  invoice: {
    invoiceNumber: string;
    invoiceDate: string;
    taxableValue: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
    cessAmount: number;
    supplierGstin: string;
    recipientGstin: string;
    items: Array<{ hsn: string; taxableValue: number }>;
  },
): { valid: boolean; matchScore: number; mismatches: string[] } {
  const mismatches: string[] = [];
  let matchScore = 100;

  // Document number match
  if (ewayBill.docNo !== invoice.invoiceNumber) {
    mismatches.push(`Document number mismatch: EWB ${ewayBill.docNo} vs Invoice ${invoice.invoiceNumber}`);
    matchScore -= 20;
  }

  // Date match (within 3 days)
  const ewayDate = new Date(ewayBill.docDate.replace(/\//g, "-"));
  const invDate = new Date(invoice.invoiceDate);
  const dayDiff = Math.abs((ewayDate.getTime() - invDate.getTime()) / 86400000);
  if (dayDiff > 3) {
    mismatches.push(`Date difference: EWB ${ewayBill.docDate} vs Invoice ${invoice.invoiceDate} (${dayDiff} days)`);
    matchScore -= 10;
  }

  // Value match (within 1%)
  const ewayValue = ewayBill.docValue;
  const invoiceValue =
    invoice.taxableValue + invoice.cgstAmount + invoice.sgstAmount + invoice.igstAmount + invoice.cessAmount;
  const valueDiffPct = invoiceValue > 0 ? (Math.abs(ewayValue - invoiceValue) * 100) / invoiceValue : 100;
  if (valueDiffPct > 1) {
    mismatches.push(
      `Value mismatch: EWB ${formatInr(ewayValue)} vs Invoice ${formatInr(invoiceValue)} (${valueDiffPct.toFixed(2)}%)`,
    );
    matchScore -= 30;
  }

  // Party match
  if (ewayBill.fromGstin !== invoice.supplierGstin) {
    mismatches.push(`Supplier GSTIN mismatch: EWB ${ewayBill.fromGstin} vs Invoice ${invoice.supplierGstin}`);
    matchScore -= 25;
  }
  if (ewayBill.toGstin !== invoice.recipientGstin) {
    mismatches.push(`Recipient GSTIN mismatch: EWB ${ewayBill.toGstin} vs Invoice ${invoice.recipientGstin}`);
    matchScore -= 25;
  }

  // HSN match (at least one item)
  const ewayHsns = new Set(ewayBill.items.map((i) => i.hsnCode).filter((h): h is string => typeof h === "string"));
  const invHsns = new Set(invoice.items.map((i) => i.hsn));
  const commonHsns = [...ewayHsns].filter((h) => invHsns.has(h));
  if (commonHsns.length === 0 && ewayHsns.size > 0 && invHsns.size > 0) {
    mismatches.push("No matching HSN codes between E-Way Bill and Invoice items");
    matchScore -= 15;
  }

  matchScore = Math.max(0, matchScore);
  return { valid: matchScore >= 80, matchScore, mismatches };
}

// ---------------------------------------------------------------------------
// E-Way Bill Lifecycle Management
// ---------------------------------------------------------------------------

export interface EwayBillRecord {
  id: string;
  bookId: string;
  ewayBillNo: string;
  ewayBillDate: string;
  validUpto: string;
  ewayBillType: EwayBillType;
  status: EwayBillStatus;
  // Source document
  docType: string;
  docNo: string;
  docDate: string;
  docValue: number;
  // Parties
  supplierGstin: string;
  recipientGstin: string;
  // Transport
  distance: number;
  vehicleNo?: string;
  transportMode: TransportMode;
  // Validity
  daysValid: number;
  // Linkage
  linkedInvoiceId?: string;
  linkedInvoiceNumber?: string;
  // Multi-vehicle
  isMultiVehicle: boolean;
  parentEwayBillNo?: string;
  childEwayBillNos: string[];
  // Verification
  verifiedAt?: string;
  verifiedBy?: string;
  verificationRemarks?: string;
  // Cancellation
  cancelledAt?: string;
  cancelledBy?: string;
  cancellationReason?: string;
  // Audit
  createdAt: string;
  createdById: string;
  updatedAt: string;
}

export interface EwayBillAction {
  type: "generate" | "update-vehicle" | "extend-validity" | "cancel" | "reject" | "verify" | "consolidate";
  ewayBillNo: string;
  actorId: string;
  data: Record<string, unknown>;
  reason?: string;
}

/**
 * Process E-Way Bill lifecycle actions.
 */
export function processEwayBillAction(
  record: EwayBillRecord,
  action: EwayBillAction,
): { updatedRecord: EwayBillRecord; auditEntry: Record<string, unknown> } {
  const now = new Date().toISOString();
  const updated = { ...record, updatedAt: now };

  switch (action.type) {
    case "update-vehicle":
      updated.vehicleNo = action.data.vehicleNo as string | undefined;
      updated.transportMode = (action.data.transportMode as TransportMode | undefined) ?? record.transportMode;
      break;
    case "extend-validity":
      // Can extend only before expiry, max 8 days total
      const currentExpiry = new Date(record.validUpto);
      const newExpiry = new Date(action.data.newValidUpto as string);
      const maxExpiry = new Date(record.ewayBillDate);
      maxExpiry.setDate(maxExpiry.getDate() + 8); // Max 8 days from generation
      if (newExpiry > maxExpiry) {
        throw new EwayBillError("Cannot extend validity beyond 8 days from generation date.");
      }
      if (new Date() > currentExpiry) {
        throw new EwayBillError("Cannot extend validity after expiry.");
      }
      updated.validUpto = action.data.newValidUpto as string;
      updated.daysValid = Math.ceil((newExpiry.getTime() - new Date(record.ewayBillDate).getTime()) / 86400000);
      break;
    case "cancel":
      if (record.status === "cancelled") {
        throw new EwayBillError("E-Way Bill already cancelled.");
      }
      if (record.status === "verified") {
        throw new EwayBillError("Cannot cancel verified E-Way Bill.");
      }
      // Cancellation within 24 hours of generation (Rule 138(14))
      const genDate = new Date(record.ewayBillDate);
      const hoursSinceGen = (new Date().getTime() - genDate.getTime()) / 3600000;
      if (hoursSinceGen > 24) {
        throw new EwayBillError("E-Way Bill can only be cancelled within 24 hours of generation.");
      }
      updated.status = "cancelled";
      updated.cancelledAt = now;
      updated.cancelledBy = action.actorId;
      updated.cancellationReason = action.reason ?? "Cancelled by taxpayer";
      break;
    case "verify":
      updated.status = "verified";
      updated.verifiedAt = now;
      updated.verifiedBy = action.actorId;
      updated.verificationRemarks = action.data.remarks as string | undefined;
      break;
    case "reject":
      updated.status = "rejected";
      break;
    case "consolidate":
      updated.isMultiVehicle = true;
      updated.childEwayBillNos = action.data.childEwayBillNos as string[];
      break;
  }

  const auditEntry = {
    entityType: "EwayBill",
    entityId: record.id,
    action: action.type,
    fieldChanges: JSON.stringify({ action: action.type, data: action.data }),
    actorId: action.actorId,
    createdAt: now,
  };

  return { updatedRecord: updated, auditEntry };
}

// ---------------------------------------------------------------------------
// Penalty Calculation (s 129 / s 130)
// ---------------------------------------------------------------------------

export interface EwayBillPenalty {
  applicable: boolean;
  section: string;
  penaltyAmount: number;
  taxAmount: number;
  reason: string;
  compoundable: boolean;
}

/**
 * Calculate penalty for E-Way Bill violations.
 * s 129: Detention, seizure for non-generation / mismatch
 * s 130: Confiscation for tax evasion
 */
export function calculateEwayBillPenalty(
  violation:
    "not-generated" | "value-mismatch" | "invalid-transport" | "expired-transit" | "fake-bill" | "goods-mismatch",
  taxInvolved: number, // tax amount involved
  goodsValue: number,
  isExempt: boolean = false,
): EwayBillPenalty {
  if (isExempt) {
    return {
      applicable: false,
      section: "",
      penaltyAmount: 0,
      taxAmount: 0,
      reason: "Exempt goods — no penalty under s 129",
      compoundable: false,
    };
  }

  switch (violation) {
    case "not-generated":
      // s 129(1)(a): 100% of tax or ₹10,000 whichever is higher
      return {
        applicable: true,
        section: "s 129(1)(a)",
        penaltyAmount: Math.max(taxInvolved, INR(10000)),
        taxAmount: taxInvolved,
        reason: "E-Way Bill not generated for taxable supply > ₹50,000",
        compoundable: true,
      };
    case "value-mismatch":
      // s 129(1)(b): 100% of tax or ₹10,000 whichever is higher
      return {
        applicable: true,
        section: "s 129(1)(b)",
        penaltyAmount: Math.max(taxInvolved, INR(10000)),
        taxAmount: taxInvolved,
        reason: "Value in E-Way Bill differs from actual goods value",
        compoundable: true,
      };
    case "invalid-transport":
      // s 129(1)(c): 50% of tax or ₹10,000 whichever is higher
      return {
        applicable: true,
        section: "s 129(1)(c)",
        penaltyAmount: Math.max(Math.round(taxInvolved / 2), INR(10000)),
        taxAmount: taxInvolved,
        reason: "Transport details invalid / vehicle not as declared",
        compoundable: true,
      };
    case "expired-transit":
      // s 129(1)(d): 50% of tax or ₹10,000 whichever is higher
      return {
        applicable: true,
        section: "s 129(1)(d)",
        penaltyAmount: Math.max(Math.round(taxInvolved / 2), INR(10000)),
        taxAmount: taxInvolved,
        reason: "E-Way Bill expired during transit",
        compoundable: true,
      };
    case "fake-bill":
      // s 130: Confiscation + penalty 100% tax
      return {
        applicable: true,
        section: "s 130",
        penaltyAmount: taxInvolved,
        taxAmount: taxInvolved,
        reason: "Fake / bogus E-Way Bill generated",
        compoundable: false,
      };
    case "goods-mismatch":
      // s 129(1)(e): 50% of tax or ₹10,000
      return {
        applicable: true,
        section: "s 129(1)(e)",
        penaltyAmount: Math.max(Math.round(taxInvolved / 2), INR(10000)),
        taxAmount: taxInvolved,
        reason: "Goods description / HSN mismatch with E-Way Bill",
        compoundable: true,
      };
  }
}

const ewayBillApi = {
  calculateEwayBillValidity,
  buildEwayBillPayload,
  validateEwayBillInput,
  buildConsolidatedEwayBillPayload,
  validateEwayBillInvoiceLink,
  processEwayBillAction,
  calculateEwayBillPenalty,
  EwayBillError,
};

export default ewayBillApi;
