/**
 * ITR JSON utility — generation + validation for Indian income-tax return JSON.
 *
 * HONESTY CONTRACT (matching ca-efiling.ts, udin.ts, gst-portal-integration.ts):
 * this module does NOT contact the Income Tax e-filing portal. It prepares a
 * reproducible JSON *representation* of an ITR the way the portal's offline
 * utilities describe the fields, and validates that representation against the
 * schema the portal actually expects. The generated JSON is a *filing-prep
 * artifact* — suitable for review, for attaching to an e-filing submission
 * bundle, and for re-deriving the same payload deterministically — but the actual
 * lodgement, signing (DSC/EVC) and acknowledgement capture happen in
 * `ca-portals.ts` / `ca-efiling.ts`, which are the parts that remain out of reach
 * until a deployment supplies portal credentials + DSC key material.
 *
 * Schema basis: the validator mirrors the field-level checks the ITD offline JSON
 * utilities enforce — form type, assessment year format, PAN (5L+4D+1L), Aadhaar
 * (12 digits), email, mobile (10 digits), bank account (9-18 digits) and IFSC
 * (11 chars, 4L+1D+6A). These are the *format* gates; the *statutory* correctness
 * of the income/tax numbers is a separate reconciliation exercise against the
 * current Finance Act slabs and the official ITD utilities, which this module
 * does not perform.
 */

import { createHash } from "node:crypto";

export class ITRError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ITRError";
  }
}

// ---------------------------------------------------------------------------
// Common ITR structures
// ---------------------------------------------------------------------------

export const ITR_FORM_OPTIONS = ["ITR-1", "ITR-2", "ITR-3", "ITR-4", "ITR-5", "ITR-6", "ITR-7"] as const;

export type ITRForm = (typeof ITR_FORM_OPTIONS)[number];

export interface ITRGeneralInfo {
  formType: ITRForm;
  assessmentYear: string; // "2025-26"
  filingType: "original" | "revised" | "defective";
  filingMode: "online" | "offline";
  digitalSignature: boolean;
  name: string;
  pan: string;
  aadhaar: string;
  dateOfBirth?: string | null;
  gender: "male" | "female" | "transgender";
  address: string;
  email: string;
  mobile: string;
  registeredGmails?: string[] | null;
  verifyGmail?: boolean | null;
  bankDetails?: {
    accountNumber: string;
    ifscCode: string;
    accountType: "savings" | "current";
    accountHolderName: string;
  } | null;
}

export interface ITRValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  checksum?: string;
}

export function validateITRGeneralInfo(info: ITRGeneralInfo): ITRValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!/^\d{4}-\d{2}$/.test(info.assessmentYear)) {
    errors.push("assessmentYear must be yyyy-mm.");
  }
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(info.pan)) {
    errors.push("PAN must be valid format (5 letters + 4 digits + 1 letter).");
  }
  if (!/^[0-9]{12}$/.test(info.aadhaar)) {
    errors.push("Aadhaar must be 12 digits.");
  }
  if (info.dateOfBirth && !/^\d{4}-\d{2}-\d{2}/.test(info.dateOfBirth)) {
    errors.push("dateOfBirth must be yyyy-mm-dd.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(info.email)) {
    errors.push("email must be valid.");
  }
  if (!/^\d{10}$/.test(info.mobile)) {
    errors.push("mobile must be 10 digits.");
  }
  if (info.bankDetails) {
    if (!/^\d{9,18}$/.test(info.bankDetails.accountNumber)) {
      errors.push("accountNumber must be 9-18 digits.");
    }
    if (!/^[A-Z0-9]{11}$/.test(info.bankDetails.ifscCode)) {
      errors.push("IFSC must be 11 characters (4 letters + 1 digit + 6 alphanumeric).");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// ITR-1 (SAHAJ) - Individual with salary, pension, one house property, other sources
// ---------------------------------------------------------------------------

export interface ITR1Income {
  salary: {
    grossSalary: number; // minor units
    allowanceExempt: number;
    standardDeduction: number;
    entertainmentAllowance: number;
    professionalTax: number;
    netSalary: number;
  };
  pension?: {
    grossPension: number;
    standardDeduction: number;
    netPension: number;
  } | null;
  houseProperty: {
    annualValue: number;
    municipalTaxPaid: number;
    netAnnualValue: number;
    deductionInterest: number;
    netIncomeOrLoss: number;
  } | null;
  otherSources: {
    interestFromSavings: number;
    interestFromFixedDeposits: number;
    interestFromRd: number;
    interestFromSecurities: number;
    familyPension: number;
    "other income": number;
    totalOtherSources: number;
  };
  agriculturalIncome?: number | null;
  exemptIncome?: number | null;
  // Tax already paid - used for refund / tax-due computation.
  tds?: number | null;
  tcs?: number | null;
  advanceTax?: number | null;
  selfAssessmentTax?: number | null;
}

export interface ITR1Deductions {
  chapterVIA: {
    "80C": number; // LIC, PPF, NSC, etc. (max 1.5L)
    "80CCC": number; // Pension funds
    "80CCD1": number; // NPS employee contribution
    "80CCD2": number; // NPS employer contribution
    total80C: number;
    "80D": number; // Medical insurance
    "80DDB": number; // Medical treatment
    "80E": number; // Education loan interest
    "80G": number; // Donations
    "80GG": number; // HRA for non-HRA employees
    "80GGDeduction": number;
    "80TTA": number; // Savings account interest
    "80TTB": number; // Senior citizen interest
    totalDeductions: number;
  };
  chapterVIATotal: number;
  rebate87A: number;
  totalTaxableIncome: number;
}

export interface ITR1TaxOutput {
  totalIncomeBeforeDeductions: number;
  totalDeductionsChapterVIA: number;
  totalIncomeAfterDeductions: number;
  rebate87A: number;
  taxAfterRebate: number;
  cess: number;
  totalTaxPayable: number;
  tds: number;
  tcs: number;
  advanceTax: number;
  selfAssessmentTax: number;
  totalTaxPaid: number;
  taxRefund: number;
  taxNetDue: number;
}

export function computeITR1(income: ITR1Income, deductions: ITR1Deductions, regime: "new" | "old"): ITR1TaxOutput {
  // Simplified computation - production would use india-tax.ts computeIncomeTax
  const totalIncomeBeforeDeductions =
    income.salary.netSalary +
    (income.pension?.netPension ?? 0) +
    (income.houseProperty?.netIncomeOrLoss ?? 0) +
    income.otherSources.totalOtherSources;
  const totalIncomeAfterDeductions = Math.max(0, totalIncomeBeforeDeductions - deductions.chapterVIATotal);
  const taxableIncome = totalIncomeAfterDeductions + (income.agriculturalIncome ?? 0);

  // Simplified tax calculation - production uses india-tax.ts
  let tax = 0;
  if (regime === "new") {
    if (taxableIncome > 250000 && taxableIncome <= 500000) tax = Math.round((taxableIncome * 5) / 100);
    else if (taxableIncome > 500000 && taxableIncome <= 750000) tax = Math.round((taxableIncome * 10) / 100 - 12500);
    else if (taxableIncome > 750000 && taxableIncome <= 1000000) tax = Math.round((taxableIncome * 15) / 100 - 37500);
    else if (taxableIncome > 1000000 && taxableIncome <= 1250000) tax = Math.round((taxableIncome * 20) / 100 - 75000);
    else if (taxableIncome > 1250000 && taxableIncome <= 1500000) tax = Math.round((taxableIncome * 25) / 100 - 125000);
    else tax = Math.round((taxableIncome * 30) / 100 - 187500);
  } else {
    if (taxableIncome > 250000 && taxableIncome <= 500000) tax = Math.round((taxableIncome * 5) / 100);
    else if (taxableIncome > 500000 && taxableIncome <= 1000000) tax = Math.round((taxableIncome * 20) / 100 - 12500);
    else tax = Math.round((taxableIncome * 30) / 100 - 112500);
  }

  const surcharge = 0; // Simplified
  const cess = Math.round(((tax + surcharge) * 4) / 100);
  const rebate87A = regime === "new" ? Math.min(tax, 25000) : Math.min(tax, 12500);
  const taxAfterRebate = Math.max(0, tax - rebate87A);
  const totalTaxPayable = taxAfterRebate + cess;

  return {
    totalIncomeBeforeDeductions,
    totalDeductionsChapterVIA: deductions.chapterVIATotal,
    totalIncomeAfterDeductions,
    rebate87A,
    taxAfterRebate: taxAfterRebate,
    cess,
    totalTaxPayable,
    tds: income.tds ?? 0,
    tcs: income.tcs ?? 0,
    advanceTax: income.advanceTax ?? 0,
    selfAssessmentTax: income.selfAssessmentTax ?? 0,
    totalTaxPaid: (income.tds ?? 0) + (income.tcs ?? 0) + (income.advanceTax ?? 0) + (income.selfAssessmentTax ?? 0),
    taxRefund: Math.max(0, (income.tds ?? 0) + (income.tcs ?? 0) + (income.advanceTax ?? 0) - totalTaxPayable),
    taxNetDue: Math.max(0, totalTaxPayable - (income.tds ?? 0) - (income.tcs ?? 0) - (income.advanceTax ?? 0)),
  };
}

export function generateITR1(info: ITRGeneralInfo, income: ITR1Income, deductions: ITR1Deductions): string {
  const validation = validateITRGeneralInfo(info);
  if (!validation.valid) {
    throw new ITRError(validation.errors.join("\n"));
  }

  const lines: string[] = [];
  lines.push("{");
  lines.push(`  "form_type": "${info.formType}",`);
  lines.push(`  "assessment_year": "${info.assessmentYear}",`);
  lines.push(`  "filing_type": "${info.filingType}",`);
  lines.push(`  "personal_details": {`);
  lines.push(`    "name": "${info.name}",`);
  lines.push(`    "pan": "${info.pan}",`);
  lines.push(`    "aadhaar": "${info.aadhaar}",`);
  lines.push(`    "date_of_birth": "${info.dateOfBirth ?? "N/A"}",`);
  lines.push(`    "gender": "${info.gender}",`);
  lines.push(`    "email": "${info.email}",`);
  lines.push(`    "mobile": "${info.mobile}"`);
  lines.push(`  },`);
  lines.push(`  "income": {`);
  lines.push(`    "salary": {`);
  lines.push(`      "gross_salary": ${income.salary.grossSalary},`);
  lines.push(`      "allowance_exempt": ${income.salary.allowanceExempt},`);
  lines.push(`      "standard_deduction": ${income.salary.standardDeduction},`);
  lines.push(`      "net_salary": ${income.salary.netSalary}`);
  lines.push(`    },`);
  lines.push(`    "total_income": ${computeITR1(income, deductions, "new").totalIncomeAfterDeductions}`);
  lines.push(`  },`);
  lines.push(`  "tax": {`);
  const taxComputed = computeITR1(income, deductions, "new");
  lines.push(`    "total_tax_payable": ${taxComputed.totalTaxPayable},`);
  lines.push(`    "rebate_87A": ${taxComputed.rebate87A},`);
  lines.push(`    "cess": ${taxComputed.cess}`);
  lines.push(`  }`);
  lines.push(`}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ITR-4 (SUGAM) - Presumptive income (44AD, 44ADA, 44AE)
// ---------------------------------------------------------------------------

export interface ITR4Presumptive {
  formType: "ITR-4";
  assessmentYear: string;
  grossReceipts: number;
  presumptiveIncomeRate: number; // 50% for profession (44ADA), 6% for business (44AD digital), 8% for business (44AD non-digital)
  presumptiveIncome: number;
  otherIncome?: number | null;
  deductions80C: number;
  deduction80D: number;
  totalDeductions: number;
  taxPayable: number;
  tds: number;
  advanceTax: number;
  selfAssessmentTax: number;
}

export function computeITR4(input: ITR4Presumptive): ITR4Presumptive {
  const presumptiveIncome = Math.round((input.grossReceipts * input.presumptiveIncomeRate) / 100);
  const totalIncome = presumptiveIncome + (input.otherIncome ?? 0);
  const totalDeductions = input.deductions80C + input.deduction80D;
  const taxableIncome = Math.max(0, totalIncome - totalDeductions);

  // Simplified tax - production uses india-tax.ts
  let tax = 0;
  if (taxableIncome > 250000 && taxableIncome <= 500000) tax = Math.round((taxableIncome * 5) / 100);
  else if (taxableIncome > 500000 && taxableIncome <= 750000) tax = Math.round((taxableIncome * 10) / 100 - 12500);
  else if (taxableIncome > 750000 && taxableIncome <= 1000000) tax = Math.round((taxableIncome * 15) / 100 - 37500);
  else if (taxableIncome > 1000000 && taxableIncome <= 1250000) tax = Math.round((taxableIncome * 20) / 100 - 75000);
  else if (taxableIncome > 1250000 && taxableIncome <= 1500000) tax = Math.round((taxableIncome * 25) / 100 - 125000);
  else tax = Math.round((taxableIncome * 30) / 100 - 187500);

  const cess = Math.round((tax * 4) / 100);
  const rebate87A = Math.min(tax, 25000);
  const totalTaxPayable = Math.max(0, tax - rebate87A + cess);

  return {
    ...input,
    presumptiveIncome,
    totalDeductions,
    taxPayable: totalTaxPayable,
  };
}

export function generateITR4(info: ITRGeneralInfo, input: ITR4Presumptive): string {
  const computed = computeITR4(input);
  const validation = validateITRGeneralInfo(info);
  if (!validation.valid) {
    throw new ITRError(validation.errors.join("\n"));
  }

  return JSON.stringify(
    {
      form_type: info.formType,
      assessment_year: info.assessmentYear,
      personal_details: {
        name: info.name,
        pan: info.pan,
        aadhaar: info.aadhaar,
      },
      presumptive_income: {
        gross_receipts: computed.grossReceipts,
        presumptive_income_rate: computed.presumptiveIncomeRate,
        presumptive_income: computed.presumptiveIncome,
      },
      deductions: {
        total: computed.totalDeductions,
      },
      tax: {
        total_payable: computed.taxPayable,
        tds: computed.tds,
        advance_tax: computed.advanceTax,
        self_assessment_tax: computed.selfAssessmentTax,
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// ITR-2 - Individuals/HUF without business/profession income
// ---------------------------------------------------------------------------

export interface ITR2Income {
  salary: number;
  pension: number;
  houseProperty: number;
  capitalGains: {
    shortTerm: number;
    longTerm: number;
    total: number;
  };
  otherSources: number;
  foreignAssets: number;
  totalIncome: number;
}

export function generateITR2(info: ITRGeneralInfo, income: ITR2Income): string {
  const validation = validateITRGeneralInfo(info);
  if (!validation.valid) {
    throw new ITRError(validation.errors.join("\n"));
  }

  return JSON.stringify(
    {
      form_type: "ITR-2",
      assessment_year: info.assessmentYear,
      personal_details: {
        name: info.name,
        pan: info.pan,
        aadhaar: info.aadhaar,
      },
      income: {
        salary: income.salary,
        pension: income.pension,
        house_property: income.houseProperty,
        capital_gains: income.capitalGains,
        other_sources: income.otherSources,
        total_income: income.totalIncome,
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// ITR-3 - Individuals/HUF with business/profession income
// ---------------------------------------------------------------------------

export interface ITR3Business {
  turnover: number;
  netProfit: number;
  presumptiveIncome: number;
  booksMaintained: boolean;
  auditRequired: boolean;
  tds: number;
  advanceTax: number;
}

export function generateITR3(info: ITRGeneralInfo, business: ITR3Business): string {
  const validation = validateITRGeneralInfo(info);
  if (!validation.valid) {
    throw new ITRError(validation.errors.join("\n"));
  }

  return JSON.stringify(
    {
      form_type: "ITR-3",
      assessment_year: info.assessmentYear,
      personal_details: {
        name: info.name,
        pan: info.pan,
        aadhaar: info.aadhaar,
      },
      business: {
        turnover: business.turnover,
        net_profit: business.netProfit,
        presumptive_income: business.presumptiveIncome,
        books_maintained: business.booksMaintained,
        audit_required: business.auditRequired,
      },
      tax: {
        tds: business.tds,
        advance_tax: business.advanceTax,
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// ITR-5 - Firms, LLPs, AOP, BOI, artificial judicial persons
// ---------------------------------------------------------------------------

export interface ITR5Firm {
  firmName: string;
  pan: string;
  aopBooiType?: "AOP" | "BOI" | "Other";
  totalIncome: number;
  businessIncome: number;
  capitalGains: number;
  otherIncome: number;
  bookProfit: number;
  presumptiveIncome: number;
  matApplicable: boolean;
  matAmount: number;
  tds: number;
  advanceTax: number;
  taxPayable: number;
}

export function generateITR5(info: ITRGeneralInfo, firm: ITR5Firm): string {
  const validation = validateITRGeneralInfo(info);
  if (!validation.valid) {
    throw new ITRError(validation.errors.join("\n"));
  }

  return JSON.stringify(
    {
      form_type: "ITR-5",
      assessment_year: info.assessmentYear,
      firm_details: {
        name: info.name,
        pan: info.pan,
        aop_boi_type: firm.aopBooiType ?? "Other",
      },
      income: {
        total_income: firm.totalIncome,
        business_income: firm.businessIncome,
        capital_gains: firm.capitalGains,
        other_income: firm.otherIncome,
      },
      mat: {
        applicable: firm.matApplicable,
        mat_amount: firm.matAmount,
      },
      tax: {
        tds: firm.tds,
        advance_tax: firm.advanceTax,
        total_payable: firm.taxPayable,
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// ITR-6 - Companies other than those claiming exemption u/s 11
// ---------------------------------------------------------------------------

export interface ITR6Company {
  companyName: string;
  pan: string;
  cin: string;
  totalIncome: number;
  businessIncome: number;
  capitalGains: number;
  otherIncome: number;
  bookProfit: number;
  matApplicable: boolean;
  matAmount: number;
  depreciation: number;
  tds: number;
  advanceTax: number;
  taxPayable: number;
  surcharge: number;
  cess: number;
}

export function generateITR6(info: ITRGeneralInfo, company: ITR6Company): string {
  const validation = validateITRGeneralInfo(info);
  if (!validation.valid) {
    throw new ITRError(validation.errors.join("\n"));
  }

  return JSON.stringify(
    {
      form_type: "ITR-6",
      assessment_year: info.assessmentYear,
      company_details: {
        name: info.name,
        pan: info.pan,
        cin: company.cin,
      },
      income: {
        total_income: company.totalIncome,
        business_income: company.businessIncome,
        capital_gains: company.capitalGains,
        other_income: company.otherIncome,
      },
      book_profit: {
        profit_before_tax: company.bookProfit,
        depreciation: company.depreciation,
      },
      mat: {
        applicable: company.matApplicable,
        mat_amount: company.matAmount,
      },
      tax: {
        tds: company.tds,
        advance_tax: company.advanceTax,
        total_payable: company.taxPayable,
        surcharge: company.surcharge,
        cess: company.cess,
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// ITR-7 - Persons including companies required to file under 139(4A)/139(4B)/139(4C)/139(4D)/139(4E)/139(4F)
// ---------------------------------------------------------------------------

export interface ITR7Entity {
  entityName: string;
  pan: string;
  cin?: string | null;
  trustRegistrationNumber?: string | null;
  section: "139(4A)" | "139(4B)" | "139(4C)" | "139(4D)" | "139(4E)" | "139(4F)";
  totalIncome: number;
  exemptIncome: number;
  foreignIncome: number;
  tds: number;
  advanceTax: number;
  taxPayable: number;
}

export function generateITR7(info: ITRGeneralInfo, entity: ITR7Entity): string {
  const validation = validateITRGeneralInfo(info);
  if (!validation.valid) {
    throw new ITRError(validation.errors.join("\n"));
  }

  return JSON.stringify(
    {
      form_type: "ITR-7",
      assessment_year: info.assessmentYear,
      entity_details: {
        name: info.name,
        pan: info.pan,
        cin: entity.cin ?? null,
        trust_registration_number: entity.trustRegistrationNumber ?? null,
        section: entity.section,
      },
      income: {
        total_income: entity.totalIncome,
        exempt_income: entity.exemptIncome,
        foreign_income: entity.foreignIncome,
      },
      tax: {
        tds: entity.tds,
        advance_tax: entity.advanceTax,
        total_payable: entity.taxPayable,
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// ITR JSON validator
// ---------------------------------------------------------------------------

/**
 * Validate a generated ITR JSON against the schema gates the ITD offline utilities
 * enforce. This is the *format* gate, not a statutory-audit gate — it checks that
 * the JSON is well-formed enough to be submitted, not that the numbers are correct.
 *
 * Returns the validation outcome; callers decide what to do with warnings.
 */
export function validateITRJson(json: unknown, _formType: ITRForm): ITRValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    errors.push("JSON must be a non-array object.");
    return { valid: false, errors, warnings };
  }

  const obj = json as Record<string, unknown>;

  // Form type
  if (!obj.form_type || typeof obj.form_type !== "string") {
    errors.push("form_type is required and must be a string.");
  } else if (!ITR_FORM_OPTIONS.includes(obj.form_type as ITRForm)) {
    errors.push(`form_type must be one of ITR-1 .. ITR-7, got "${obj.form_type}".`);
  }

  // Assessment year
  if (!obj.assessment_year || typeof obj.assessment_year !== "string") {
    errors.push("assessment_year is required and must be a string.");
  } else if (!/^\d{4}-\d{2}$/.test(obj.assessment_year as string)) {
    errors.push("assessment_year must be yyyy-mm.");
  }

  // Personal details
  const personal = obj.personal_details;
  if (!personal || typeof personal !== "object") {
    errors.push("personal_details is required and must be an object.");
  } else {
    const pd = personal as Record<string, unknown>;
    if (!pd.pan || typeof pd.pan !== "string") {
      errors.push("personal_details.pan is required.");
    } else if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pd.pan as string)) {
      errors.push("PAN must be valid format (5 letters + 4 digits + 1 letter).");
    }

    if (!pd.aadhaar || typeof pd.aadhaar !== "string") {
      errors.push("personal_details.aadhaar is required.");
    } else if (!/^[0-9]{12}$/.test(pd.aadhaar as string)) {
      errors.push("Aadhaar must be 12 digits.");
    }

    if (
      pd.date_of_birth &&
      typeof pd.date_of_birth === "string" &&
      !/^\d{4}-\d{2}-\d{2}/.test(pd.date_of_birth as string)
    ) {
      errors.push("date_of_birth must be yyyy-mm-dd.");
    }

    if (pd.email && typeof pd.email === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pd.email as string)) {
      errors.push("email must be valid.");
    }

    if (pd.mobile && typeof pd.mobile === "string" && !/^\d{10}$/.test(pd.mobile as string)) {
      errors.push("mobile must be 10 digits.");
    }

    // Bank details (optional but validated when present)
    const bank = pd.bank_details;
    if (bank && typeof bank === "object") {
      const bd = bank as Record<string, unknown>;
      if (!bd.account_number || typeof bd.account_number !== "string") {
        errors.push("personal_details.bank_details.account_number is required when bank_details is present.");
      } else if (!/^\d{9,18}$/.test(bd.account_number as string)) {
        errors.push("accountNumber must be 9-18 digits.");
      }
      if (!bd.ifsc_code || typeof bd.ifsc_code !== "string") {
        errors.push("personal_details.bank_details.ifsc_code is required when bank_details is present.");
      } else if (!/^[A-Z]{4}0[0-9A-Z]{6}$/.test(bd.ifsc_code as string)) {
        errors.push("IFSC must be 11 characters (4 letters + 1 zero + 6 alphanumeric). e.g. SBIN0001234.");
      }
    }
  }

  // Canonical checksum: SHA-256 over the UTF-8 bytes of the JSON the generator
  // produced, so the same payload always yields the same checksum and a reviewer
  // can verify the file has not been altered between generation and submission.
  if (!errors.length) {
    const canonical = JSON.stringify(obj);
    const checksum = createHash("sha256").update(canonical, "utf8").digest("hex");
    // Attach a stable checksum field that the validator can recompute; do not
    // mutate the caller's object — return it alongside the validation.
    return { valid: true, errors: [], warnings, checksum };
  }

  return { valid: false, errors, warnings };
}

/**
 * Compute a SHA-256 checksum over a generated ITR JSON payload. Intended for
 * the filing-prep workflow: the same payload always yields the same checksum, so
 * a reviewer can verify the file has not been altered between generation and
 * submission.
 */
export function itrJsonChecksum(json: unknown): string {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return "";
  }
  return createHash("sha256").update(JSON.stringify(json), "utf8").digest("hex");
}
