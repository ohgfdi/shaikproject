/**
 * Multi-GSTIN / State Entity Management Engine
 *
 * Handles:
 * - Entity with multiple GSTINs across states
 * - Composition vs Regular scheme classification
 * - Place of Supply vs Supplier State mismatch detection
 * - Cross-GSTIN ITC allocation and reversal
 * - State-wise GSTR-1/3B filing coordination
 */

import { INR, formatInr, gstinStateCode, isValidGstin } from "./india-tax";

export class MultiGstinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiGstinError";
  }
}

// ---------------------------------------------------------------------------
// Entity Types
// ---------------------------------------------------------------------------

export type GstinStatus = "active" | "suspended" | "cancelled" | "pending-verification";
export type RegistrationType =
  "regular" | "composition" | "tcs-collector" | "tds-deductor" | "non-resident" | "casual" | "isd";

export interface GstinRegistration {
  gstin: string;
  legalName: string;
  tradeName?: string;
  stateCode: string;
  stateName: string;
  registrationType: RegistrationType;
  status: GstinStatus;
  registrationDate: string; // yyyy-mm-dd
  cancellationDate?: string;
  address: {
    buildingNo: string;
    street: string;
    city: string;
    district: string;
    pincode: number;
  };
  constitution: "proprietorship" | "partnership" | "company" | "llp" | "huf" | "trust" | "government" | "other";
  authorizedSignatories: Array<{
    name: string;
    designation: string;
    pan: string;
    mobile: string;
    email: string;
  }>;
}

export interface MultiGstinEntity {
  id: string;
  entityName: string;
  pan: string;
  entityType: "company" | "llp" | "partnership" | "proprietorship" | "huf" | "trust" | "other";
  gstinRegistrations: GstinRegistration[];
  primaryGstin: string; // The main GSTIN for the entity
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Mismatch Detection
// ---------------------------------------------------------------------------

export type MismatchType =
  | "pos-supplier-state-mismatch" // Place of supply != supplier state
  | "pos-recipient-state-mismatch" // POS != recipient state (B2C inter-state)
  | "composition-interstate-supply" // Composition dealer making inter-state supply
  | "composition-rcm-liability" // Composition dealer liable to RCM
  | "gstin-state-mismatch" // GSTIN state code doesn't match registration
  | "invalid-gstin-format" // GSTIN fails format validation
  | "cancelled-gstin-used" // Invoice on cancelled/suspended GSTIN
  | "composition-b2b-supply"; // Composition dealer making B2B supply

export interface GstinMismatch {
  type: MismatchType;
  severity: "error" | "warning" | "info";
  gstin: string;
  invoiceNumber?: string;
  field: string;
  message: string;
  suggestion: string;
  ruleReference: string;
}

export interface SupplyContext {
  supplierGstin: string;
  supplierStateCode: string;
  recipientGstin?: string | null;
  recipientStateCode?: string | null;
  placeOfSupply: string;
  supplyType: "intra" | "inter";
  invoiceType: "b2b" | "b2c" | "export" | "sezwop" | "credit-note" | "debit-note";
  invoiceNumber: string;
  invoiceDate: string;
  taxableValue: number;
}

/**
 * Validate a supply context against the entity's GSTIN registrations
 * and detect all compliance mismatches.
 */
export function validateSupplyAgainstEntity(context: SupplyContext, entity: MultiGstinEntity): GstinMismatch[] {
  const mismatches: GstinMismatch[] = [];

  // Find supplier registration
  const supplierReg = entity.gstinRegistrations.find((r) => r.gstin === context.supplierGstin);
  if (!supplierReg) {
    mismatches.push({
      type: "invalid-gstin-format",
      severity: "error",
      gstin: context.supplierGstin,
      invoiceNumber: context.invoiceNumber,
      field: "supplierGstin",
      message: `Supplier GSTIN ${context.supplierGstin} not registered under this entity.`,
      suggestion: "Add the GSTIN to the entity or verify the correct GSTIN.",
      ruleReference: "s 22/24 CGST Act",
    });
    return mismatches;
  }

  // 1. GSTIN format validation
  if (!isValidGstin(context.supplierGstin)) {
    mismatches.push({
      type: "invalid-gstin-format",
      severity: "error",
      gstin: context.supplierGstin,
      invoiceNumber: context.invoiceNumber,
      field: "supplierGstin",
      message: `Supplier GSTIN ${context.supplierGstin} has invalid format.`,
      suggestion: "Verify GSTIN format: 2-digit state code + PAN + check digit.",
      ruleReference: "GSTIN Format Rules",
    });
  }

  // 2. GSTIN state code matches registration state
  const gstinState = gstinStateCode(context.supplierGstin);
  if (gstinState && gstinState !== supplierReg.stateCode) {
    mismatches.push({
      type: "gstin-state-mismatch",
      severity: "error",
      gstin: context.supplierGstin,
      invoiceNumber: context.invoiceNumber,
      field: "supplierGstin",
      message: `GSTIN state code (${gstinState}) does not match registered state (${supplierReg.stateCode}).`,
      suggestion: "Verify GSTIN and registration state match.",
      ruleReference: "s 25 CGST Act",
    });
  }

  // 3. Cancelled/suspended GSTIN check
  if (supplierReg.status === "cancelled" || supplierReg.status === "suspended") {
    mismatches.push({
      type: "cancelled-gstin-used",
      severity: "error",
      gstin: context.supplierGstin,
      invoiceNumber: context.invoiceNumber,
      field: "supplierGstin",
      message: `Invoice issued on ${supplierReg.status} GSTIN ${context.supplierGstin}.`,
      suggestion: "Use an active GSTIN for new supplies.",
      ruleReference: "s 29 CGST Act",
    });
  }

  // 4. Place of Supply vs Supplier State mismatch
  if (context.placeOfSupply !== supplierReg.stateCode) {
    const severity = context.supplyType === "inter" ? "info" : "warning";
    mismatches.push({
      type: "pos-supplier-state-mismatch",
      severity,
      gstin: context.supplierGstin,
      invoiceNumber: context.invoiceNumber,
      field: "placeOfSupply",
      message: `Place of supply (${context.placeOfSupply}) differs from supplier state (${supplierReg.stateCode}). Supply is ${context.supplyType}-state.`,
      suggestion:
        severity === "warning"
          ? "Verify POS determination rules. Intra-state supply with POS != supplier state is unusual."
          : "Inter-state supply — POS different from supplier state is normal.",
      ruleReference: "s 10-13 IGST Act (POS Rules)",
    });
  }

  // 5. Composition scheme restrictions
  if (supplierReg.registrationType === "composition") {
    // Composition cannot make inter-state supply
    if (context.supplyType === "inter") {
      mismatches.push({
        type: "composition-interstate-supply",
        severity: "error",
        gstin: context.supplierGstin,
        invoiceNumber: context.invoiceNumber,
        field: "supplyType",
        message: "Composition dealer cannot make inter-state supply (s 10 CGST Act).",
        suggestion: "Change to regular registration for inter-state supplies.",
        ruleReference: "s 10(1) CGST Act",
      });
    }

    // Composition cannot collect tax / issue tax invoice
    if (context.invoiceType === "b2b" || context.invoiceType === "b2c") {
      mismatches.push({
        type: "composition-b2b-supply",
        severity: "error",
        gstin: context.supplierGstin,
        invoiceNumber: context.invoiceNumber,
        field: "invoiceType",
        message: "Composition dealer cannot issue tax invoice or collect tax.",
        suggestion: "Issue bill of supply, not tax invoice. No tax collection.",
        ruleReference: "s 10(2) CGST Act, Rule 7 CGST Rules",
      });
    }

    // Composition cannot be liable to RCM (they pay tax on reverse charge as recipient)
    // This is handled separately in RCM engine
  }

  // 6. B2C inter-state: POS vs Recipient state (for B2CL threshold)
  if (context.invoiceType === "b2c" && context.supplyType === "inter" && context.recipientStateCode) {
    if (context.placeOfSupply !== context.recipientStateCode) {
      mismatches.push({
        type: "pos-recipient-state-mismatch",
        severity: "warning",
        gstin: context.supplierGstin,
        invoiceNumber: context.invoiceNumber,
        field: "placeOfSupply",
        message: `B2C inter-state: POS (${context.placeOfSupply}) != recipient state (${context.recipientStateCode}). For B2C, POS = recipient location.`,
        suggestion: "Verify recipient location for correct POS determination.",
        ruleReference: "s 12(2) IGST Act",
      });
    }
  }

  return mismatches;
}

// ---------------------------------------------------------------------------
// State-wise Return Filing Coordination
// ---------------------------------------------------------------------------

export interface StateReturnSummary {
  stateCode: string;
  stateName: string;
  gstin: string;
  registrationType: RegistrationType;
  gstr1: {
    b2bInvoices: number;
    b2clInvoices: number;
    b2csInvoices: number;
    exportInvoices: number;
    nilExemptInvoices: number;
    totalTaxableValue: number;
    totalTax: number;
  };
  gstr3b: {
    outwardTaxable: number;
    outwardTax: number;
    inwardItc: number;
    netLiability: number;
    itcReversed: number;
  };
  dueDate: string; // GSTR-1 due date
  gstr3bDueDate: string; // GSTR-3B due date
}

export interface MultiGstinReturnPlan {
  entityId: string;
  period: string; // yyyy-mm
  stateSummaries: StateReturnSummary[];
  consolidated: {
    totalOutwardTaxable: number;
    totalOutwardTax: number;
    totalInwardItc: number;
    totalNetLiability: number;
  };
  crossGstinItcAllocation: CrossGstinItcAllocation[];
  methodology: string[];
}

export interface CrossGstinItcAllocation {
  fromGstin: string;
  toGstin: string;
  itcAmount: number;
  reason: "isdd" | "branch-transfer" | "common-credit" | "adjustment";
  documentRef: string;
}

/**
 * Generate state-wise return filing plan for a multi-GSTIN entity.
 */
export function generateMultiGstinReturnPlan(
  entity: MultiGstinEntity,
  period: string,
  opts: {
    outwardInvoices: SupplyContext[];
    inwardInvoices: SupplyContext[]; // for ITC
    crossGstinAllocations?: CrossGstinItcAllocation[];
  },
): MultiGstinReturnPlan {
  const methodology: string[] = [];
  const stateSummaries: StateReturnSummary[] = [];
  const activeRegistrations = entity.gstinRegistrations.filter((r) => r.status === "active");

  for (const reg of activeRegistrations) {
    const stateOutward = opts.outwardInvoices.filter((inv) => inv.supplierGstin === reg.gstin);
    const stateInward = opts.inwardInvoices.filter((inv) => inv.recipientGstin === reg.gstin);

    const gstr1 = {
      b2bInvoices: stateOutward.filter((i) => i.invoiceType === "b2b").length,
      b2clInvoices: stateOutward.filter((i) => i.invoiceType === "b2c" && i.supplyType === "inter").length,
      b2csInvoices: stateOutward.filter((i) => i.invoiceType === "b2c" && i.supplyType === "intra").length,
      exportInvoices: stateOutward.filter((i) => i.invoiceType === "export").length,
      nilExemptInvoices: stateOutward.filter((i) => i.taxableValue === 0).length,
      totalTaxableValue: stateOutward.reduce((s, i) => s + i.taxableValue, 0),
      totalTax: 0, // calculated below
    };

    // Calculate tax (simplified - would need rate per invoice)
    const outwardTax = stateOutward.reduce((s, i) => {
      // Simplified: assume 18% for taxable
      return s + (i.taxableValue > 0 ? Math.round(i.taxableValue * 0.18) : 0);
    }, 0);
    gstr1.totalTax = outwardTax;

    const inwardItc = stateInward.reduce((s, i) => {
      // Simplified: assume 18% for eligible ITC
      return s + (i.taxableValue > 0 ? Math.round(i.taxableValue * 0.18) : 0);
    }, 0);

    const summary: StateReturnSummary = {
      stateCode: reg.stateCode,
      stateName: reg.stateName,
      gstin: reg.gstin,
      registrationType: reg.registrationType,
      gstr1,
      gstr3b: {
        outwardTaxable: gstr1.totalTaxableValue,
        outwardTax: outwardTax,
        inwardItc,
        netLiability: Math.max(0, outwardTax - inwardItc),
        itcReversed: 0,
      },
      dueDate: getGstr1DueDate(reg.registrationType, period),
      gstr3bDueDate: getGstr3bDueDate(reg.registrationType, period),
    };
    stateSummaries.push(summary);
  }

  // Cross-GSTIN ITC allocation
  const crossGstinItcAllocation = opts.crossGstinAllocations ?? [];

  // Consolidated totals
  const consolidated = {
    totalOutwardTaxable: stateSummaries.reduce((s, st) => s + st.gstr1.totalTaxableValue, 0),
    totalOutwardTax: stateSummaries.reduce((s, st) => s + st.gstr1.totalTax, 0),
    totalInwardItc: stateSummaries.reduce((s, st) => s + st.gstr3b.inwardItc, 0),
    totalNetLiability: stateSummaries.reduce((s, st) => s + st.gstr3b.netLiability, 0),
  };

  methodology.push(`Generated return plan for ${activeRegistrations.length} active GSTINs for period ${period}.`);
  methodology.push(
    `Consolidated outward taxable: ${formatInr(consolidated.totalOutwardTaxable)}, tax: ${formatInr(consolidated.totalOutwardTax)}.`,
  );
  methodology.push(
    `Consolidated inward ITC: ${formatInr(consolidated.totalInwardItc)}, net liability: ${formatInr(consolidated.totalNetLiability)}.`,
  );
  methodology.push("Each GSTIN files separate GSTR-1 and GSTR-3B. ISD mechanism for common credit distribution.");

  return {
    entityId: entity.id,
    period,
    stateSummaries,
    consolidated,
    crossGstinItcAllocation,
    methodology,
  };
}

function getGstr1DueDate(regType: RegistrationType, period: string): string {
  const [year = 0, month = 0] = period.split("-").map(Number);
  const dueDay = regType === "composition" ? 13 : 11;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`;
}

function getGstr3bDueDate(regType: RegistrationType, period: string): string {
  const [year = 0, month = 0] = period.split("-").map(Number);
  const dueDay = regType === "composition" ? 18 : 20;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// ISD (Input Service Distributor) Credit Distribution
// ---------------------------------------------------------------------------

export interface IsdDistribution {
  isdGstin: string;
  period: string;
  commonCredit: {
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
  };
  distributions: Array<{
    recipientGstin: string;
    recipientState: string;
    ratio: number; // 0-1
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
  }>;
  methodology: string[];
}

/**
 * Distribute common ITC (Input Service Distributor) across GSTINs.
 * s 20 IGST Act / Rule 39 CGST Rules.
 */
export function distributeIsdCredit(
  isdGstin: string,
  period: string,
  commonCredit: { igst: number; cgst: number; sgst: number; cess: number },
  recipients: Array<{ gstin: string; stateCode: string; turnoverRatio: number }>,
): IsdDistribution {
  const methodology: string[] = [];
  const totalRatio = recipients.reduce((s, r) => s + r.turnoverRatio, 0);

  if (Math.abs(totalRatio - 1) > 0.01) {
    methodology.push(`Warning: Turnover ratios sum to ${totalRatio}, expected 1.0. Normalizing.`);
  }

  const distributions = recipients.map((r) => {
    const ratio = r.turnoverRatio / totalRatio;
    return {
      recipientGstin: r.gstin,
      recipientState: r.stateCode,
      ratio,
      igst: Math.round(commonCredit.igst * ratio),
      cgst: Math.round(commonCredit.cgst * ratio),
      sgst: Math.round(commonCredit.sgst * ratio),
      cess: Math.round(commonCredit.cess * ratio),
    };
  });

  methodology.push(`ISD ${isdGstin} distributing common credit for ${period}.`);
  methodology.push(
    `Total common credit: IGST ${formatInr(commonCredit.igst)}, CGST ${formatInr(commonCredit.cgst)}, SGST ${formatInr(commonCredit.sgst)}, Cess ${formatInr(commonCredit.cess)}.`,
  );
  methodology.push(
    `Distributed to ${recipients.length} recipient GSTINs based on turnover ratio (s 20 IGST Act, Rule 39).`,
  );

  return { isdGstin, period, commonCredit, distributions, methodology };
}

// ---------------------------------------------------------------------------
// Branch Transfer / Stock Transfer Valuation
// ---------------------------------------------------------------------------

export interface BranchTransfer {
  fromGstin: string;
  toGstin: string;
  fromState: string;
  toState: string;
  items: Array<{
    hsn: string;
    description: string;
    quantity: number;
    unit: string;
    valuePerUnit: number;
    totalValue: number;
  }>;
  invoiceNumber: string;
  invoiceDate: string;
  ewayBillRequired: boolean;
  ewayBillNumber?: string;
}

/**
 * Validate branch/stock transfer between GSTINs of same entity.
 * s 25(4) CGST Act: distinct persons, supply even without consideration.
 * Taxable value = transaction value (open market value) or s 15 valuation rules.
 */
export function validateBranchTransfer(
  transfer: BranchTransfer,
  entity: MultiGstinEntity,
): {
  valid: boolean;
  mismatches: GstinMismatch[];
  taxLiability: { igst: number; cgst: number; sgst: number; cess: number };
} {
  const mismatches: GstinMismatch[] = [];
  const fromReg = entity.gstinRegistrations.find((r) => r.gstin === transfer.fromGstin);
  const toReg = entity.gstinRegistrations.find((r) => r.gstin === transfer.toGstin);

  if (!fromReg) {
    mismatches.push({
      type: "invalid-gstin-format",
      severity: "error",
      gstin: transfer.fromGstin,
      field: "fromGstin",
      message: `Source GSTIN ${transfer.fromGstin} not found in entity.`,
      suggestion: "Add GSTIN to entity registration.",
      ruleReference: "s 25 CGST Act",
    });
  }

  if (!toReg) {
    mismatches.push({
      type: "invalid-gstin-format",
      severity: "error",
      gstin: transfer.toGstin,
      field: "toGstin",
      message: `Destination GSTIN ${transfer.toGstin} not found in entity.`,
      suggestion: "Add GSTIN to entity registration.",
      ruleReference: "s 25 CGST Act",
    });
  }

  if (fromReg && toReg && fromReg.gstin === toReg.gstin) {
    mismatches.push({
      type: "gstin-state-mismatch",
      severity: "error",
      gstin: fromReg.gstin,
      field: "fromGstin/toGstin",
      message: "Source and destination GSTIN cannot be the same.",
      suggestion: "Use different GSTINs for branch transfer.",
      ruleReference: "s 25(4) CGST Act",
    });
  }

  // Inter-state branch transfer = IGST
  const isInterState = transfer.fromState !== transfer.toState;
  const totalValue = transfer.items.reduce((s, i) => s + i.totalValue, 0);
  // Assume 18% for calculation
  const rate = 18;
  const tax = Math.round((totalValue * rate) / 100);

  let taxLiability = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  if (isInterState) {
    taxLiability = { igst: tax, cgst: 0, sgst: 0, cess: 0 };
  } else {
    taxLiability = { igst: 0, cgst: Math.round(tax / 2), sgst: tax - Math.round(tax / 2), cess: 0 };
  }

  // E-way bill required if value > 50000
  const ewayRequired = totalValue > INR(50000);
  if (ewayRequired && !transfer.ewayBillRequired) {
    mismatches.push({
      type: "pos-supplier-state-mismatch",
      severity: "warning",
      gstin: transfer.fromGstin,
      invoiceNumber: transfer.invoiceNumber,
      field: "ewayBillRequired",
      message: `Branch transfer value ${formatInr(totalValue)} exceeds ₹50,000 — E-way bill required.`,
      suggestion: "Generate E-way bill before dispatch.",
      ruleReference: "Rule 138 CGST Rules",
    });
  }

  return { valid: mismatches.length === 0, mismatches, taxLiability };
}

const gstMultiGstinEngine = {
  validateSupplyAgainstEntity,
  generateMultiGstinReturnPlan,
  distributeIsdCredit,
  validateBranchTransfer,
  MultiGstinError,
};

export default gstMultiGstinEngine;
