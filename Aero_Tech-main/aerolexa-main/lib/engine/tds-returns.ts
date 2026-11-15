/**
 * TDS returns engine — quarterly return preparation in Form 24Q / 26Q / 27Q shape.
 *
 * `ca-india.ts` decides WHAT to deduct. This module prepares the RETURN a CA
 * actually files: deductee-wise consolidation, section-wise summary, challan
 * reconciliation, and the two penalties that make a late return expensive —
 * interest u/s 201(1A) and the fee u/s 234E.
 *
 * The rules implemented:
 *   - 201(1A)(i):  1% per month or part of a month for tax NOT DEDUCTED on
 *     time (from the date deductible to the date deducted).
 *   - 201(1A)(ii): 1.5% per month or part of a month for tax deducted but NOT
 *     PAID on time (from deduction to deposit).
 *   - 234E:        ₹200 per day of delay in filing, capped at the TDS amount.
 *   - Deposit due: 7th of the following month; 30 April for March deductions.
 *
 * SCOPE AND HONESTY — same contract as the other CA engines: this PREPARES the
 * return figures and computes exposure. It does NOT generate the RPU/FOFU
 * upload file, does not validate against the TRACES schema, and does not file.
 * Rates, due dates and the per-day fee are caller-supplied DATA with labelled
 * defaults; a Finance Act change is the caller's to own.
 *
 * Money is in MINOR UNITS (paise) as integers, matching the rest of the CA
 * engines.
 */

import { formatInr } from "./india-tax";

export class TdsReturnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TdsReturnError";
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type TdsForm = "24Q" | "26Q" | "27Q";

/** Sections that belong in Form 27Q (payments to non-residents). */
export const NON_RESIDENT_SECTIONS: readonly string[] = [
  "192",
  "194E",
  "194LC",
  "194LD",
  "195",
  "196A",
  "196B",
  "196C",
  "196D",
];

export interface TdsDeductionRecord {
  payeeName: string;
  pan: string | null;
  section: string;
  /** Payment on which TDS was due, minor units. */
  baseAmount: number;
  /** Rate applied, %. */
  ratePct: number;
  /** Tax actually deducted, minor units. */
  deducted: number;
  /** Date the tax became deductible (payment / credit date). */
  deductibleDate: string;
  /** Date the tax was actually deducted. */
  deductedDate: string;
  /** Date deposited into the government account; null = not yet deposited. */
  depositedDate?: string | null;
}

export interface TdsChallan {
  bsrCode: string;
  challanSerial: string;
  dateOfDeposit: string;
  /** Minor units. */
  amount: number;
  /** Optional section tagging; untagged challans count to the return total. */
  section?: string | null;
}

export interface TdsReturnInput {
  form: TdsForm;
  tan: string;
  quarter: { from: string; to: string };
  /** Statutory filing due date (caller data). */
  filingDueDate: string;
  /** Actual or expected filing date — drives the 234E fee. */
  filingDate?: string;
  deductions: TdsDeductionRecord[];
  challans: TdsChallan[];
  /** 201(1A)(i) rate. Default 1. */
  lateDeductionRatePctPerMonth?: number;
  /** 201(1A)(ii) rate. Default 1.5. */
  lateDepositRatePctPerMonth?: number;
  /** 234E fee per day, minor units. Default ₹200. */
  feePerDay?: number;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface TdsInterestRow {
  payeeName: string;
  section: string;
  reason: "late-deduction" | "late-deposit";
  from: string;
  to: string;
  /** Months or part of a month (201(1A) counts part months as full). */
  months: number;
  ratePctPerMonth: number;
  base: number;
  interest: number;
}

export interface TdsReturnResult {
  form: TdsForm;
  tan: string;
  quarter: { from: string; to: string };
  /** Deductee rows consolidated by PAN + section. */
  deductees: { pan: string; payeeName: string; section: string; baseAmount: number; deducted: number }[];
  sectionSummary: {
    section: string;
    count: number;
    baseAmount: number;
    deducted: number;
    depositedTagged: number;
    shortfall: number;
  }[];
  challans: { count: number; totalDeposited: number };
  totals: { baseAmount: number; deducted: number; deposited: number; depositShortfall: number };
  interest: { rows: TdsInterestRow[]; total: number };
  lateFilingFee: { days: number; fee: number; cappedAtTds: boolean };
  /** Total exposure: interest + fee. */
  totalExposure: number;
  panIssues: string[];
  warnings: string[];
  methodology: string[];
}

// ---------------------------------------------------------------------------
// Date arithmetic
// ---------------------------------------------------------------------------

function isoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TdsReturnError(`${field} must be yyyy-mm-dd (got "${value}").`);
  }
  return value;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

/**
 * Months or part of a month between two dates (201(1A) counts part months as
 * full): 15 Apr → 10 May = 2 (April part + May part); 15 Apr → 20 Apr = 1.
 */
export function monthsOrPart(fromIso: string, toIso: string): number {
  if (toIso <= fromIso) return 0;
  const y1 = Number(fromIso.slice(0, 4));
  const m1 = Number(fromIso.slice(5, 7));
  const y2 = Number(toIso.slice(0, 4));
  const m2 = Number(toIso.slice(5, 7));
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}

/**
 * Deposit due date for tax deducted on `deductedDate`: the 7th of the
 * following month; 30 April for March deductions (the rule for deductors
 * other than government offices is 30 April for March, 7th otherwise).
 */
export function depositDueDate(deductedDate: string): string {
  const y = Number(deductedDate.slice(0, 4));
  const m = Number(deductedDate.slice(5, 7));
  if (m === 3) return `${y}-04-30`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return `${nextY}-${String(nextM).padStart(2, "0")}-07`;
}

// ---------------------------------------------------------------------------
// The return
// ---------------------------------------------------------------------------

export function prepareTdsReturn(input: TdsReturnInput): TdsReturnResult {
  const quarterFrom = isoDate(input.quarter.from, "quarter.from");
  const quarterTo = isoDate(input.quarter.to, "quarter.to");
  const filingDue = isoDate(input.filingDueDate, "filingDueDate");
  const lateDeductionRate = input.lateDeductionRatePctPerMonth ?? 1;
  const lateDepositRate = input.lateDepositRatePctPerMonth ?? 1.5;
  const feePerDay = input.feePerDay ?? 20_000; // ₹200 in paise

  const warnings: string[] = [];
  const panIssues: string[] = [];
  const interestRows: TdsInterestRow[] = [];

  // ---- form ↔ section consistency -----------------------------------------
  for (const d of input.deductions) {
    const section = d.section.toUpperCase();
    if (input.form === "24Q" && section !== "192") {
      warnings.push(
        `Form 24Q carries salary TDS only (s192); row for ${d.payeeName} is ${d.section} — belongs in 26Q/27Q.`,
      );
    }
    if (input.form === "26Q" && section === "192") {
      warnings.push(`Form 26Q must not carry salary TDS (s192); row for ${d.payeeName} belongs in 24Q.`);
    }
    if (input.form === "26Q" && NON_RESIDENT_SECTIONS.includes(section) && section !== "192") {
      warnings.push(`Form 26Q row for ${d.payeeName} (s${d.section}) looks non-resident — those belong in 27Q.`);
    }
    if (input.form === "27Q" && section === "192") {
      warnings.push(`Form 27Q must not carry salary TDS (s192); row for ${d.payeeName} belongs in 24Q.`);
    }
  }

  // ---- deductee consolidation + interest ----------------------------------
  const deducteeKey = (pan: string, section: string) => `${pan}|${section.toUpperCase()}`;
  const deductees = new Map<
    string,
    { pan: string; payeeName: string; section: string; baseAmount: number; deducted: number }
  >();
  let totalBase = 0;
  let totalDeducted = 0;

  for (const d of input.deductions) {
    isoDate(d.deductibleDate, "deductibleDate");
    isoDate(d.deductedDate, "deductedDate");
    if (d.deducted < 0 || d.baseAmount < 0) {
      throw new TdsReturnError(`Row for ${d.payeeName}: amounts cannot be negative.`);
    }
    const pan = (d.pan ?? "").trim().toUpperCase();
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
      panIssues.push(
        `${d.payeeName}: PAN "${d.pan ?? "(missing)"}" is missing or malformed — the deductee row will be rejected by TRACES.`,
      );
    }

    const key = deducteeKey(pan || `(no-pan:${d.payeeName})`, d.section);
    const row = deductees.get(key) ?? {
      pan: pan || "(missing)",
      payeeName: d.payeeName,
      section: d.section.toUpperCase(),
      baseAmount: 0,
      deducted: 0,
    };
    row.baseAmount += d.baseAmount;
    row.deducted += d.deducted;
    deductees.set(key, row);
    totalBase += d.baseAmount;
    totalDeducted += d.deducted;

    // 201(1A)(i) — late deduction.
    const lateDeductionMonths = monthsOrPart(d.deductibleDate, d.deductedDate);
    if (lateDeductionMonths > 0) {
      interestRows.push({
        payeeName: d.payeeName,
        section: d.section.toUpperCase(),
        reason: "late-deduction",
        from: d.deductibleDate,
        to: d.deductedDate,
        months: lateDeductionMonths,
        ratePctPerMonth: lateDeductionRate,
        base: d.deducted,
        interest: Math.round((d.deducted * lateDeductionRate * lateDeductionMonths) / 100),
      });
    }

    // 201(1A)(ii) — late deposit.
    const due = depositDueDate(d.deductedDate);
    if (d.depositedDate) {
      isoDate(d.depositedDate, "depositedDate");
      const lateDepositMonths = monthsOrPart(due, d.depositedDate);
      if (lateDepositMonths > 0) {
        interestRows.push({
          payeeName: d.payeeName,
          section: d.section.toUpperCase(),
          reason: "late-deposit",
          from: due,
          to: d.depositedDate,
          months: lateDepositMonths,
          ratePctPerMonth: lateDepositRate,
          base: d.deducted,
          interest: Math.round((d.deducted * lateDepositRate * lateDepositMonths) / 100),
        });
      }
    } else {
      warnings.push(
        `${d.payeeName}: tax of ${formatInr(d.deducted)} (s${d.section}) has no deposit date — 201(1A)(ii) interest accrues until paid.`,
      );
    }
  }

  // ---- challans ------------------------------------------------------------
  let totalDeposited = 0;
  const depositedBySection = new Map<string, number>();
  for (const c of input.challans) {
    isoDate(c.dateOfDeposit, "challan.dateOfDeposit");
    totalDeposited += c.amount;
    if (c.section) {
      const key = c.section.toUpperCase();
      depositedBySection.set(key, (depositedBySection.get(key) ?? 0) + c.amount);
    }
  }

  const sectionKeys = [...new Set(input.deductions.map((d) => d.section.toUpperCase()))].sort();
  // A per-section shortfall is only knowable when challans carry section tags;
  // untagged deposits are attributed at the RETURN level, never guessed here.
  const anySectionTags = input.challans.some((c) => c.section);
  const sectionSummary = sectionKeys.map((section) => {
    const rows = input.deductions.filter((d) => d.section.toUpperCase() === section);
    const deducted = rows.reduce((s, d) => s + d.deducted, 0);
    const tagged = depositedBySection.get(section) ?? 0;
    return {
      section,
      count: rows.length,
      baseAmount: rows.reduce((s, d) => s + d.baseAmount, 0),
      deducted,
      depositedTagged: tagged,
      shortfall: anySectionTags ? Math.max(0, deducted - tagged) : 0,
    };
  });

  const depositShortfall = Math.max(0, totalDeducted - totalDeposited);
  if (depositShortfall > 0) {
    warnings.push(
      `Challans cover ${formatInr(totalDeposited)} of ${formatInr(totalDeducted)} deducted — shortfall ${formatInr(depositShortfall)} must be deposited before the return is accepted.`,
    );
  }
  if (anySectionTags && sectionSummary.some((s) => s.shortfall > 0)) {
    warnings.push(
      "Some section-wise challan tags leave a per-section shortfall even though the return total may match.",
    );
  }

  // ---- 234E ----------------------------------------------------------------
  const filingDate = input.filingDate ? isoDate(input.filingDate, "filingDate") : null;
  const feeDays = filingDate ? daysBetween(filingDue, filingDate) : 0;
  const rawFee = feeDays * feePerDay;
  const fee = Math.min(rawFee, totalDeducted);
  const cappedAtTds = rawFee > totalDeducted && totalDeducted > 0;

  // ---- totals --------------------------------------------------------------
  const interestTotal = interestRows.reduce((s, r) => s + r.interest, 0);

  if (panIssues.length > 0) {
    warnings.push(
      `${panIssues.length} deductee row(s) have an invalid PAN — TRACES will reject them and the payee cannot claim the credit.`,
    );
  }
  if (interestTotal > 0) {
    warnings.push(`201(1A) interest exposure ${formatInr(interestTotal)} (late deduction and/or late deposit).`);
  }
  if (feeDays > 0) {
    warnings.push(
      `234E fee for ${feeDays} day(s) late filing: ${formatInr(fee)}${cappedAtTds ? " (capped at the TDS amount)" : ""}.`,
    );
  }

  return {
    form: input.form,
    tan: input.tan,
    quarter: { from: quarterFrom, to: quarterTo },
    deductees: [...deductees.values()].sort(
      (a, b) => a.section.localeCompare(b.section) || a.payeeName.localeCompare(b.payeeName),
    ),
    sectionSummary,
    challans: { count: input.challans.length, totalDeposited },
    totals: { baseAmount: totalBase, deducted: totalDeducted, deposited: totalDeposited, depositShortfall },
    interest: { rows: interestRows, total: interestTotal },
    lateFilingFee: { days: feeDays, fee, cappedAtTds },
    totalExposure: interestTotal + fee,
    panIssues,
    warnings,
    methodology: [
      `Form ${input.form} for TAN ${input.tan}, quarter ${quarterFrom} .. ${quarterTo}; ${input.deductions.length} deduction(s) consolidated into ${deductees.size} deductee row(s).`,
      `201(1A)(i) late deduction at ${lateDeductionRate}%/month and 201(1A)(ii) late deposit at ${lateDepositRate}%/month; part months count as full. Deposit due: 7th of the following month (30 April for March).`,
      `234E fee ${formatInr(feePerDay)}/day from the due date ${filingDue}${filingDate ? ` to the filing date ${filingDate}` : " (no filing date supplied)"}; capped at the TDS amount.`,
      `Totals: base ${formatInr(totalBase)}, deducted ${formatInr(totalDeducted)}, deposited ${formatInr(totalDeposited)}.`,
    ],
  };
}
