/** GST rate validation and HSN/SAC classification for Indian GST */

import { formatInr } from "./india-tax";

export class GstValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GstValidationError";
  }
}

const HSN_RE = /^[0-9]{4,8}$/;
const SAC_RE = /^99[0-9]{4,6}$/;
export const NOTIFIED_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28] as const;
export const SPECIAL_GST_RATES = [1, 2, 6, 14, 26] as const;
export const ALL_VALID_GST_RATES = [...NOTIFIED_GST_RATES, ...SPECIAL_GST_RATES] as const;

export const STATE_CODES: Record<string, string> = {
  "01": "Andhra Pradesh",
  "02": "Arunachal Pradesh",
  "03": "Assam",
  "04": "Bihar",
  "05": "Chhattisgarh",
  "06": "Goa",
  "07": "Gujarat",
  "08": "Haryana",
  "09": "Himachal Pradesh",
  "10": "Jharkhand",
  "11": "Karnataka",
  "12": "Kerala",
  "13": "Madhya Pradesh",
  "14": "Maharashtra",
  "15": "Manipur",
  "16": "Meghalaya",
  "17": "Mizoram",
  "18": "Nagaland",
  "19": "Odisha",
  "20": "Punjab",
  "21": "Rajasthan",
  "22": "Sikkim",
  "23": "Tamil Nadu",
  "24": "Telangana",
  "25": "Tripura",
  "26": "Uttar Pradesh",
  "27": "Uttarakhand",
  "28": "West Bengal",
  "29": "Andaman and Nicobar Islands",
  "30": "Chandigarh",
  "31": "Dadra and Nagar Haveli and Daman and Diu",
  "32": "Delhi",
  "33": "Jammu and Kashmir",
  "34": "Ladakh",
  "35": "Lakshadweep",
  "36": "Puducherry",
  "96": "Other Territory",
};

export function validateGstin(gstin: string): {
  valid: boolean;
  gstin: string;
  stateCode: string | null;
  pan: string | null;
  entityNumber: string | null;
  zonalIdentifier: string | null;
  checksumCharacters: string | null;
  errors: string[];
} {
  const errors: string[] = [];
  const g = gstin.trim().toUpperCase();
  const gg = g || "";

  if (gg.length !== 15) {
    errors.push(`Length must be 15 characters (got ${gg.length}).`);
  }
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(gg)) {
    if (gg.length >= 2 && !/^[0-9]{2}$/.test(gg.slice(0, 2))) errors.push("First 2 characters must be state code.");
    if (gg.length >= 7 && !/[A-Z]{5}/.test(gg.slice(2, 7))) errors.push("Characters 3-7 must be PAN.");
    if (gg.length >= 11 && !/[0-9]{4}/.test(gg.slice(7, 11))) errors.push("Characters 8-11 must be entity number.");
    if (gg.length >= 12 && !/[A-Z]/.test(gg[11] || "")) errors.push("Character 12 must be Z.");
    if (gg.length >= 15 && !/[0-9A-Z]{3}/.test(gg.slice(12, 15))) errors.push("Characters 13-15 must be alphanumeric.");
  }

  return {
    valid: errors.length === 0,
    gstin: gg,
    stateCode: /^[0-9]{2}/.test(gg) ? gg.slice(0, 2) : null,
    pan: /^[0-9]{2}[A-Z]{5}/.test(gg) ? gg.slice(2, 7) : null,
    entityNumber: /^[0-9]{2}[A-Z]{5}[0-9]{4}/.test(gg) ? gg.slice(7, 11) : null,
    zonalIdentifier: gg.length >= 12 ? gg[11] || null : null,
    checksumCharacters: gg.length >= 15 ? gg.slice(12, 15) : null,
    errors,
  };
}

export function gstinStateCode(gstin: string): string | null {
  const v = validateGstin(gstin);
  return v.valid && v.stateCode ? v.stateCode : null;
}

export function gstinBelongsToState(gstin: string, stateCode: string): boolean {
  const v = validateGstin(gstin);
  return v.valid && v.stateCode === stateCode;
}

export function isNotifiedRate(ratePct: number): boolean {
  return NOTIFIED_GST_RATES.some((r) => r === ratePct);
}

export function isValidRate(ratePct: number): boolean {
  return ALL_VALID_GST_RATES.some((r) => r === ratePct);
}

export function rateBand(ratePct: number): "nil-rated" | "low-rate" | "standard" | "high-rate" | "special" | "invalid" {
  if (!isValidRate(ratePct)) return "invalid";
  if (ratePct === 0) return "nil-rated";
  if (ratePct <= 5) return "low-rate";
  if (ratePct <= 18) return "standard";
  if (ratePct <= 28) return "high-rate";
  return "special";
}

export function classifyHsnSac(code: string): {
  type: "hsn" | "sac" | "invalid";
  code: string;
  isService: boolean;
  digits: number;
  errors: string[];
} {
  const c = code.trim();
  const errors: string[] = [];

  if (!/^[0-9]+$/.test(c)) {
    return { type: "invalid", code: c, isService: false, digits: c.length, errors: ["HSN/SAC codes must be numeric."] };
  }

  if (SAC_RE.test(c)) {
    return { type: "sac", code: c, isService: true, digits: c.length, errors: [] };
  }

  if (HSN_RE.test(c)) {
    return { type: "hsn", code: c, isService: false, digits: c.length, errors: [] };
  }

  if (c.length < 4 || c.length > 8) errors.push("HSN/SAC codes must be 4-8 digits.");
  if (c.startsWith("99") && HSN_RE.test(c.slice(2))) errors.push("99 prefix indicates SAC code, not HSN.");

  return { type: "invalid", code: c, isService: c.startsWith("99"), digits: c.length, errors };
}

export interface GstInvoiceLine {
  description?: string;
  hsn: string;
  taxableValue: number;
  ratePct: number;
  cgst?: number;
  sgst?: number;
  igst?: number;
  cess?: number;
  isInterState: boolean;
}

export function validateGstInvoice(lines: GstInvoiceLine[]): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  gstBreakdown: {
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    cess: number;
    totalTax: number;
    totalInvoice: number;
  };
  lineValidations: {
    lineNumber: number;
    valid: boolean;
    errors: string[];
    warnings: string[];
    expectedTax: number;
    actualTax: number;
    taxDifference: number;
  }[];
  methodology: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lineValidations: {
    lineNumber: number;
    valid: boolean;
    errors: string[];
    warnings: string[];
    expectedTax: number;
    actualTax: number;
    taxDifference: number;
  }[] = [];

  const gstBreakdown = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, totalTax: 0, totalInvoice: 0 };

  for (const line of lines) {
    if (!line) continue;
    const lineErrors: string[] = [];
    const lineWarnings: string[] = [];

    if (line.taxableValue < 0) lineErrors.push(`Taxable value negative.`);
    if (!isValidRate(line.ratePct)) lineErrors.push(`Rate ${line.ratePct}% not valid.`);
    else if (!isNotifiedRate(line.ratePct)) lineWarnings.push(`Rate ${line.ratePct}% is special rate.`);

    const hsnClass = classifyHsnSac(line.hsn);
    if (hsnClass.type === "invalid") lineErrors.push(...hsnClass.errors);

    const expectedTax = Math.round((line.taxableValue * line.ratePct) / 100);
    const lineTax = (line.cgst ?? 0) + (line.sgst ?? 0) + (line.igst ?? 0) + (line.cess ?? 0);

    if (line.isInterState) {
      const expectedIgst = line.ratePct > 0 ? expectedTax : 0;
      if (Math.abs((line.igst ?? 0) - expectedIgst) > 1)
        lineErrors.push(`Inter-state: expected IGST ${formatInr(expectedIgst)}.`);
      if ((line.cgst ?? 0) > 0 || (line.sgst ?? 0) > 0) lineWarnings.push(`Inter-state should not have CGST/SGST.`);
    } else {
      const expectedHalf = Math.floor(expectedTax / 2);
      if (line.ratePct > 0) {
        if (Math.abs((line.cgst ?? 0) - expectedHalf) > 1)
          lineErrors.push(`Intra-state: expected CGST ${formatInr(expectedHalf)}.`);
        if (Math.abs((line.sgst ?? 0) - (expectedTax - expectedHalf)) > 1)
          lineErrors.push(`Intra-state: expected SGST ${formatInr(expectedTax - expectedHalf)}.`);
      }
      if ((line.igst ?? 0) > 0) lineWarnings.push(`Intra-state should not have IGST.`);
    }

    lineValidations.push({
      lineNumber: lineValidations.length + 1,
      valid: lineErrors.length === 0,
      errors: lineErrors,
      warnings: lineWarnings,
      expectedTax,
      actualTax: lineTax,
      taxDifference: lineTax - expectedTax,
    });

    gstBreakdown.taxable += line.taxableValue;
    gstBreakdown.cgst += line.cgst ?? 0;
    gstBreakdown.sgst += line.sgst ?? 0;
    gstBreakdown.igst += line.igst ?? 0;
    gstBreakdown.cess += line.cess ?? 0;
  }

  gstBreakdown.totalTax = gstBreakdown.cgst + gstBreakdown.sgst + gstBreakdown.igst + gstBreakdown.cess;
  gstBreakdown.totalInvoice = gstBreakdown.taxable + gstBreakdown.totalTax;

  if (lines.length === 0) errors.push("Invoice has no line items.");

  const interStateLines = lines.filter((l) => l && l.isInterState);
  const intraStateLines = lines.filter((l) => l && !l.isInterState);
  if (interStateLines.length > 0 && intraStateLines.length > 0) {
    warnings.push("Invoice has both inter-state and intra-state lines.");
  }

  return {
    valid: errors.length === 0 && lineValidations.every((lv) => lv.valid),
    errors,
    warnings,
    gstBreakdown,
    lineValidations,
    methodology: [
      `Validated ${lines.length} line(s).`,
      `Total taxable: ${formatInr(gstBreakdown.taxable)}.`,
      `Total tax: ${formatInr(gstBreakdown.totalTax)}.`,
      `Invoice total: ${formatInr(gstBreakdown.totalInvoice)}.`,
    ],
  };
}

export function stateNameFromGstin(gstin: string): string | null {
  const sc = gstinStateCode(gstin);
  return sc ? (STATE_CODES[sc] ?? `Unknown state code ${sc}`) : null;
}

export function lookupRate(_code: string): {
  ratePct: number;
  description: string;
  isService: boolean;
  found: boolean;
} {
  return { ratePct: 18, description: "Standard rate - verify manually", isService: false, found: false };
}
