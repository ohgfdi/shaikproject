/**
 * TDS Challan Mapping & Bank Reconciliation Engine.
 *
 * A CA practice's TDS workflow is not done when the deduction is computed; it
 * moves to challan mapping (which challan covers which deduction), bank
 * credit reconciliation (does the challan amount actually hit the government
 * account), and correction workflows (revised returns, NIL returns,
 * deferred deductions).
 *
 * This module implements:
 *   - challan-to-deduction mapping with BSR code + challan serial as the key
 *   - bank credit reconciliation: challan amount vs. amount credited in the
 *     government account (as fetched from the bank statement / e-challan
 *     portal)
 *   - challan splitting: one challan covering multiple sections/deductees
 *   - untagged challans: challans that don't carry section tagging
 *   - challan timing: date of Deposit vs. date of deduction ordering
 *   - challan verification: BSR code format, challan serial format, date sanity
 *
 * SCOPE AND HONESTY: this is arithmetic and data validation on caller-supplied
 * challan and bank data. It does not connect to TRACES, the e-challan portal,
 * or the bank. The reconciliation status is the caller's to verify against
 * live bank credits.
 *
 * All amounts are in MINOR UNITS (paise) as integers.
 */

/** A challan receipt (from the e-challan / bank). */
export interface TdsChallanReceipt {
  /** BSR code of the bank branch (7 digits). */
  bsrCode: string;
  /** Challan serial number (as on the challan). */
  challanSerial: string;
  /** Date of deposit (yyyy-mm-dd). */
  dateOfDeposit: string;
  /** Total amount deposited, minor units. */
  amount: number;
  /** Optional: section(s) this challan is tagged to. If null, untagged. */
  section?: string | null;
  /** Optional: deductee PAN this challan is tagged to. If null, untagged. */
  deducteePan?: string | null;
  /** Optional: challan type (QDTS = quarterly, CTDS = consolidated, etc.). */
  challanType?: string | null;
  /** Optional: remarks. */
  remarks?: string | null;
  /** Whether the challan has been verified against the bank statement. */
  verified: boolean;
  /** Bank confirmation / UTR reference if available. */
  bankRef?: string | null;
}

/** A TDS deduction event (from the books). */
export interface TdsDeductionEvent {
  /** Unique id of the deduction entry. */
  id: string;
  /** Section code. */
  section: string;
  /** Deductee PAN. */
  deducteePan: string;
  /** Deductee name. */
  deducteeName: string;
  /** Amount on which TDS was computed, minor units. */
  grossAmount: number;
  /** TDS amount, minor units. */
  tdsAmount: number;
  /** Date of deduction (yyyy-mm-dd). */
  dateOfDeduction: string;
  /** Date of payment/credit (yyyy-mm-dd). */
  dateOfPaymentOrCredit: string;
  /** Status: deducted | deposited | filed | corrected. */
  status: string;
  /** Challan reference (BSR + serial) if deposited. */
  challanRef?: string | null;
  /** BSR code if deposited. */
  bsrCode?: string | null;
  /** Challan serial if deposited. */
  challanSerial?: string | null;
  /** Date of deposit if deposited. */
  dateOfDeposit?: string | null;
  /** Challan amount (what was actually deposited against this deduction). */
  challanAmount?: number | null;
  /** Whether the deduction has been verified against TRACES. */
  tracesVerified: boolean;
  /** Voucher reference. */
  voucherId?: string | null;
  /** Notes. */
  notes?: string | null;
}

/** A challan-to-deduction mapping (one challan can cover multiple deductions). */
export interface ChallanDeductionMapping {
  /** The challan receipt. */
  challan: TdsChallanReceipt;
  /** Deductions covered by this challan. */
  deductions: TdsDeductionEvent[];
  /** Total TDS covered, minor units. */
  totalCovered: number;
  /** Shortfall: (challan amount) - (total covered). Positive = excess in challan. */
  surplus: number;
  /** Whether the challan is fully utilized. */
  fullyUtilized: boolean;
  /** Whether the challan covers multiple sections. */
  multiSection: boolean;
  /** Whether the challan covers multiple deductees. */
  multiDeductee: boolean;
  /** Sections covered. */
  sections: string[];
  /** Deductee PANs covered. */
  deducteePans: string[];
}

/** Bank credit reconciliation entry. */
export interface BankReconciliationEntry {
  /** Challan receipt. */
  challan: TdsChallanReceipt;
  /** Amount as per challan, minor units. */
  challanAmount: number;
  /** Amount as per bank statement, minor units (null = not yet traced). */
  bankAmount: number | null;
  /** Difference: bank - challan. Positive = bank credited more; negative = short. */
  difference: number | null;
  /** Reconciliation status. */
  status: "matched" | "short" | "excess" | "unverified" | "disputed";
  /** Date the challan was traced in the bank statement. */
  tracedAt?: string | null;
  /** Bank statement reference. */
  bankStatementRef?: string | null;
  /** Remarks. */
  remarks?: string | null;
}

/** Challan verification result. */
export interface ChallanVerification {
  /** BSR code. */
  bsrCode: string;
  /** Challan serial. */
  challanSerial: string;
  /** Date of deposit. */
  dateOfDeposit: string;
  /** Whether the BSR code format is valid (7 digits). */
  bsrCodeValid: boolean;
  /** Whether the challan serial format is valid. */
  challanSerialValid: boolean;
  /** Whether the date is a valid date. */
  dateValid: boolean;
  /** Whether the date is in the future. */
  dateInFuture: boolean;
  /** Whether the date is before the deduction date (anomaly). */
  dateBeforeDeduction: boolean;
  /** Overall validity. */
  valid: boolean;
  /** Issues found. */
  issues: string[];
}

/**
 * Validate a BSR code format (7 digits).
 */
export function isValidBsrCode(bsrCode: string): boolean {
  return /^\d{7}$/.test(bsrCode.trim());
}

/**
 * Validate a challan serial number (alphanumeric, up to 10 chars, no special chars except hyphen).
 */
export function isValidChallanSerial(serial: string): boolean {
  return /^[A-Za-z0-9\-]{1,15}$/.test(serial.trim());
}

/**
 * Verify a challan receipt's data integrity.
 */
export function verifyChallan(challan: TdsChallanReceipt): ChallanVerification {
  const issues: string[] = [];

  const bsrValid = isValidBsrCode(challan.bsrCode);
  if (!bsrValid) issues.push(`BSR code "${challan.bsrCode}" is not a valid 7-digit code.`);

  const serialValid = isValidChallanSerial(challan.challanSerial);
  if (!serialValid) issues.push(`Challan serial "${challan.challanSerial}" has invalid format.`);

  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(challan.dateOfDeposit);
  if (!dateValid) issues.push(`Date of deposit "${challan.dateOfDeposit}" is not in yyyy-mm-dd format.`);

  const dateInFuture = dateValid && new Date(challan.dateOfDeposit) > new Date();
  if (dateInFuture) issues.push(`Date of deposit "${challan.dateOfDeposit}" is in the future.`);
  const dateBeforeDeduction = false; // caller must supply deduction date for this check

  return {
    bsrCode: challan.bsrCode,
    challanSerial: challan.challanSerial,
    dateOfDeposit: challan.dateOfDeposit,
    bsrCodeValid: bsrValid,
    challanSerialValid: serialValid,
    dateValid,
    dateInFuture,
    dateBeforeDeduction,
    valid: bsrValid && serialValid && dateValid && !dateInFuture,
    issues,
  };
}

/**
 * Map a set of challans to a set of deductions.
 *
 * This is the core of the challan mapping workflow:
 *   1. Sort deductions by date (earliest first).
 *   2. For each deduction, find the earliest challan that:
 *      - covers the section (if tagged)
 *      - covers the deductee PAN (if tagged)
 *      - has sufficient remaining balance
 *   3. Allocate the deduction amount to the challan, reducing its remaining balance.
 *   4. If no challan covers the deduction, mark it as "unmapped".
 */
export function mapChallansToDeductions(
  challans: TdsChallanReceipt[],
  deductions: TdsDeductionEvent[],
  options: {
    /** Whether to match by section. */
    matchBySection?: boolean;
    /** Whether to match by deductee PAN. */
    matchByDeducteePan?: boolean;
    /** Whether to allow untagged challans to cover any deduction. */
    allowUntaggedMatch?: boolean;
    /** Whether to allow cross-section matching (a challan tagged to one section covering another). */
    allowCrossSectionMatch?: boolean;
    /** Whether to allow cross-deductee matching (a challan tagged to one PAN covering another). */
    allowCrossDeducteeMatch?: boolean;
  } = {},
): { mappings: ChallanDeductionMapping[]; unmappedDeductions: TdsDeductionEvent[] } {
  const {
    matchBySection = true,
    matchByDeducteePan = true,
    allowUntaggedMatch = true,
    allowCrossSectionMatch = false,
    allowCrossDeducteeMatch = false,
  } = options;

  // Deep clone and sort deductions by date (earliest first)
  const sortedDeductions = [...deductions].sort(
    (a, b) => new Date(a.dateOfDeduction).getTime() - new Date(b.dateOfDeduction).getTime(),
  );

  // Deep clone challans with remaining balance tracker
  const challanBalances = new Map<string, number>();
  for (const challan of challans) {
    const key = `${challan.bsrCode}|${challan.challanSerial}`;
    challanBalances.set(key, challan.amount);
  }

  // Result mappings
  const mappingsMap = new Map<string, ChallanDeductionMapping>();
  const unmappedDeductions: TdsDeductionEvent[] = [];

  function getChallanKey(challan: TdsChallanReceipt): string {
    return `${challan.bsrCode}|${challan.challanSerial}`;
  }

  function getOrCreateMapping(challan: TdsChallanReceipt): ChallanDeductionMapping {
    const key = getChallanKey(challan);
    let mapping = mappingsMap.get(key);
    if (!mapping) {
      mapping = {
        challan,
        deductions: [],
        totalCovered: 0,
        surplus: challan.amount,
        fullyUtilized: false,
        multiSection: false,
        multiDeductee: false,
        sections: [],
        deducteePans: [],
      };
      mappingsMap.set(key, mapping);
    }
    return mapping;
  }

  function canCoverChallan(challan: TdsChallanReceipt, deduction: TdsDeductionEvent): boolean {
    // Untagged challan: can cover anything if allowed
    if (!challan.section && !challan.deducteePan) {
      return allowUntaggedMatch;
    }

    // Section matching
    if (matchBySection && challan.section) {
      if (challan.section !== deduction.section && !allowCrossSectionMatch) {
        return false;
      }
    }

    // Deductee PAN matching
    if (matchByDeducteePan && challan.deducteePan) {
      if (challan.deducteePan !== deduction.deducteePan && !allowCrossDeducteeMatch) {
        return false;
      }
    }

    return true;
  }

  function findBestChallan(deduction: TdsDeductionEvent, candidates: TdsChallanReceipt[]): TdsChallanReceipt | null {
    // Prefer challans that are:
    //   1. Tagged to the same section AND same deductee PAN (exact match)
    //   2. Tagged to the same section (section match)
    //   3. Tagged to the same deductee PAN (deductee match)
    //   4. Untagged (if allowed)
    //   5. Cross-section or cross-deductee (if allowed)

    let best: TdsChallanReceipt | null = null;
    let bestScore = -1;

    for (const challan of candidates) {
      if (!canCoverChallan(challan, deduction)) continue;

      const balance = challanBalances.get(getChallanKey(challan)) ?? 0;
      if (balance < deduction.tdsAmount) continue; // insufficient balance

      let score = 0;

      if (challan.section && challan.section === deduction.section) score += 100;
      if (challan.deducteePan && challan.deducteePan === deduction.deducteePan) score += 50;
      if (!challan.section && !challan.deducteePan && allowUntaggedMatch) score += 10;
      if (challan.section && challan.section !== deduction.section && allowCrossSectionMatch) score += 5;
      if (challan.deducteePan && challan.deducteePan !== deduction.deducteePan && allowCrossDeducteeMatch) score += 5;

      if (score > bestScore) {
        bestScore = score;
        best = challan;
      }
    }

    return best;
  }

  // Process each deduction
  for (const deduction of sortedDeductions) {
    if (deduction.status === "filed" || deduction.status === "corrected") {
      // Already mapped (via challanRef); skip
      continue;
    }

    // Find candidate challans (sorted by date, earliest first)
    const candidates = [...challans]
      .filter((c) => canCoverChallan(c, deduction))
      .sort((a, b) => new Date(a.dateOfDeposit).getTime() - new Date(b.dateOfDeposit).getTime());

    const bestChallan = findBestChallan(deduction, candidates);

    if (!bestChallan) {
      unmappedDeductions.push(deduction);
      continue;
    }

    const key = getChallanKey(bestChallan);
    const balance = challanBalances.get(key) ?? 0;

    if (balance < deduction.tdsAmount) {
      unmappedDeductions.push(deduction);
      continue;
    }

    // Allocate
    challanBalances.set(key, balance - deduction.tdsAmount);

    const mapping = getOrCreateMapping(bestChallan);
    mapping.deductions.push(deduction);
    mapping.totalCovered += deduction.tdsAmount;
    mapping.surplus = bestChallan.amount - mapping.totalCovered;
    mapping.fullyUtilized = mapping.surplus === 0;
    mapping.multiSection = mapping.sections.includes(deduction.section) ? mapping.multiSection : true;
    mapping.multiDeductee = mapping.deducteePans.includes(deduction.deducteePan) ? mapping.multiDeductee : true;
    if (!mapping.sections.includes(deduction.section)) mapping.sections.push(deduction.section);
    if (!mapping.deducteePans.includes(deduction.deducteePan)) mapping.deducteePans.push(deduction.deducteePan);

    // Update deduction with challan ref
    // (In a real implementation, this would update the deduction record in the DB)
  }

  return {
    mappings: Array.from(mappingsMap.values()).sort(
      (a, b) => new Date(a.challan.dateOfDeposit).getTime() - new Date(b.challan.dateOfDeposit).getTime(),
    ),
    unmappedDeductions,
  };
}

/**
 * Reconcile challans against bank statement data.
 */
export function reconcileChallans(
  challans: TdsChallanReceipt[],
  bankStatement: { date: string; description: string; amount: number; ref: string }[],
): BankReconciliationEntry[] {
  const entries: BankReconciliationEntry[] = [];

  for (const challan of challans) {
    // Candidate bank entries are those dated within 3 days of the challan's
    // deposit date. Amount must not gate the match: a shortfall or excess is
    // exactly the case this reconciliation exists to surface, and an
    // amount-equality filter would mark it "unverified" instead. Amount is
    // used only to prefer an exact candidate when several fall in the window.
    const challanTime = new Date(`${challan.dateOfDeposit}T00:00:00Z`).getTime();
    const candidates = bankStatement.filter(
      (b) => Math.abs(new Date(`${b.date}T00:00:00Z`).getTime() - challanTime) <= 3 * 24 * 60 * 60 * 1000,
    );
    const exactMatches = candidates.filter((b) => b.amount === challan.amount);
    const matchingBankEntries = exactMatches.length > 0 ? exactMatches : candidates;

    let bankAmount: number | null = null;
    let difference: number | null = null;
    let status: BankReconciliationEntry["status"] = "unverified";
    let tracedAt: string | null = null;
    let bankStatementRef: string | null = null;
    let remarks: string | null = null;

    if (matchingBankEntries.length === 0) {
      status = "unverified";
      remarks = "No matching bank entry found.";
    } else if (matchingBankEntries.length === 1) {
      const bankEntry = matchingBankEntries[0]!;
      bankAmount = bankEntry.amount;
      difference = bankEntry.amount - challan.amount;
      tracedAt = bankEntry.date;
      bankStatementRef = bankEntry.ref;

      if (difference === 0) {
        status = "matched";
      } else if (difference < 0) {
        status = "short";
        remarks = `Bank credited ${bankAmount / 100} vs challan ${challan.amount / 100}; short by ${Math.abs(difference) / 100}.`;
      } else {
        status = "excess";
        remarks = `Bank credited ${bankAmount / 100} vs challan ${challan.amount / 100}; excess by ${difference / 100}.`;
      }
    } else {
      // Multiple matches — ambiguous
      status = "disputed";
      bankAmount = matchingBankEntries[0]!.amount;
      difference = bankAmount - challan.amount;
      tracedAt = matchingBankEntries[0]!.date;
      bankStatementRef = matchingBankEntries[0]!.ref;
      remarks = `Multiple bank entries match this challan; manual review required.`;
    }

    entries.push({
      challan,
      challanAmount: challan.amount,
      bankAmount,
      difference,
      status,
      tracedAt,
      bankStatementRef,
      remarks,
    });
  }

  return entries.sort(
    (a, b) => new Date(a.challan.dateOfDeposit).getTime() - new Date(b.challan.dateOfDeposit).getTime(),
  );
}

/**
 * Get challan coverage summary.
 */
export function challanCoverageSummary(
  mappings: ChallanDeductionMapping[],
  unmappedDeductions: TdsDeductionEvent[],
): {
  totalChallans: number;
  totalChallanAmount: number;
  totalDeductionAmount: number;
  totalMappedAmount: number;
  totalUnmappedAmount: number;
  fullyUtilizedChallans: number;
  partiallyUtilizedChallans: number;
  unmappedDeductionsCount: number;
  unmappedDeductionsAmount: number;
  multiSectionChallans: number;
  multiDeducteeChallans: number;
  untaggedChallans: number;
  coveragePercentage: number;
} {
  const totalChallans = mappings.length;
  const totalChallanAmount = mappings.reduce((s, m) => s + m.challan.amount, 0);
  const totalDeductionAmount =
    mappings.reduce((s, m) => s + m.totalCovered, 0) + unmappedDeductions.reduce((s, d) => s + d.tdsAmount, 0);
  const totalMappedAmount = mappings.reduce((s, m) => s + m.totalCovered, 0);
  const totalUnmappedAmount = unmappedDeductions.reduce((s, d) => s + d.tdsAmount, 0);
  const fullyUtilizedChallans = mappings.filter((m) => m.fullyUtilized).length;
  const partiallyUtilizedChallans = mappings.filter((m) => !m.fullyUtilized).length;
  const unmappedDeductionsCount = unmappedDeductions.length;
  const unmappedDeductionsAmount = unmappedDeductions.reduce((s, d) => s + d.tdsAmount, 0);
  const multiSectionChallans = mappings.filter((m) => m.multiSection).length;
  const multiDeducteeChallans = mappings.filter((m) => m.multiDeductee).length;
  const untaggedChallans = mappings.filter((m) => !m.challan.section && !m.challan.deducteePan).length;
  const coveragePercentage = totalChallanAmount > 0 ? (totalMappedAmount / totalChallanAmount) * 100 : 0;

  return {
    totalChallans,
    totalChallanAmount,
    totalDeductionAmount,
    totalMappedAmount,
    totalUnmappedAmount,
    fullyUtilizedChallans,
    partiallyUtilizedChallans,
    unmappedDeductionsCount,
    unmappedDeductionsAmount,
    multiSectionChallans,
    multiDeducteeChallans,
    untaggedChallans,
    coveragePercentage,
  };
}

/**
 * Get outstanding (unmapped) deductions that need challan allocation.
 */
export function outstandingDeductions(
  mappings: ChallanDeductionMapping[],
  deductions: TdsDeductionEvent[],
): TdsDeductionEvent[] {
  const mappedDeductionIds = new Set<string>();

  for (const mapping of mappings) {
    for (const deduction of mapping.deductions) {
      mappedDeductionIds.add(deduction.id);
    }
  }

  return deductions.filter((d) => !mappedDeductionIds.has(d.id) && d.status !== "filed" && d.status !== "corrected");
}

/**
 * Get challans with insufficient utilization (challan amount > mapped amount).
 */
export function underutilizedChallans(
  mappings: ChallanDeductionMapping[],
  thresholdPercent: number = 10,
): ChallanDeductionMapping[] {
  return mappings.filter((m) => m.surplus > 0 && (m.surplus / m.challan.amount) * 100 > thresholdPercent);
}

/**
 * Get a report of challan utilization by section.
 */
export function challanUtilizationBySection(
  mappings: ChallanDeductionMapping[],
): Record<string, { challanCount: number; challanAmount: number; coveredAmount: number; utilizationPercent: number }> {
  const result: Record<
    string,
    { challanCount: number; challanAmount: number; coveredAmount: number; utilizationPercent: number }
  > = {};

  for (const mapping of mappings) {
    for (const section of mapping.sections) {
      if (!result[section]) {
        result[section] = { challanCount: 0, challanAmount: 0, coveredAmount: 0, utilizationPercent: 0 };
      }
      result[section].challanCount += 1;
      result[section].challanAmount += mapping.challan.amount;
      result[section].coveredAmount += mapping.totalCovered;
      result[section].utilizationPercent =
        result[section].challanAmount > 0 ? (result[section].coveredAmount / result[section].challanAmount) * 100 : 0;
    }
  }

  return result;
}
