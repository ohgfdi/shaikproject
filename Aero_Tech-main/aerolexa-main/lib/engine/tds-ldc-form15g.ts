/**
 * Lower Deduction Certificate (LDC) & Form 15G/15H Capture Module.
 *
 * A CA practice manages:
 *   - Lower Deduction Certificates (LDCs) u/s 197: applications, decisions,
 *     effective periods, rates, and tracking across books
 *   - Form 15G/15H: declarations by deductees to avoid TDS, with validity
 *     tracking, renewals, and compliance checks
 *
 * This module implements the data model, validation, and tracking for both.
 *
 * SCOPE AND HONESTY: this captures the data and tracks validity; it does not
 * file LDC applications with the AO or validate Form 15G/15H declarations
 * against the deductee's actual income. The CA is responsible for verifying
 * thedeclarant's claims.
 *
 * All amounts are in MINOR UNITS (paise) as integers.
 */

// ---------------------------------------------------------------------------
// Lower Deduction Certificate (LDC) u/s 197
// ---------------------------------------------------------------------------

/** Status of an LDC application. */
export type LdcApplicationStatus =
  | "draft" // Being prepared
  | "submitted" // Submitted to AO
  | "under-review" // With the AO
  | "approved" // Approved — certificate issued
  | "rejected" // Rejected by AO
  | "withdrawn" // Withdrawn by applicant
  | "expired" // Certificate expired
  | "cancelled"; // Cancelled (e.g., conditions breached)

/** Status of an LDC certificate (issued). */
export type LdcCertificateStatus =
  | "active" // Currently valid
  | "expired" // Past valid-until date
  | "suspended" // Suspended (e.g., conditions breached)
  | "cancelled" // Cancelled
  | "renewed"; // Renewed (superseded by a new certificate)

/** LDC application (filed by the deductee with the AO). */
export interface LdcApplication {
  /** Unique id. */
  id: string;
  /** Deductee PAN. */
  deducteePan: string;
  /** Deductee name. */
  deducteeName: string;
  /** Deductee type: individual | huf | company | firm | other. */
  deducteeType: string;
  /** Whether the deductee is a non-resident. */
  isNonResident: boolean;
  /** Original LDC application reference (from the AO office). */
  applicationReference?: string | null;
  /** Date of application. */
  applicationDate: string;
  /** Status. */
  status: LdcApplicationStatus;
  /** Assessment year(s) the application pertains to. */
  assessmentYears: string[];
  /** Sections for which LDC is sought. */
  sections: string[];
  /** Nature of income/payment. */
  natureOfIncome: string;
  /** Estimated total income for the AY (minor units). */
  estimatedTotalIncome?: number | null;
  /** Estimated total tax liability (minor units). */
  estimatedTotalTax?: number | null;
  /** TDS already deducted/expected (minor units). */
  tdsAlreadyDeduced?: number | null;
  /** Lower deduction rate sought (%). */
  lowerRateSought?: number | null;
  /** Amount up to which lower deduction is sought (minor units); null = unlimited. */
  lowerLimitAmount?: number | null;
  /** Period for which LDC is sought (from/to). */
  validFrom?: string | null;
  /** Period for which LDC is sought (to). */
  validUntil?: string | null;
  /** AO reference (office, circle, etc.). */
  aoReference?: string | null;
  /** Date of decision by AO. */
  decidedAt?: string | null;
  /** Decision: approved | rejected | conditions. */
  decision?: string | null;
  /** Approved rate (%), if approved. */
  approvedRate?: number | null;
  /** Approved amount limit (minor units), if approved. */
  approvedAmountLimit?: number | null;
  /** Approved valid-from date, if approved. */
  approvedValidFrom?: string | null;
  /** Approved valid-until date, if approved. */
  approvedValidUntil?: string | null;
  /** Conditions imposed by AO (if any). */
  conditions?: string | null;
  /** Rejection reason (if rejected). */
  rejectionReason?: string | null;
  /** Supporting documents attached (references). */
  documents?: string[] | null;
  /** Notes. */
  notes?: string | null;
  /** Date created. */
  createdAt: string;
  /** Last updated. */
  updatedAt: string;
}

/** Issued LDC certificate (from the AO). */
export interface LdcCertificate {
  /** Unique id. */
  id: string;
  /** Reference to the application. */
  applicationId: string;
  /** Certificate number (issued by AO). */
  certificateNumber: string;
  /** Deductee PAN. */
  deducteePan: string;
  /** Deductee name. */
  deducteeName: string;
  /** Status. */
  status: LdcCertificateStatus;
  /** Sections covered by this certificate. */
  sections: string[];
  /** Nature of income/payment. */
  natureOfIncome: string;
  /** Lower deduction rate (%), as approved. */
  lowerRate: number;
  /** Lower deduction amount limit (minor units); null = no limit. */
  lowerAmountLimit?: number | null;
  /** Valid from date. */
  validFrom: string;
  /** Valid until date. */
  validUntil: string;
  /** Period of validity (description). */
  validityPeriod: string;
  /** Conditions (if any). */
  conditions?: string | null;
  /** Remarks. */
  remarks?: string | null;
  /** Date issued. */
  issuedAt: string;
  /** Issued by (AO name/office). */
  issuedBy?: string | null;
  /** Created timestamp. */
  createdAt: string;
}

/** Whether an LDC certificate is currently valid. */
export function isLdcCertificateValid(cert: LdcCertificate): boolean {
  if (cert.status !== "active") return false;
  const now = new Date();
  const from = new Date(cert.validFrom);
  const until = new Date(cert.validUntil);
  return now >= from && now <= until;
}

/** Whether an LDC certificate covers a specific section. */
export function ldcCoversSection(cert: LdcCertificate, section: string): boolean {
  return cert.sections.some((s) => s.toUpperCase() === section.toUpperCase());
}

/**
 * Find the active LDC certificate for a deductee PAN and section.
 */
export function findActiveLdc(
  certificates: LdcCertificate[],
  deducteePan: string,
  section: string,
): LdcCertificate | undefined {
  return certificates.find(
    (c) =>
      c.deducteePan.toUpperCase() === deducteePan.toUpperCase() &&
      ldcCoversSection(c, section) &&
      isLdcCertificateValid(c),
  );
}

/**
 * Get LDC certificates expiring within a date range.
 */
export function expiringLdCs(certificates: LdcCertificate[], from: string, until: string): LdcCertificate[] {
  const fromDate = new Date(from);
  const untilDate = new Date(until);
  return certificates.filter((c) => {
    if (c.status !== "active") return false;
    const expireDate = new Date(c.validUntil);
    return expireDate >= fromDate && expireDate <= untilDate;
  });
}

// ---------------------------------------------------------------------------
// Form 15G / Form 15H
// ---------------------------------------------------------------------------

/** Which form: 15G (for individuals/HUFs below 60) or 15H (for seniors 60+). */
export type Form15Type = "15G" | "15H";

/** Status of a Form 15G/15H declaration. */
export type Form15Status =
  | "active" // Currently valid
  | "expired" // Past valid-until date
  | "cancelled" // Cancelled by deductee
  | "violated"; // Conditions breached / income exceeded

/** A Form 15G/15H declaration by a deductee. */
export interface Form15Declaration {
  /** Unique id. */
  id: string;
  /** Which form: "15G" or "15H". */
  formType: Form15Type;
  /** Deductee PAN. */
  deducteePan: string;
  /** Deductee name. */
  deducteeName: string;
  /** Deductee type: individual | huf. */
  deducteeType: string;
  /** Age of the deductee (as on the declaration date). */
  age: number;
  /** Whether the deductee is a non-resident. */
  isNonResident: boolean;
  /** Declaration date. */
  declarationDate: string;
  /** Status. */
  status: Form15Status;
  /** Financial year to which the declaration pertains. */
  financialYear: string; // e.g. "2025-26"
  /** Assessment year. */
  assessmentYear: string; // e.g. "2026-27"
  /** Estimated total income for the AY (minor units). */
  estimatedTotalIncome?: number | null;
  /** Estimated total tax liability (minor units). */
  estimatedTotalTax?: number | null;
  /** Sections for which the declaration is made. */
  sections: string[];
  /** Nature of income/payments covered. */
  natureOfIncome: string;
  /** Whether the declaration covers all sections or specific ones. */
  scope: "all" | "specific";
  /** Specific sections covered (if scope = "specific"). */
  specificSections?: string[] | null;
  /** Amount up to which declaration is valid (minor units); null = no limit. */
  amountLimit?: number | null;
  /** Valid from date. */
  validFrom: string;
  /** Valid until date (typically 31 March of the FY). */
  validUntil: string;
  /** Declaration reference (from the deductee / portal). */
  declarationReference?: string | null;
  /** Whether the declaration has been verified with supporting documents. */
  verified: boolean;
  /** Supporting documents (references). */
  documents?: string[] | null;
  /** Notes. */
  notes?: string | null;
  /** Date created. */
  createdAt: string;
  /** Last updated. */
  updatedAt: string;
}

/** Whether a Form 15G/15H declaration is currently valid. */
export function isForm15Valid(decl: Form15Declaration): boolean {
  if (decl.status !== "active") return false;
  const now = new Date();
  const from = new Date(decl.validFrom);
  const until = new Date(decl.validUntil);
  return now >= from && now <= until;
}

/**
 * Check that Form 15G/15H is being used by the right person:
 *   - 15G: for individuals/HUFs below 60 years
 *   - 15H: for individuals 60 years and above (senior citizens)
 *
 * Returns an issue if the form type doesn't match the age.
 */
export function validateForm15Type(decl: Form15Declaration): string | null {
  if (decl.formType === "15G" && decl.age >= 60) {
    return `Form 15G declared by a person aged ${decl.age} (senior citizen) — Form 15H should be used instead.`;
  }
  if (decl.formType === "15H" && decl.age < 60) {
    return `Form 15H declared by a person aged ${decl.age} (below 60) — Form 15H is only for senior citizens (60+).`;
  }
  return null;
}

/**
 * Whether a Form 15G/15H declaration covers a specific section.
 */
export function form15CoversSection(decl: Form15Declaration, section: string): boolean {
  if (decl.scope === "all") return true;
  return decl.specificSections?.some((s) => s.toUpperCase() === section.toUpperCase()) ?? false;
}

/**
 * Find the active Form 15G/15H declaration for a deductee PAN and section.
 */
export function findActiveForm15(
  declarations: Form15Declaration[],
  deducteePan: string,
  section: string,
): Form15Declaration | undefined {
  return declarations.find(
    (d) =>
      d.deducteePan.toUpperCase() === deducteePan.toUpperCase() && form15CoversSection(d, section) && isForm15Valid(d),
  );
}

/**
 * Get declarations expiring within a date range.
 */
export function expiringForm15s(declarations: Form15Declaration[], from: string, until: string): Form15Declaration[] {
  const fromDate = new Date(from);
  const untilDate = new Date(until);
  return declarations.filter((d) => {
    if (d.status !== "active") return false;
    const expireDate = new Date(d.validUntil);
    return expireDate >= fromDate && expireDate <= untilDate;
  });
}

/**
 * Check validity of a Form 15G/15H declaration.
 */
export function validateForm15Declaration(decl: Form15Declaration): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // Form type vs age
  const typeIssue = validateForm15Type(decl);
  if (typeIssue) issues.push(typeIssue);

  // Date validation
  if (!/^\d{4}-\d{2}-\d{2}$/.test(decl.declarationDate)) {
    issues.push(`Declaration date "${decl.declarationDate}" is not in yyyy-mm-dd format.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(decl.validFrom)) {
    issues.push(`Valid-from date "${decl.validFrom}" is not in yyyy-mm-dd format.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(decl.validUntil)) {
    issues.push(`Valid-until date "${decl.validUntil}" is not in yyyy-mm-dd format.`);
  }

  // Declaration date should be before valid-from
  if (/^\d{4}-\d{2}-\d{2}$/.test(decl.declarationDate) && /^\d{4}-\d{2}-\d{2}$/.test(decl.validFrom)) {
    const declDate = new Date(decl.declarationDate);
    const validFrom = new Date(decl.validFrom);
    if (declDate > validFrom) {
      issues.push(`Declaration date (${decl.declarationDate}) is after valid-from date (${decl.validFrom}).`);
    }
  }

  // Valid-until should be 31 March of the FY (or within the FY)
  if (/^\d{4}-\d{2}-\d{2}$/.test(decl.validUntil)) {
    const untilDate = new Date(decl.validUntil);
    const year = Number(decl.validUntil.slice(0, 4));
    const expectedUntil = new Date(`${year}-03-31`);
    if (untilDate > expectedUntil) {
      issues.push(`Valid-until date (${decl.validUntil}) is after 31 March ${year} (end of FY).`);
    }
  }

  // Non-resident should not file 15G/15H (generally)
  if (decl.isNonResident) {
    issues.push(`Form 15${decl.formType.slice(-1)} declared by a non-resident — generally not applicable.`);
  }

  // Sections should be valid TDS sections
  const validSections = [
    "194A",
    "194B",
    "194BB",
    "194C",
    "194D",
    "194EE",
    "194F",
    "194G",
    "194H",
    "194I",
    "194J",
    "194LA",
    "194-IB",
    "194-IR",
    "194Q",
    "194R",
    "194K",
    "194KE",
    "194DA",
    "194LC",
    "194LD",
  ];
  for (const section of decl.sections) {
    if (!validSections.includes(section.toUpperCase())) {
      issues.push(`Section "${section}" in declaration is not a recognized TDS section that allows Form 15G/15H.`);
    }
  }

  // Amount limit should be reasonable (not negative, not absurdly high)
  if (decl.amountLimit !== null && decl.amountLimit !== undefined) {
    if (decl.amountLimit < 0) {
      issues.push(`Amount limit is negative (${decl.amountLimit}).`);
    }
    if (decl.amountLimit > 1_00_00_00_00_00) {
      // ₹100 Crores in paise
      issues.push(`Amount limit (${decl.amountLimit / 100}) seems unusually high.`);
    }
  }

  // Estimated income should be plausible
  if (decl.estimatedTotalIncome !== null && decl.estimatedTotalIncome !== undefined) {
    if (decl.estimatedTotalIncome < 0) {
      issues.push(`Estimated total income is negative (${decl.estimatedTotalIncome}).`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Check if a deduction event is covered by a valid Form 15G/15H or LDC.
 * Returns the covering document (if any).
 */
export function getTdsExemptionCover(
  event: {
    deducteePan: string;
    section: string;
    amount: number;
    dateOfPaymentOrCredit: string;
  },
  form15Declarations: Form15Declaration[],
  ldcCertificates: LdcCertificate[],
): { covered: boolean; byForm15: Form15Declaration | null; byLdc: LdcCertificate | null; reason: string | null } {
  // Check Form 15G/15H first
  const form15 = findActiveForm15(form15Declarations, event.deducteePan, event.section);
  if (form15) {
    // Check amount limit
    if (form15.amountLimit !== null && form15.amountLimit !== undefined && event.amount > form15.amountLimit) {
      return {
        covered: false,
        byForm15: null,
        byLdc: null,
        reason: `Form 15G/15H amount limit (${form15.amountLimit / 100}) exceeded by payment (${event.amount / 100}).`,
      };
    }

    // Check date range
    if (
      new Date(event.dateOfPaymentOrCredit) < new Date(form15.validFrom) ||
      new Date(event.dateOfPaymentOrCredit) > new Date(form15.validUntil)
    ) {
      return {
        covered: false,
        byForm15: null,
        byLdc: null,
        reason: `Payment date (${event.dateOfPaymentOrCredit}) is outside Form 15G/15H validity (${form15.validFrom} to ${form15.validUntil}).`,
      };
    }

    return {
      covered: true,
      byForm15: form15,
      byLdc: null,
      reason: null,
    };
  }

  // Check LDC
  const ldc = findActiveLdc(ldcCertificates, event.deducteePan, event.section);
  if (ldc) {
    // Check amount limit
    if (ldc.lowerAmountLimit !== null && ldc.lowerAmountLimit !== undefined && event.amount > ldc.lowerAmountLimit) {
      return {
        covered: false,
        byForm15: null,
        byLdc: null,
        reason: `LDC amount limit (${ldc.lowerAmountLimit / 100}) exceeded by payment (${event.amount / 100}). TDS at lower rate may apply up to the limit.`,
      };
    }

    // Check date range
    if (
      new Date(event.dateOfPaymentOrCredit) < new Date(ldc.validFrom) ||
      new Date(event.dateOfPaymentOrCredit) > new Date(ldc.validUntil)
    ) {
      return {
        covered: false,
        byForm15: null,
        byLdc: null,
        reason: `Payment date (${event.dateOfPaymentOrCredit}) is outside LDC validity (${ldc.validFrom} to ${ldc.validUntil}).`,
      };
    }

    return {
      covered: true,
      byForm15: null,
      byLdc: ldc,
      reason: null,
    };
  }

  return {
    covered: false,
    byForm15: null,
    byLdc: null,
    reason: null,
  };
}

/**
 * Generate a renewal reminder for expiring declarations/certificates.
 */
export function generateRenewalReminders(
  form15Declarations: Form15Declaration[],
  ldcCertificates: LdcCertificate[],
  daysBeforeExpiry: number = 30,
): {
  form15Renewals: { decl: Form15Declaration; daysUntilExpiry: number }[];
  ldcRenewals: { cert: LdcCertificate; daysUntilExpiry: number }[];
} {
  const now = new Date();
  const threshold = new Date(now.getTime() + daysBeforeExpiry * 24 * 60 * 60 * 1000);

  const form15Renewals: { decl: Form15Declaration; daysUntilExpiry: number }[] = [];
  for (const decl of form15Declarations) {
    if (decl.status !== "active") continue;
    const expireDate = new Date(decl.validUntil);
    if (expireDate <= threshold) {
      form15Renewals.push({
        decl,
        daysUntilExpiry: Math.floor((expireDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
      });
    }
  }

  const ldcRenewals: { cert: LdcCertificate; daysUntilExpiry: number }[] = [];
  for (const cert of ldcCertificates) {
    if (cert.status !== "active") continue;
    const expireDate = new Date(cert.validUntil);
    if (expireDate <= threshold) {
      ldcRenewals.push({
        cert,
        daysUntilExpiry: Math.floor((expireDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
      });
    }
  }

  return { form15Renewals, ldcRenewals };
}
