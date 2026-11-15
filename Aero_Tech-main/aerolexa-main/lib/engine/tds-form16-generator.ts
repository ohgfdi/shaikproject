/**
 * Form 16 / Form 16A Generation Workflow.
 *
 * A CA practice's TDS workflow culminates in issuing Form 16 (salary) and
 * Form 16A (non-salary) to the deductees. This module implements:
 *   - Form 16 (salary TDS certificate): Part A (quarterly breakdown) and Part B
 *     (detailed computation with annexures)
 *   - Form 16A (non-salary TDS certificate): for each deductee, per section
 *   - Annexure to Form 16 (Annexure to Part B): detailed salary breakdown
 *   - Annexure to Form 16 (deductions under Chapter VI-A): 80C, 80D, etc.
 *   - Form 16/16A certificate data model and versioning
 *   - Certificate generation from TDS entries
 *   - Renewal/re-issuance tracking
 *   - UDIN integration (if applicable)
 *
 * SCOPE AND HONESTY: this generates the certificate DATA (the contents that go
 * into Form 16/16A). It does not generate the actual PDF/HTML form from the
 * Income Tax Department's template. The CA must use the official utility or
 * ensure the data is correctly presented.
 *
 * All amounts are in MINOR UNITS (paise) as integers.
 */

/** Which form: 16 (salary) or 16A (non-salary). */
export type Form16Type = "16" | "16A";

/** Certificate status. */
export type CertificateStatus = "draft" | "issued" | "revised" | "cancelled" | "renewed";

/** Quarter breakdown for Form 16 Part A. */
export interface Form16QuarterBreakdown {
  quarter: string; // Q1, Q2, Q3, Q4
  fromDate: string;
  toDate: string;
  totalSalaryPaid: number; // minor units
  totalTdsDeducted: number; // minor units
  totalTdsDeposited: number; // minor units
  challanRefs: string[]; // BSR + serial references
  depositDates: string[];
}

/** Salary breakdown for Form 16 Part B Annexure. */
export interface Form16SalaryAnnexure {
  /** Basic salary. */
  basicSalary: number;
  /** Dearness allowance (DA). */
  dearnessAllowance: number;
  /** House rent allowance (HRA). */
  houseRentAllowance: number;
  /** Conveyance allowance. */
  conveyanceAllowance: number;
  /** Leave travel allowance (LTA). */
  leaveTravelAllowance: number;
  /** Medical allowance. */
  medicalAllowance: number;
  /** Special allowance. */
  specialAllowance: number;
  /** Other allowances. */
  otherAllowances: number;
  /** Bonus. */
  bonus: number;
  /** Commission. */
  commission: number;
  /** Arrears. */
  arrears: number;
  /** Leave encashment. */
  leaveEncashment: number;
  /** Gratuity. */
  gratuity: number;
  /** Pension. */
  pension: number;
  /** Other income from employer. */
  otherIncomeFromEmployer: number;
  /** Total salary. */
  totalSalary: number;
  /** Standard deduction. */
  standardDeduction: number;
  /** Taxable salary after standard deduction. */
  taxableSalary: number;
}

/** Chapter VI-A deductions for Form 16 Part B. */
export interface Form16ChapterVIAAnnexure {
  /** Section 80C (PPF, LIC, ELSS, NSC, etc.). */
  section80C: number;
  /** Section 80CCC (pension funds). */
  section80CCC: number;
  /** Section 80CCD(1) (NPS employee contribution). */
  section80CCD_1: number;
  /** Section 80CCD(2) (NPS employer contribution). */
  section80CCD_2: number;
  /** Section 80CCD(1B) (NPS additional). */
  section80CCD_1B: number;
  /** Section 80D (medical insurance). */
  section80D: number;
  /** Section 80E (education loan interest). */
  section80E: number;
  /** Section 80EE (home loan interest for first-time home buyers). */
  section80EE: number;
  /** Section 80G (donations). */
  section80G: number;
  /** Section 80GG (rent paid by non-HRA employees). */
  section80GG: number;
  /** Section 80TTA (savings account interest). */
  section80TTA: number;
  /** Section 80TTB (senior citizen interest income). */
  section80TTB: number;
  /** Section 80U (disability). */
  section80U: number;
  /** Other Chapter VI-A deductions. */
  otherChapterVIA: number;
  /** Total Chapter VI-A deductions. */
  totalChapterVIA: number;
}

/** Other income details for Form 16 Part B. */
export interface Form16OtherIncome {
  /** Source of income. */
  source: string;
  /** Amount. */
  amount: number;
  /** Whether TDS was deducted on this income. */
  tdsDeducted: boolean;
  /** Remarks. */
  remarks?: string | null;
}

/** Tax computation for Form 16 Part B. */
export interface Form16TaxComputation {
  /** Total income (from all sources). */
  totalIncome: number;
  /** Tax on total income (as per slab rates). */
  taxOnTotalIncome: number;
  /** Rebate u/s 87A. */
  rebate87A: number;
  /** Surcharge. */
  surcharge: number;
  /** Health and education cess (4%). */
  cess: number;
  /** Total tax liability. */
  totalTaxLiability: number;
  /** TDS deducted. */
  tdsDeducted: number;
  /** Relief u/s 89 (arrears). */
  relief89: number;
  /** Relief u/s 90/91 (foreign tax credit / treaty). */
  relief90_91: number;
  /** Any other relief. */
  otherRelief: number;
  /** Total relief. */
  totalRelief: number;
  /** Net tax liability after relief. */
  netTaxLiability: number;
  /** Tax payable (if net liability > TDS). */
  taxPayable: number;
  /** Tax refundable (if TDS > net liability). */
  taxRefundable: number;
}

/** A Form 16 / 16A certificate record. */
export interface TdsCertificate {
  /** Unique id. */
  id: string;
  /** Certificate type: "16" or "16A". */
  certificateType: Form16Type;
  /** Deductor TAN. */
  deductorTan: string;
  /** Deductor name. */
  deductorName: string;
  /** Deductor PAN (optional). */
  deductorPan?: string | null;
  /** Deductor address. */
  deductorAddress?: string | null;
  /** Deductor contact. */
  deductorContact?: string | null;
  /** Deductee PAN. */
  deducteePan: string;
  /** Deductee name. */
  deducteeName: string;
  /** Deductee address. */
  deducteeAddress?: string | null;
  /** Financial year. */
  financialYear: string; // e.g. "2025-26"
  /** Assessment year. */
  assessmentYear: string; // e.g. "2026-27"
  /** Date of generation. */
  generatedAt: string;
  /** Status. */
  status: CertificateStatus;
  /** For Form 16: Part A data. */
  partA?: Form16PartA | null;
  /** For Form 16: Part B data. */
  partB?: Form16PartB | null;
  /** For Form 16A: certificate data. */
  form16AData?: Form16ACertificateData | null;
  /** Whether the certificate has been issued to the deductee. */
  issuedToDeductee: boolean;
  /** Date issued to deductee. */
  issuedToDeducteeAt?: string | null;
  /** Method of issuance: digital | physical | both. */
  issuanceMethod?: string | null;
  /** UDIN (if applicable). */
  udin?: string | null;
  /** Remarks. */
  remarks?: string | null;
  /** Created timestamp. */
  createdAt: string;
  /** Last updated. */
  updatedAt: string;
}

/** Form 16 Part A (quarterly breakdown). */
export interface Form16PartA {
  /** Certificate number (if any). */
  certificateNumber?: string | null;
  /** Quarter breakdowns. */
  quarters: Form16QuarterBreakdown[];
  /** Total salary paid (sum of all quarters). */
  totalSalaryPaid: number;
  /** Total TDS deducted (sum of all quarters). */
  totalTdsDeducted: number;
  /** Total TDS deposited (sum of all quarters). */
  totalTdsDeposited: number;
  /** Details of TDS deposits (challans). */
  depositDetails: {
    bsrCode: string;
    challanSerial: string;
    dateOfDeposit: string;
    amount: number;
  }[];
}

/** Form 16 Part B (detailed computation). */
export interface Form16PartB {
  /** Salary breakdown (Annexure to Part B). */
  salaryAnnexure: Form16SalaryAnnexure;
  /** Chapter VI-A deductions (Annexure). */
  chapterVIAAnnexure: Form16ChapterVIAAnnexure;
  /** Other income details. */
  otherIncome: Form16OtherIncome[];
  /** Tax computation. */
  taxComputation: Form16TaxComputation;
  /** Whether the employee has declared investments. */
  investmentsDeclared: boolean;
  /** Whether investments were declared at the time of joining. */
  investmentsDeclaredAtJoining: boolean;
  /** Remarks. */
  remarks?: string | null;
}

/** Form 16A certificate data (non-salary). */
export interface Form16ACertificateData {
  /** Sections for which TDS was deducted. */
  sections: {
    section: string;
    natureOfPayment: string;
    totalAmount: number; // minor units
    totalTds: number; // minor units
    challanRefs: { bsrCode: string; challanSerial: string; dateOfDeposit: string; amount: number }[];
  }[];
  /** Total amount on which TDS was deducted. */
  totalAmount: number;
  /** Total TDS deducted. */
  totalTdsDeducted: number;
  /** Total TDS deposited. */
  totalTdsDeposited: number;
  /** Deductee's PAN validation. */
  panValidated: boolean;
}

/**
 * Generate Form 16 Part A from TDS entries.
 *
 * Part A contains: quarterly breakdown of salary paid, TDS deducted, and TDS
 * deposited, with challan references.
 */
export function generateForm16PartA(
  entries: {
    id: string;
    quarter: string;
    fy: string;
    dateOfPayment: string;
    grossAmount: number;
    tdsAmount: number;
    challanRef?: string | null;
    bsrCode?: string | null;
    challanSerial?: string | null;
    dateOfDeposit?: string | null;
    challanAmount?: number | null;
    status: string;
  }[],
  deductorName: string,
  deductorTan: string,
  fy: string,
): Form16PartA {
  const quarters: Form16QuarterBreakdown[] = [];
  const depositDetails: { bsrCode: string; challanSerial: string; dateOfDeposit: string; amount: number }[] = [];

  const quarterMap = new Map<string, Form16QuarterBreakdown>();

  for (const entry of entries) {
    let quarterData = quarterMap.get(entry.quarter);
    if (!quarterData) {
      quarterData = {
        quarter: entry.quarter,
        fromDate: quarterDateRange(entry.quarter, fy).from,
        toDate: quarterDateRange(entry.quarter, fy).to,
        totalSalaryPaid: 0,
        totalTdsDeducted: 0,
        totalTdsDeposited: 0,
        challanRefs: [],
        depositDates: [],
      };
      quarterMap.set(entry.quarter, quarterData);
    }

    quarterData.totalSalaryPaid += entry.grossAmount;
    quarterData.totalTdsDeducted += entry.tdsAmount;

    if (entry.status === "deposited" || entry.status === "filed") {
      quarterData.totalTdsDeposited += entry.challanAmount ?? entry.tdsAmount;

      if (entry.bsrCode && entry.challanSerial && entry.dateOfDeposit) {
        quarterData.challanRefs.push(`${entry.bsrCode}/${entry.challanSerial}`);
        quarterData.depositDates.push(entry.dateOfDeposit);

        depositDetails.push({
          bsrCode: entry.bsrCode,
          challanSerial: entry.challanSerial,
          dateOfDeposit: entry.dateOfDeposit,
          amount: entry.challanAmount ?? entry.tdsAmount,
        });
      }
    }
  }

  // Sort quarters
  const quarterOrder = ["Q1", "Q2", "Q3", "Q4"];
  for (const q of quarterOrder) {
    if (quarterMap.has(q)) {
      quarters.push(quarterMap.get(q)!);
    }
  }

  const totalSalaryPaid = quarters.reduce((s, q) => s + q.totalSalaryPaid, 0);
  const totalTdsDeducted = quarters.reduce((s, q) => s + q.totalTdsDeducted, 0);
  const totalTdsDeposited = quarters.reduce((s, q) => s + q.totalTdsDeposited, 0);

  return {
    certificateNumber: null,
    quarters,
    totalSalaryPaid,
    totalTdsDeducted,
    totalTdsDeposited,
    depositDetails,
  };
}

/**
 * Get the date range for a quarter in a financial year.
 */
export function quarterDateRange(quarter: string, fy: string): { from: string; to: string } {
  const [fyYear] = fy.split("-");
  const year = Number(fyYear);

  switch (quarter.toUpperCase()) {
    case "Q1":
      return { from: `${year}-04-01`, to: `${year}-06-30` };
    case "Q2":
      return { from: `${year}-07-01`, to: `${year}-09-30` };
    case "Q3":
      return { from: `${year}-10-01`, to: `${year + 1}-03-31` };
    case "Q4":
      return { from: `${year + 1}-04-01`, to: `${year + 1}-03-31` }; // Actually Q4 is Oct-Dec, but FY ends Mar
    default:
      return { from: `${year}-04-01`, to: `${year}-06-30` };
  }
}

/**
 * Generate Form 16 Part B from salary and deduction data.
 */
export function generateForm16PartB(
  salaryData: Form16SalaryAnnexure,
  chapterVIAData: Form16ChapterVIAAnnexure,
  otherIncome: Form16OtherIncome[],
  tdsDeducted: number,
  relief89: number = 0,
  relief90_91: number = 0,
  otherRelief: number = 0,
): Form16PartB {
  // Compute tax on total income (simplified slab computation for FY 2025-26 old regime)
  const totalSalary = salaryData.totalSalary;
  // ₹50,000 in true paise. This module previously used a deci-rupee unit
  // (rupees × 10) while documenting paise, so every figure it returned was a
  // factor of ten below the minor-unit contract the rest of the CA engines use.
  const standardDeduction = Math.min(salaryData.totalSalary, 50_000 * 100);
  const taxableSalary = Math.max(0, totalSalary - standardDeduction);

  const totalOtherIncome = otherIncome.reduce((s, o) => s + o.amount, 0);
  const totalIncome = Math.max(0, taxableSalary + totalOtherIncome - chapterVIAData.totalChapterVIA);

  // Simplified slab computation (old regime, FY 2025-26)
  const taxOnTotalIncome = computeOldRegimeTax(totalIncome, 0); // 0 = individual below 60

  const rebate87A = totalIncome <= 5_00_000 * 100 ? Math.min(taxOnTotalIncome, 12_500 * 100) : 0; // ₹5,00,000 ceiling, ₹12,500 max rebate (true paise)

  const surcharge = 0; // Simplified; actual surcharge depends on income level
  const cess = Math.round(((taxOnTotalIncome - rebate87A + surcharge) * 4) / 100);

  const totalTaxLiability = taxOnTotalIncome - rebate87A + surcharge + cess;
  const totalRelief = relief89 + relief90_91 + otherRelief;
  const netTaxLiability = Math.max(0, totalTaxLiability - totalRelief);
  const taxPayable = Math.max(0, netTaxLiability - tdsDeducted);
  const taxRefundable = Math.max(0, tdsDeducted - netTaxLiability);

  return {
    salaryAnnexure: salaryData,
    chapterVIAAnnexure: chapterVIAData,
    otherIncome,
    taxComputation: {
      totalIncome,
      taxOnTotalIncome,
      rebate87A,
      surcharge,
      cess,
      totalTaxLiability,
      tdsDeducted,
      relief89,
      relief90_91,
      otherRelief,
      totalRelief,
      netTaxLiability,
      taxPayable,
      taxRefundable,
    },
    investmentsDeclared: chapterVIAData.totalChapterVIA > 0,
    investmentsDeclaredAtJoining: false,
    remarks: null,
  };
}

/**
 * Compute income tax under the old regime (simplified).
 * For FY 2025-26 (AY 2026-27) for individuals below 60 years.
 */
export function computeOldRegimeTax(income: number, age: number = 0): number {
  // Slabs for FY 2025-26 (old regime, individual below 60)
  // ₹0 - ₹2,50,000: Nil
  // ₹2,50,001 - ₹5,00,000: 5%
  // ₹5,00,001 - ₹10,00,000: 20%
  // Above ₹10,00,000: 30%

  let tax = 0;
  const incomeInRupees = income / 100; // income crosses the boundary in integer paise

  if (age >= 60 && age < 80) {
    // Senior citizen slabs
    // ₹0 - ₹3,00,000: Nil
    // ₹3,00,001 - ₹5,00,000: 5%
    // ₹5,00,001 - ₹10,00,000: 20%
    // Above ₹10,00,000: 30%
    if (incomeInRupees <= 300000) {
      tax = 0;
    } else if (incomeInRupees <= 500000) {
      tax = ((incomeInRupees - 300000) * 5) / 100;
    } else if (incomeInRupees <= 1000000) {
      tax = (200000 * 5) / 100 + ((incomeInRupees - 500000) * 20) / 100;
    } else {
      tax = (200000 * 5) / 100 + (500000 * 20) / 100 + ((incomeInRupees - 1000000) * 30) / 100;
    }
  } else if (age >= 80) {
    // Super senior citizen slabs
    // ₹0 - ₹5,00,000: Nil
    // ₹5,00,001 - ₹10,00,000: 20%
    // Above ₹10,00,000: 30%
    if (incomeInRupees <= 500000) {
      tax = 0;
    } else if (incomeInRupees <= 1000000) {
      tax = ((incomeInRupees - 500000) * 20) / 100;
    } else {
      tax = (500000 * 20) / 100 + ((incomeInRupees - 1000000) * 30) / 100;
    }
  } else {
    // Individual below 60
    if (incomeInRupees <= 250000) {
      tax = 0;
    } else if (incomeInRupees <= 500000) {
      tax = ((incomeInRupees - 250000) * 5) / 100;
    } else if (incomeInRupees <= 1000000) {
      tax = (250000 * 5) / 100 + ((incomeInRupees - 500000) * 20) / 100;
    } else {
      tax = (250000 * 5) / 100 + (500000 * 20) / 100 + ((incomeInRupees - 1000000) * 30) / 100;
    }
  }

  return Math.round(tax * 100); // rupee tax → integer paise
}

/**
 * Generate a Form 16A certificate for a deductee.
 */
export function generateForm16A(
  entries: {
    id: string;
    section: string;
    natureOfPayment: string;
    grossAmount: number;
    tdsAmount: number;
    challanRef?: string | null;
    bsrCode?: string | null;
    challanSerial?: string | null;
    dateOfDeposit?: string | null;
    challanAmount?: number | null;
    status: string;
  }[],
  _deductorName: string,
  deductorTan: string,
  deducteePan: string,
  _deducteeName: string,
  _fy: string,
): Form16ACertificateData {
  // Group by section
  const sectionMap = new Map<
    string,
    {
      section: string;
      natureOfPayment: string;
      totalAmount: number;
      totalTds: number;
      challanRefs: { bsrCode: string; challanSerial: string; dateOfDeposit: string; amount: number }[];
    }
  >();

  for (const entry of entries) {
    let sectionData = sectionMap.get(entry.section);
    if (!sectionData) {
      sectionData = {
        section: entry.section,
        natureOfPayment: entry.natureOfPayment,
        totalAmount: 0,
        totalTds: 0,
        challanRefs: [],
      };
      sectionMap.set(entry.section, sectionData);
    }

    sectionData.totalAmount += entry.grossAmount;
    sectionData.totalTds += entry.tdsAmount;

    if (entry.status === "deposited" || entry.status === "filed") {
      if (entry.bsrCode && entry.challanSerial && entry.dateOfDeposit) {
        sectionData.challanRefs.push({
          bsrCode: entry.bsrCode,
          challanSerial: entry.challanSerial,
          dateOfDeposit: entry.dateOfDeposit,
          amount: entry.challanAmount ?? entry.tdsAmount,
        });
      }
    }
  }

  const sections = Array.from(sectionMap.values());
  const totalAmount = sections.reduce((s, sec) => s + sec.totalAmount, 0);
  const totalTdsDeducted = sections.reduce((s, sec) => s + sec.totalTds, 0);
  const totalTdsDeposited = sections.reduce((s, sec) => s + sec.challanRefs.reduce((cs, c) => cs + c.amount, 0), 0);

  return {
    sections,
    totalAmount,
    totalTdsDeducted,
    totalTdsDeposited,
    panValidated: /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(deducteePan),
  };
} /**
 * Create a Form 16 certificate record.
 */
export function createForm16Certificate(
  deductorTan: string,
  deductorName: string,
  deducteePan: string,
  deducteeName: string,
  fy: string,
  assessmentYear: string,
  partA: Form16PartA,
  partB: Form16PartB,
): Omit<TdsCertificate, "id" | "createdAt"> {
  return {
    certificateType: "16",
    deductorTan,
    deductorName,
    deductorPan: null,
    deductorAddress: null,
    deductorContact: null,
    deducteePan,
    deducteeName,
    deducteeAddress: null,
    financialYear: fy,
    assessmentYear,
    generatedAt: new Date().toISOString(),
    status: "draft",
    partA: partA,
    partB: partB,
    issuedToDeductee: false,
    issuedToDeducteeAt: null,
    issuanceMethod: null,
    udin: null,
    remarks: null,
    updatedAt: new Date().toISOString(),
  };
} /**
 * Create a Form 16A certificate record.
 */
export function createForm16ACertificate(
  deductorTan: string,
  deductorName: string,
  deducteePan: string,
  deducteeName: string,
  fy: string,
  assessmentYear: string,
  form16AData: Form16ACertificateData,
): Omit<TdsCertificate, "id" | "createdAt"> {
  return {
    certificateType: "16A",
    deductorTan,
    deductorName,
    deductorPan: null,
    deductorAddress: null,
    deductorContact: null,
    deducteePan,
    deducteeName,
    deducteeAddress: null,
    financialYear: fy,
    assessmentYear,
    generatedAt: new Date().toISOString(),
    status: "draft",
    partA: null,
    partB: null,
    form16AData: form16AData,
    issuedToDeductee: false,
    issuedToDeducteeAt: null,
    issuanceMethod: null,
    udin: null,
    remarks: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Validate a Form 16 / 16A certificate data.
 */
export function validateForm16Certificate(cert: TdsCertificate): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!cert.deductorTan || !/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(cert.deductorTan)) {
    issues.push("Invalid or missing deductor TAN.");
  }

  if (!cert.deducteePan || !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(cert.deducteePan)) {
    issues.push("Invalid or missing deductee PAN.");
  }

  if (!cert.financialYear || !/^\d{4}-\d{2}$/.test(cert.financialYear)) {
    issues.push("Invalid financial year format.");
  }

  if (!cert.assessmentYear || !/^\d{4}-\d{2}$/.test(cert.assessmentYear)) {
    issues.push("Invalid assessment year format.");
  }

  if (cert.certificateType === "16") {
    if (!cert.partA || !cert.partB) {
      issues.push("Form 16 requires both Part A and Part B data.");
    } else {
      // Validate Part A
      if (cert.partA.quarters.length === 0) {
        issues.push("Form 16 Part A has no quarterly breakdown.");
      }

      // Validate Part B
      const partB = cert.partB;
      if (partB.salaryAnnexure.totalSalary <= 0) {
        issues.push("Form 16 Part B: total salary must be positive.");
      }
      if (partB.taxComputation.totalTaxLiability < 0) {
        issues.push("Form 16 Part B: total tax liability cannot be negative.");
      }
    }
  } else if (cert.certificateType === "16A") {
    if (!cert.form16AData) {
      issues.push("Form 16A requires Form 16A data.");
    } else if (cert.form16AData.sections.length === 0) {
      issues.push("Form 16A has no sections.");
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Get a summary of certificates issued to a deductee.
 */
export function certificateSummaryForDeductee(
  certificates: TdsCertificate[],
  deducteePan: string,
): {
  totalCertificates: number;
  form16Count: number;
  form16ACount: number;
  issuedCount: number;
  fontIssuedCount: number;
  financialYears: string[];
} {
  const deducteeCerts = certificates.filter((c) => c.deducteePan === deducteePan);

  return {
    totalCertificates: deducteeCerts.length,
    form16Count: deducteeCerts.filter((c) => c.certificateType === "16").length,
    form16ACount: deducteeCerts.filter((c) => c.certificateType === "16A").length,
    issuedCount: deducteeCerts.filter((c) => c.issuedToDeductee).length,
    fontIssuedCount: deducteeCerts.filter((c) => !c.issuedToDeductee).length,
    financialYears: [...new Set(deducteeCerts.map((c) => c.financialYear))].sort(),
  };
}
