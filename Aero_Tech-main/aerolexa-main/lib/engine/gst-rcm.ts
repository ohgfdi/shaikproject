/**
 * RCM Capture Engine — Reverse Charge Mechanism handling with ITC eligibility logic.
 *
 * Covers:
 *   s 9(3)  — Notified goods/services under RCM (GTA, legal, sponsorship, director fees, etc.)
 *   s 9(4)  — Unregistered supplier to registered recipient (suspended but tracked for future)
 *   s 9(5)  — E-commerce operator liability (OIDAR, transport, restaurant)
 *
 * ITC on RCM:
 *   - Tax paid under RCM is eligible as ITC in the SAME month (Table 4(A)(3) of GSTR-3B)
 *   - But ONLY after the tax is actually PAID (cash or ITC)
 *   - s 16(2)(aa) does NOT apply to RCM invoices (supplier doesn't file GSTR-1)
 *   - s 17(5) blocked credits still apply to the underlying supply
 */

import { formatInr } from "./india-tax";

export class RcmEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RcmEngineError";
  }
}

// ---------------------------------------------------------------------------
// RCM Category Definitions (s 9(3) notified supplies)
// ---------------------------------------------------------------------------

export type RcmCategory =
  | "gta" // Goods Transport Agency
  | "legal-service" // Legal services by advocate/firm
  | "sponsorship" // Sponsorship services
  | "director-fees" // Director sitting fees
  | "insurance-agent" // Insurance agent commission
  | "recovery-agent" // Recovery agent services
  | "authorised-dealer" // Authorised dealer forex
  | "immovable-property-works" // Works contract immovable property (govt)
  | "renting-immovable-property" // Renting immovable property (govt)
  | "government-supply" // Supply by Govt to business entity
  | "import-of-services" // Import of services (s 9(3) + IGST Act)
  | "ecom-transport" // ECO: passenger transport (radio taxi etc)
  | "ecom-restaurant" // ECO: restaurant services
  | "ecom-housekeeping" // ECO: housekeeping/placement
  | "ecom-other"; // ECO: other notified services

export const RCM_CATEGORIES: Record<RcmCategory, { label: string; section: string; ratePct: number }> = {
  gta: { label: "Goods Transport Agency (GTA)", section: "s 9(3) Notif 13/2017", ratePct: 5 },
  "legal-service": { label: "Legal services by advocate/firm", section: "s 9(3) Notif 13/2017", ratePct: 18 },
  sponsorship: { label: "Sponsorship services", section: "s 9(3) Notif 13/2017", ratePct: 18 },
  "director-fees": { label: "Director sitting fees", section: "s 9(3) Notif 13/2017", ratePct: 18 },
  "insurance-agent": { label: "Insurance agent commission", section: "s 9(3) Notif 13/2017", ratePct: 18 },
  "recovery-agent": { label: "Recovery agent services", section: "s 9(3) Notif 13/2017", ratePct: 18 },
  "authorised-dealer": { label: "Authorised dealer forex", section: "s 9(3) Notif 13/2017", ratePct: 18 },
  "immovable-property-works": {
    label: "Works contract immovable property (Govt)",
    section: "s 9(3) Notif 13/2017",
    ratePct: 18,
  },
  "renting-immovable-property": {
    label: "Renting immovable property (Govt)",
    section: "s 9(3) Notif 13/2017",
    ratePct: 18,
  },
  "government-supply": { label: "Supply by Govt to business entity", section: "s 9(3) Notif 13/2017", ratePct: 18 },
  "import-of-services": { label: "Import of services", section: "s 9(3) + IGST Act s 5", ratePct: 18 },
  "ecom-transport": {
    label: "ECO: Passenger transport (radio taxi, etc.)",
    section: "s 9(5) Notif 14/2017",
    ratePct: 5,
  },
  "ecom-restaurant": { label: "ECO: Restaurant services", section: "s 9(5) Notif 14/2017", ratePct: 5 },
  "ecom-housekeeping": { label: "ECO: Housekeeping/placement services", section: "s 9(5) Notif 14/2017", ratePct: 18 },
  "ecom-other": { label: "ECO: Other notified services", section: "s 9(5) Notif 14/2017", ratePct: 18 },
};

export interface RcmSupply {
  category: RcmCategory;
  supplierGstin?: string | null;
  supplierName: string;
  recipientGstin: string;
  recipientName: string;
  placeOfSupply: string;
  taxableValue: number;
  invoiceNumber: string;
  invoiceDate: string;
  hsnSac: string;
  isImportOfService?: boolean;
  isEcom?: boolean;
  ecomGstin?: string | null;
}

// ---------------------------------------------------------------------------
// ITC Eligibility on RCM
// ---------------------------------------------------------------------------

export type RcmItcStatus =
  | "eligible-after-payment" // Standard: eligible in Table 4(A)(3) after tax paid
  | "blocked-s17-5" // Underlying supply is s17(5) blocked
  | "ineligible-personal" // Personal consumption
  | "ineligible-capital-goods" // Capital goods used for exempt/personal
  | "pending-payment"; // Tax not yet paid

export interface RcmItcEligibility {
  status: RcmItcStatus;
  reason: string;
  blockedSection?: string;
  payableTax: { igst: number; cgst: number; sgst: number; cess: number };
  claimableItc: { igst: number; cgst: number; sgst: number; cess: number };
  methodology: string[];
}

export interface RcmTaxAmounts {
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

/** Calculate RCM tax for a supply. Intra-state = CGST+SGST, Inter-state = IGST. */
export function calculateRcmTax(supply: RcmSupply, recipientStateCode: string): RcmTaxAmounts {
  const cat = RCM_CATEGORIES[supply.category];
  const rate = cat.ratePct;
  const taxableValue = supply.taxableValue;
  const totalTax = Math.round((taxableValue * rate) / 100);

  const isInterState = supply.placeOfSupply !== recipientStateCode;
  const cess = 0; // RCM supplies typically don't have cess unless specifically notified

  if (isInterState) {
    return { taxableValue, igst: totalTax, cgst: 0, sgst: 0, cess };
  } else {
    const half = Math.round(totalTax / 2);
    return { taxableValue, igst: 0, cgst: half, sgst: totalTax - half, cess };
  }
}

/**
 * Determine ITC eligibility for RCM supply.
 * Rules:
 * 1. ITC eligible under Table 4(A)(3) ONLY after tax is paid (cash or ITC)
 * 2. s 17(5) blocked credits apply to the underlying supply nature
 * 3. s 16(2)(aa) does NOT apply (supplier doesn't file GSTR-1 for RCM)
 * 4. Import of services: eligible if for business, blocked if personal
 */
export function determineRcmItcEligibility(
  _supply: RcmSupply,
  taxAmounts: RcmTaxAmounts,
  opts: {
    isBusinessPurpose: boolean;
    isCapitalGoods?: boolean;
    blockedCategory?:
      "motor-vehicle" | "food-beverages" | "club-membership" | "personal" | "csr" | "works-contract-immovable" | null;
    taxPaid?: boolean;
  },
): RcmItcEligibility {
  const methodology: string[] = [];
  const totalTax = taxAmounts.igst + taxAmounts.cgst + taxAmounts.sgst + taxAmounts.cess;

  // Check s 17(5) blocked categories
  if (opts.blockedCategory) {
    const blockedLabels: Record<string, string> = {
      "motor-vehicle": "Motor vehicle (s 17(5)(a))",
      "food-beverages": "Food & beverages (s 17(5)(b)(i))",
      "club-membership": "Club membership (s 17(5)(b)(iii))",
      personal: "Personal consumption (s 17(5)(g))",
      csr: "CSR expenditure (s 17(5)(k))",
      "works-contract-immovable": "Works contract immovable property (s 17(5)(c))",
    };
    methodology.push(`Underlying supply is ${blockedLabels[opts.blockedCategory]} — ITC blocked under s 17(5).`);
    return {
      status: "blocked-s17-5",
      reason: `ITC blocked: ${blockedLabels[opts.blockedCategory]}`,
      blockedSection: "s 17(5)",
      payableTax: { igst: taxAmounts.igst, cgst: taxAmounts.cgst, sgst: taxAmounts.sgst, cess: taxAmounts.cess },
      claimableItc: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
      methodology,
    };
  }

  // Personal consumption check
  if (!opts.isBusinessPurpose) {
    methodology.push("Supply is for personal consumption — ITC ineligible under s 17(5)(g).");
    return {
      status: "ineligible-personal",
      reason: "Personal consumption — ITC ineligible under s 17(5)(g)",
      blockedSection: "s 17(5)(g)",
      payableTax: { igst: taxAmounts.igst, cgst: taxAmounts.cgst, sgst: taxAmounts.sgst, cess: taxAmounts.cess },
      claimableItc: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
      methodology,
    };
  }

  // Capital goods used for exempt supply
  if (opts.isCapitalGoods) {
    methodology.push(
      "Capital goods — ITC eligibility depends on use (taxable vs exempt). Assuming taxable use for now.",
    );
  }

  // Tax payment check
  if (!opts.taxPaid) {
    methodology.push(
      `RCM tax of ${formatInr(totalTax)} is payable. ITC under Table 4(A)(3) available ONLY after payment (cash or ITC).`,
    );
    return {
      status: "pending-payment",
      reason: "RCM tax not yet paid — ITC claimable after payment",
      payableTax: { igst: taxAmounts.igst, cgst: taxAmounts.cgst, sgst: taxAmounts.sgst, cess: taxAmounts.cess },
      claimableItc: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
      methodology,
    };
  }

  // Eligible after payment
  methodology.push(`RCM tax of ${formatInr(totalTax)} paid. ITC eligible under Table 4(A)(3) of GSTR-3B.`);
  methodology.push("s 16(2)(aa) does not apply to RCM — supplier not required to file GSTR-1 for RCM supplies.");
  return {
    status: "eligible-after-payment",
    reason: "RCM tax paid — ITC eligible in Table 4(A)(3)",
    payableTax: { igst: taxAmounts.igst, cgst: taxAmounts.cgst, sgst: taxAmounts.sgst, cess: taxAmounts.cess },
    claimableItc: { igst: taxAmounts.igst, cgst: taxAmounts.cgst, sgst: taxAmounts.sgst, cess: taxAmounts.cess },
    methodology,
  };
}

// ---------------------------------------------------------------------------
// RCM Register Entry (for monthly RCM tracking)
// ---------------------------------------------------------------------------

export interface RcmRegisterEntry {
  id: string;
  period: string; // yyyy-mm
  supply: RcmSupply;
  taxAmounts: RcmTaxAmounts;
  itcEligibility: RcmItcEligibility;
  paymentStatus: "unpaid" | "paid-cash" | "paid-itc" | "partial";
  paymentDate?: string;
  paymentReference?: string;
  gstr3bTable4A3Reported: boolean;
  createdAt: string;
  createdById: string;
}

/**
 * Build monthly RCM liability and ITC register for GSTR-3B Table 4(A)(3).
 * Returns the aggregate payable tax and claimable ITC for the period.
 */
export function buildRcmRegister(entries: RcmRegisterEntry[]): {
  payableTax: { igst: number; cgst: number; sgst: number; cess: number; total: number };
  claimableItc: { igst: number; cgst: number; sgst: number; cess: number; total: number };
  pendingItc: { igst: number; cgst: number; sgst: number; cess: number; total: number };
  byCategory: Record<RcmCategory, { count: number; taxableValue: number; tax: number }>;
  methodology: string[];
} {
  const payableTax = { igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };
  const claimableItc = { igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };
  const pendingItc = { igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };
  const byCategory: Record<string, { count: number; taxableValue: number; tax: number }> = {};

  for (const entry of entries) {
    const tax = entry.taxAmounts;
    const cat = entry.supply.category;

    payableTax.igst += tax.igst;
    payableTax.cgst += tax.cgst;
    payableTax.sgst += tax.sgst;
    payableTax.cess += tax.cess;
    payableTax.total += tax.igst + tax.cgst + tax.sgst + tax.cess;

    if (entry.itcEligibility.status === "eligible-after-payment") {
      claimableItc.igst += entry.itcEligibility.claimableItc.igst;
      claimableItc.cgst += entry.itcEligibility.claimableItc.cgst;
      claimableItc.sgst += entry.itcEligibility.claimableItc.sgst;
      claimableItc.cess += entry.itcEligibility.claimableItc.cess;
      claimableItc.total +=
        entry.itcEligibility.claimableItc.igst +
        entry.itcEligibility.claimableItc.cgst +
        entry.itcEligibility.claimableItc.sgst +
        entry.itcEligibility.claimableItc.cess;
    } else if (entry.itcEligibility.status === "pending-payment") {
      pendingItc.igst += entry.itcEligibility.payableTax.igst;
      pendingItc.cgst += entry.itcEligibility.payableTax.cgst;
      pendingItc.sgst += entry.itcEligibility.payableTax.sgst;
      pendingItc.cess += entry.itcEligibility.payableTax.cess;
      pendingItc.total +=
        entry.itcEligibility.payableTax.igst +
        entry.itcEligibility.payableTax.cgst +
        entry.itcEligibility.payableTax.sgst +
        entry.itcEligibility.payableTax.cess;
    }

    const existing = byCategory[cat] ?? { count: 0, taxableValue: 0, tax: 0 };
    existing.count += 1;
    existing.taxableValue += entry.supply.taxableValue;
    existing.tax += tax.igst + tax.cgst + tax.sgst + tax.cess;
    byCategory[cat] = existing;
  }

  return {
    payableTax,
    claimableItc,
    pendingItc,
    byCategory: byCategory as Record<RcmCategory, { count: number; taxableValue: number; tax: number }>,
    methodology: [
      `Processed ${entries.length} RCM supplies for the period.`,
      `RCM tax payable: ${formatInr(payableTax.total)} (IGST ${formatInr(payableTax.igst)}, CGST ${formatInr(payableTax.cgst)}, SGST ${formatInr(payableTax.sgst)}).`,
      `ITC claimable in Table 4(A)(3): ${formatInr(claimableItc.total)}.`,
      `ITC pending payment: ${formatInr(pendingItc.total)}.`,
      "Note: ITC under Table 4(A)(3) only after tax payment. s 16(2)(aa) does not apply to RCM.",
    ],
  };
}

// ---------------------------------------------------------------------------
// s 9(4) Unregistered Supplier Tracking (for future enforcement)
// ---------------------------------------------------------------------------

export interface UnregisteredSupplierSupply {
  supplierName: string;
  supplierPan?: string | null;
  recipientGstin: string;
  placeOfSupply: string;
  taxableValue: number;
  hsnSac: string;
  invoiceNumber: string;
  invoiceDate: string;
  natureOfSupply: string;
}

export interface UnregisteredSupplyReport {
  entries: UnregisteredSupplierSupply[];
  totalTaxableValue: number;
  estimatedTax: { igst: number; cgst: number; sgst: number; cess: number };
  methodology: string[];
}

/**
 * Track supplies from unregistered suppliers (s 9(4)).
 * Currently suspended but maintained for compliance readiness.
 */
export function trackUnregisteredSupplies(
  supplies: UnregisteredSupplierSupply[],
  recipientStateCode: string,
  defaultRatePct = 18,
): UnregisteredSupplyReport {
  let totalTaxable = 0;
  let igst = 0,
    cgst = 0,
    sgst = 0;
  const cess = 0;

  for (const s of supplies) {
    totalTaxable += s.taxableValue;
    const tax = Math.round((s.taxableValue * defaultRatePct) / 100);
    const isInter = s.placeOfSupply !== recipientStateCode;
    if (isInter) {
      igst += tax;
    } else {
      cgst += Math.round(tax / 2);
      sgst += tax - Math.round(tax / 2);
    }
  }

  return {
    entries: supplies,
    totalTaxableValue: totalTaxable,
    estimatedTax: { igst, cgst, sgst, cess },
    methodology: [
      `Tracked ${supplies.length} supplies from unregistered suppliers (s 9(4)).`,
      `s 9(4) RCM on unregistered suppliers is currently SUSPENDED (Notif 8/2017).`,
      `If enforced, estimated tax liability: ${formatInr(igst + cgst + sgst + cess)} at ${defaultRatePct}%.`,
      "Maintained for compliance readiness and future enforcement.",
    ],
  };
}

// ---------------------------------------------------------------------------
// E-Commerce Operator RCM (s 9(5))
// ---------------------------------------------------------------------------

export interface EcomRcmSupply {
  ecomGstin: string;
  ecomName: string;
  supplierGstin: string;
  supplierName: string;
  serviceCategory: "transport" | "restaurant" | "housekeeping" | "other";
  placeOfSupply: string;
  taxableValue: number;
  invoiceNumber: string;
  invoiceDate: string;
}

export function calculateEcomRcmTax(
  supplies: EcomRcmSupply[],
  ecomStateCode: string,
): { entries: Array<EcomRcmSupply & { tax: RcmTaxAmounts }>; totals: RcmTaxAmounts & { total: number } } {
  const entries = supplies.map((s) => {
    const category: RcmCategory =
      s.serviceCategory === "transport"
        ? "ecom-transport"
        : s.serviceCategory === "restaurant"
          ? "ecom-restaurant"
          : s.serviceCategory === "housekeeping"
            ? "ecom-housekeeping"
            : "ecom-other";
    const tax = calculateRcmTax(
      {
        category,
        supplierGstin: s.supplierGstin,
        supplierName: s.supplierName,
        recipientGstin: s.ecomGstin,
        recipientName: s.ecomName,
        placeOfSupply: s.placeOfSupply,
        taxableValue: s.taxableValue,
        invoiceNumber: s.invoiceNumber,
        invoiceDate: s.invoiceDate,
        hsnSac: "9985",
        isEcom: true,
        ecomGstin: s.ecomGstin,
      },
      ecomStateCode,
    );
    return { ...s, tax };
  });

  const totals = entries.reduce(
    (acc, e) => ({
      taxableValue: acc.taxableValue + e.tax.taxableValue,
      igst: acc.igst + e.tax.igst,
      cgst: acc.cgst + e.tax.cgst,
      sgst: acc.sgst + e.tax.sgst,
      cess: acc.cess + e.tax.cess,
      total: 0, // calculated below
    }),
    { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 },
  );
  totals.total = totals.igst + totals.cgst + totals.sgst + totals.cess;

  return { entries, totals };
}

const gstRcmEngine = {
  RCM_CATEGORIES,
  calculateRcmTax,
  determineRcmItcEligibility,
  buildRcmRegister,
  trackUnregisteredSupplies,
  calculateEcomRcmTax,
};

export default gstRcmEngine;
