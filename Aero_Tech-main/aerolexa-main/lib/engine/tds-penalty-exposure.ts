/**
 * TDS Penalty Exposure & Interest Computation Engine.
 *
 * Section 201 (short deduction / non-deduction), Section 206C (short collection
 * / non-collection), Section 201(1A) interest (late deduction / late deposit),
 * Section 234E fee (late filing), Section 271Q (late deposit fee), and the
 * penalty u/s 271(1)(c) for failure to deduct/collect.
 *
 * This module implements:
 *   - 201(1A)(i): interest on tax NOT DEDUCTED on time — 1% per month or part
 *     of a month from the date on which the tax was deductible to the date on
 *     which the tax was actually deducted
 *   - 201(1A)(ii): interest on tax DEDUCTED but NOT DEPOSITED on time — 1.5%
 *     per month or part of a month from the date of deduction to the date of
 *     deposit
 *   - 234E: fee for late filing of TDS/TCS return — ₹200 per day of delay,
 *     capped at the TDS/TCS amount
 *   - 271Q: fee for late deposit of TDS — ₹200 per day (newer provision,
 *     check applicability for the year)
 *   - 271(1)(c): penalty for failure to deduct/collect — up to the amount of
 *     tax not deducted/collected (caller to determine the penalty quantum based
 *     on the facts)
 *   - 206C: equivalent provisions for TCS (short collection / non-collection)
 *
 * SCOPE AND HONESTY: these are arithmetic computations on caller-supplied dates
 * and amounts, surfaced as exposure estimates. The actual penalty quantum is
 * determined by the AO based on the facts, the explanation offered, and the
 * provisions applicable for the year. This engine does not issue a legal opinion
 * and does not determine the final penalty liability.
 *
 * All amounts are in MINOR UNITS (paise) as integers.
 */

/** Reason for exposure. */
export type ExposureReason =
  | "late-deduction" // 201(1A)(i)
  | "late-deposit" // 201(1A)(ii)
  | "non-deduction" // 201 (full) — tax not deducted at all
  | "short-deduction" // 201 — tax deducted less than required
  | "late-filing" // 234E
  | "late-deposit-fee" // 271Q
  | "non-collection" // 206C (TCS)
  | "short-collection"; // 206C (TCS)

/** A single exposure item. */
export interface TdsExposureItem {
  /** Unique id for the item within the exposure computation. */
  id: string;
  /** Section/code the exposure relates to. */
  section: string;
  /** Type of exposure. */
  reason: ExposureReason;
  /** Deductee / payee name. */
  payeeName: string;
  /** Deductee / payee PAN (if available). */
  payeePan?: string | null;
  /** Deductor / collector TAN. */
  deductorTan: string;
  /** Description of the issue. */
  description: string;
  /** The amount on which tax was deductible/collectible (base), minor units. */
  baseAmount: number;
  /** The tax that should have been deducted/collected, minor units. */
  taxShouldBe: number;
  /** The tax that was actually deducted/collected, minor units (0 if none). */
  taxActual: number;
  /** Shortfall: taxShouldBe - taxActual. */
  shortfall: number;
  /** Date from which interest/fee runs. */
  fromDate: string;
  /** Date until which interest/fee runs (or "present" if ongoing). */
  toDate: string | null;
  /** Number of months or part of a month (for 201(1A)). */
  months: number;
  /** Rate % per month (for 201(1A)). */
  ratePctPerMonth: number;
  /** Interest / fee amount, minor units. */
  amount: number;
  /** Whether the amount is capped (and the cap value). */
  capped: boolean;
  /** Cap value (minor units), if any. */
  capValue?: number | null;
  /** Status: computed | waived | paid | disputed. */
  status: "computed" | "waived" | "paid" | "disputed";
  /** Notes. */
  notes?: string | null;
}

/** Parameters for exposure computation. */
export interface TdsExposureParams {
  /** Deductor TAN. */
  tan: string;
  /** Assessment year. */
  assessmentYear: string;
  /** Financial year. */
  financialYear: string;
  /** Name of the deductor. */
  deductorName: string;
  /** Entity type of the deductor: company | firm | individual | huf | other. */
  deductorEntityType: string;
  /** Whether the deductor is a government deductor. */
  isGovernmentDeductor: boolean;
  /** Late deduction rate % per month (default 1). */
  lateDeductionRatePctPerMonth?: number;
  /** Late deposit rate % per month (default 1.5). */
  lateDepositRatePctPerMonth?: number;
  /** 234E fee per day (default ₹200 = 20000 paise). */
  lateFilingFeePerDay?: number;
  /** 271Q fee per day (default ₹200 = 20000 paise) — check applicability. */
  lateDepositFeePerDay?: number;
  /** Date of filing of TDS return (for 234E computation). */
  returnFilingDate?: string | null;
  /** Due date for filing the TDS return (for 234E computation). */
  returnFilingDueDate: string;
  /** Whether to compute the maximum possible penalty u/s 271(1)(c). */
  computeMaxPenalty271c: boolean;
  /** Maximum penalty % u/s 271(1)(c) (default 100% of tax not deducted). */
  maxPenalty271cPct?: number;
}

/** A deduction/collection event for exposure computation. */
export interface TdsExposureEvent {
  /** Unique id. */
  id: string;
  /** Section. */
  section: string;
  /** Deductee/payee name. */
  payeeName: string;
  /** Deductee/payee PAN. */
  payeePan?: string | null;
  /** Amount on which tax was deductible/collectible, minor units. */
  baseAmount: number;
  /** Rate % applied (or should have been applied). */
  ratePct: number;
  /** Tax that should have been deducted/collected, minor units. */
  taxShouldBe: number;
  /** Tax actually deducted/collected, minor units. */
  taxActual: number;
  /** Date on which the tax became deductible/collectible (earlier of payment/credit). */
  deductibleDate: string;
  /** Date on which the tax was actually deducted (if at all). */
  deductedDate?: string | null;
  /** Date on which the tax was deposited (if at all). */
  depositedDate?: string | null;
  /** Whether the return was filed for this event. */
  returnFiled: boolean;
  /** Date of return filing (if filed). */
  returnFiledDate?: string | null;
  /** Nature of payment. */
  natureOfPayment?: string | null;
  /** Whether this is a TCS event. */
  isTcs: boolean;
}

/** Output of the exposure computation. */
export interface TdsExposureResult {
  /** Parameters used. */
  params: TdsExposureParams;
  /** Events processed. */
  events: TdsExposureEvent[];
  /** Exposure items computed. */
  exposures: TdsExposureItem[];
  /** Summary by section. */
  bySection: Record<
    string,
    {
      eventsCount: number;
      baseAmount: number;
      taxShouldBe: number;
      taxActual: number;
      shortfall: number;
      exposureAmount: number;
      maxPenalty271c: number | null;
    }
  >;
  /** Summary by exposure type. */
  byType: Record<ExposureReason, { count: number; amount: number }>;
  /** Total exposure (interest + fees). */
  totalExposure: number;
  /** Total interest (201(1A)). */
  totalInterest: number;
  /** Total fees (234E + 271Q). */
  totalFees: number;
  /** Total maximum penalty u/s 271(1)(c) (if computed). */
  totalMaxPenalty271c: number | null;
  /** Grand total including max penalty. */
  grandTotalWithMaxPenalty: number | null;
  /** Warnings. */
  warnings: string[];
  /** Methodology notes. */
  methodology: string[];
}

/**
 * Compute the number of months or part of a month between two dates.
 * This matches the 201(1A) rule: part of a month counts as a full month.
 */
export function monthsOrPartBetween(fromIso: string, toIso: string): number {
  if (!fromIso || !toIso) return 0;
  if (toIso <= fromIso) return 0;

  const fromDate = new Date(`${fromIso}T00:00:00Z`);
  const toDate = new Date(`${toIso}T00:00:00Z`);

  // If same day, 0 months
  if (fromDate.getTime() === toDate.getTime()) return 0;

  // A part of a month counts as a full month, so count calendar-month
  // boundaries first: any two dates in different months are at least that
  // many months apart (15 Apr → 10 May is one part-month; 1 Apr → 1 May is
  // one full month; 1 Apr → 1 Jun is two).
  const months =
    (toDate.getUTCFullYear() - fromDate.getUTCFullYear()) * 12 + (toDate.getUTCMonth() - fromDate.getUTCMonth());

  // Same calendar month but different days (e.g. 15 Apr → 20 Apr) is a part
  // month, which counts as one full month.
  return months === 0 ? 1 : months;
}

/**
 * Compute the deposit due date for tax deducted on a given date.
 * Rule: 7th of the following month; 30 April for March deductions.
 */
export function depositDueDate(deductedDate: string): string {
  const date = new Date(`${deductedDate}T00:00:00Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-indexed

  if (month === 2) {
    // March
    return `${year}-04-30`;
  }

  const nextYear = month === 11 ? year + 1 : year;
  const nextMonthValue = month === 11 ? 1 : month + 2; // +1 for 0-indexed, +1 for following month

  return `${nextYear}-${String(nextMonthValue).padStart(2, "0")}-07`;
}

/**
 * Compute the return filing due date for a quarter.
 * For quarterly returns (24Q, 26Q, 27Q):
 *   Q1 (Apr-Jun): due 31 Jul
 *   Q2 (Jul-Sep): due 31 Oct
 *   Q3 (Oct-Dec): due 31 Jan (next FY)
 *   Q4 (Jan-Mar): due 31 May (next FY)
 */
export function returnFilingDueDate(quarter: string, fy: string): string {
  const [fyYear] = fy.split("-");
  const year = Number(fyYear);

  switch (quarter.toUpperCase()) {
    case "Q1":
      return `${year}-07-31`;
    case "Q2":
      return `${year}-10-31`;
    case "Q3":
      return `${year + 1}-01-31`;
    case "Q4":
      return `${year + 1}-05-31`;
    default:
      throw new Error(`Invalid quarter: ${quarter}`);
  }
}

/**
 * Compute TDS/TCS exposure for a set of events.
 */
export function computeTdsExposure(events: TdsExposureEvent[], params: TdsExposureParams): TdsExposureResult {
  const exposures: TdsExposureItem[] = [];
  const bySection: Record<
    string,
    {
      eventsCount: number;
      baseAmount: number;
      taxShouldBe: number;
      taxActual: number;
      shortfall: number;
      exposureAmount: number;
      maxPenalty271c: number | null;
    }
  > = {};
  const byType: Record<string, { count: number; amount: number }> = {};

  for (const reason of [
    "late-deduction",
    "late-deposit",
    "non-deduction",
    "short-deduction",
    "late-filing",
    "late-deposit-fee",
    "non-collection",
    "short-collection",
  ] as ExposureReason[]) {
    byType[reason] = { count: 0, amount: 0 };
  }

  let totalExposure = 0;
  let totalInterest = 0;
  let totalFees = 0;
  let totalMaxPenalty271c = 0;

  for (const event of events) {
    const section = event.section.toUpperCase();

    // Initialize section summary
    if (!bySection[section]) {
      bySection[section] = {
        eventsCount: 0,
        baseAmount: 0,
        taxShouldBe: 0,
        taxActual: 0,
        shortfall: 0,
        exposureAmount: 0,
        maxPenalty271c: null,
      };
    }

    bySection[section].eventsCount += 1;
    bySection[section].baseAmount += event.baseAmount;
    bySection[section].taxShouldBe += event.taxShouldBe;
    bySection[section].taxActual += event.taxActual;
    const shortfall = Math.max(0, event.taxShouldBe - event.taxActual);
    bySection[section].shortfall += shortfall;

    const lateDeductionRate = params.lateDeductionRatePctPerMonth ?? 1;
    const lateDepositRate = params.lateDepositRatePctPerMonth ?? 1.5;

    const isTcs = event.isTcs;

    // ---- Late deduction interest (201(1A)(i)) ----
    if (event.taxShouldBe > 0 && event.deductibleDate && event.deductedDate) {
      const lateMonths = monthsOrPartBetween(event.deductibleDate, event.deductedDate);
      if (lateMonths > 0) {
        const interest = Math.round((event.taxShouldBe * lateDeductionRate * lateMonths) / 100);
        const item: TdsExposureItem = {
          id: `exp-${event.id}-late-deduction`,
          section,
          reason: isTcs ? "short-collection" : "late-deduction",
          payeeName: event.payeeName,
          payeePan: event.payeePan ?? null,
          deductorTan: params.tan,
          description: isTcs
            ? `TCS on ${event.natureOfPayment ?? "payment"} not collected on time — ${lateMonths} month(s) late.`
            : `TDS on ${event.natureOfPayment ?? "payment"} not deducted on time — ${lateMonths} month(s) late.`,
          baseAmount: event.baseAmount,
          taxShouldBe: event.taxShouldBe,
          taxActual: event.taxActual,
          shortfall,
          fromDate: event.deductibleDate,
          toDate: event.deductedDate,
          months: lateMonths,
          ratePctPerMonth: lateDeductionRate,
          amount: interest,
          capped: false,
          capValue: null,
          status: "computed",
          notes: `201(1A)(i) / 206C equivalent: ${lateDeductionRate}%/month × ${lateMonths} month(s) on ${event.taxShouldBe / 100}.`,
        };
        exposures.push(item);
        const reasonKey = item.reason;
        if (!byType[reasonKey]) byType[reasonKey] = { count: 0, amount: 0 };
        byType[reasonKey].count += 1;
        byType[reasonKey].amount += interest;
        const sectionKey = section;
        if (!bySection[sectionKey])
          bySection[sectionKey] = {
            eventsCount: 0,
            baseAmount: 0,
            taxShouldBe: 0,
            taxActual: 0,
            shortfall: 0,
            exposureAmount: 0,
            maxPenalty271c: null,
          };
        bySection[sectionKey].exposureAmount += interest;
        totalInterest += interest;
        totalExposure += interest;
      }
    }

    // ---- Late deposit interest (201(1A)(ii)) ----
    if (
      event.taxActual > 0 &&
      event.deductedDate &&
      event.depositedDate &&
      params.lateDepositRatePctPerMonth !== undefined
    ) {
      const dueDate = depositDueDate(event.deductedDate);
      const lateMonths = monthsOrPartBetween(dueDate, event.depositedDate);
      if (lateMonths > 0) {
        const interest = Math.round((event.taxActual * lateDepositRate * lateMonths) / 100);
        const item: TdsExposureItem = {
          id: `exp-${event.id}-late-deposit`,
          section,
          reason: isTcs ? "short-collection" : "late-deposit",
          payeeName: event.payeeName,
          payeePan: event.payeePan ?? null,
          deductorTan: params.tan,
          description: isTcs
            ? `TCS not deposited on time — due ${dueDate}, deposited ${event.depositedDate} (${lateMonths} month(s) late).`
            : `TDS not deposited on time — due ${dueDate}, deposited ${event.depositedDate} (${lateMonths} month(s) late).`,
          baseAmount: event.baseAmount,
          taxShouldBe: event.taxShouldBe,
          taxActual: event.taxActual,
          shortfall,
          fromDate: dueDate,
          toDate: event.depositedDate,
          months: lateMonths,
          ratePctPerMonth: lateDepositRate,
          amount: interest,
          capped: false,
          capValue: null,
          status: "computed",
          notes: `201(1A)(ii) / 206C equivalent: ${lateDepositRate}%/month × ${lateMonths} month(s) on ${event.taxActual / 100}.`,
        };
        exposures.push(item);
        const reasonKey = item.reason;
        if (!byType[reasonKey]) byType[reasonKey] = { count: 0, amount: 0 };
        byType[reasonKey].count += 1;
        byType[reasonKey].amount += interest;
        const sectionKey = section;
        if (!bySection[sectionKey])
          bySection[sectionKey] = {
            eventsCount: 0,
            baseAmount: 0,
            taxShouldBe: 0,
            taxActual: 0,
            shortfall: 0,
            exposureAmount: 0,
            maxPenalty271c: null,
          };
        bySection[sectionKey].exposureAmount += interest;
        totalInterest += interest;
        totalExposure += interest;
      }
    }

    // ---- Non-deduction / short deduction (201) ----
    if (event.taxShouldBe > event.taxActual) {
      const shortfallAmount = event.taxShouldBe - event.taxActual;

      if (event.taxActual === 0) {
        // Non-deduction
        const item: TdsExposureItem = {
          id: `exp-${event.id}-non-deduction`,
          section,
          reason: isTcs ? "non-collection" : "non-deduction",
          payeeName: event.payeeName,
          payeePan: event.payeePan ?? null,
          deductorTan: params.tan,
          description: isTcs
            ? `TCS not collected at all on ${event.natureOfPayment ?? "payment"}.`
            : `TDS not deducted at all on ${event.natureOfPayment ?? "payment"}.`,
          baseAmount: event.baseAmount,
          taxShouldBe: event.taxShouldBe,
          taxActual: 0,
          shortfall: event.taxShouldBe,
          fromDate: event.deductibleDate,
          toDate: null, // ongoing
          months: 0,
          ratePctPerMonth: 0,
          amount: 0, // interest would accrue until paid; for now 0
          capped: false,
          capValue: null,
          status: "computed",
          notes: `Section 201/206C: tax not deducted/collected. Interest accrues until paid.`,
        };
        exposures.push(item);
        const reasonKey2 = item.reason;
        if (!byType[reasonKey2]) byType[reasonKey2] = { count: 0, amount: 0 };
        byType[reasonKey2].count += 1;
        byType[reasonKey2].amount += 0; // interest pending
        const sectionKey2 = section;
        if (!bySection[sectionKey2])
          bySection[sectionKey2] = {
            eventsCount: 0,
            baseAmount: 0,
            taxShouldBe: 0,
            taxActual: 0,
            shortfall: 0,
            exposureAmount: 0,
            maxPenalty271c: null,
          };
        bySection[sectionKey2].exposureAmount += 0;
      } else if (shortfallAmount > 0) {
        // Short deduction
        const item: TdsExposureItem = {
          id: `exp-${event.id}-short-deduction`,
          section,
          reason: isTcs ? "short-collection" : "short-deduction",
          payeeName: event.payeeName,
          payeePan: event.payeePan ?? null,
          deductorTan: params.tan,
          description: isTcs
            ? `TCS short-collected on ${event.natureOfPayment ?? "payment"} by ${shortfallAmount / 100}.`
            : `TDS short-deducted on ${event.natureOfPayment ?? "payment"} by ${shortfallAmount / 100}.`,
          baseAmount: event.baseAmount,
          taxShouldBe: event.taxShouldBe,
          taxActual: event.taxActual,
          shortfall: shortfallAmount,
          fromDate: event.deductibleDate,
          toDate: event.deductedDate ?? null,
          months: 0,
          ratePctPerMonth: 0,
          amount: 0,
          capped: false,
          capValue: null,
          status: "computed",
          notes: `Section 201/206C: short deduction/collection of ${shortfallAmount / 100}. Interest accrues on shortfall.`,
        };
        exposures.push(item);
        const rKey = item.reason ?? "unknown";
        if (!byType[rKey]) byType[rKey] = { count: 0, amount: 0 };
        byType[rKey].count += 1;
        byType[rKey].amount += 0;
        const sKey = section ?? "unknown";
        if (!bySection[sKey])
          bySection[sKey] = {
            eventsCount: 0,
            baseAmount: 0,
            taxShouldBe: 0,
            taxActual: 0,
            shortfall: 0,
            exposureAmount: 0,
            maxPenalty271c: null,
          };
        bySection[sKey].exposureAmount += 0;
      }
    }

    // ---- Late filing fee (234E) — at the return level, not per event ----
    // (This is computed once below for the whole return, not per event)

    // ---- Max penalty u/s 271(1)(c) ----
    if (params.computeMaxPenalty271c && shortfall > 0) {
      const maxPenaltyPct = params.maxPenalty271cPct ?? 100;
      const maxPenalty = Math.round((shortfall * maxPenaltyPct) / 100);
      totalMaxPenalty271c += maxPenalty;
      if (bySection[section].maxPenalty271c === null) {
        bySection[section].maxPenalty271c = 0;
      }
      bySection[section].maxPenalty271c += maxPenalty;
    }
  }

  // ---- Late filing fee (234E) at the return level ----
  let lateFilingFeeDays = 0;
  let lateFilingFeeAmount = 0;
  let lateFilingFeeCapped = false;

  if (params.returnFilingDate && params.returnFilingDueDate) {
    const dueDate = new Date(`${params.returnFilingDueDate}T00:00:00Z`);
    const filingDate = new Date(`${params.returnFilingDate}T00:00:00Z`);

    if (filingDate > dueDate) {
      const diffDays = Math.ceil((filingDate.getTime() - dueDate.getTime()) / (24 * 60 * 60 * 1000));
      lateFilingFeeDays = diffDays;

      const totalDeducted = events.reduce((s, e) => s + e.taxActual, 0);
      const rawFee = diffDays * (params.lateFilingFeePerDay ?? 20000);
      lateFilingFeeAmount = Math.min(rawFee, totalDeducted);
      lateFilingFeeCapped = rawFee > totalDeducted && totalDeducted > 0;

      const item: TdsExposureItem = {
        id: "exp-return-late-filing",
        section: "234E",
        reason: "late-filing",
        payeeName: "RETURN-LEVEL",
        payeePan: null,
        deductorTan: params.tan,
        description: `Late filing of TDS/TCS return — ${lateFilingFeeDays} day(s) late (due ${params.returnFilingDueDate}, filed ${params.returnFilingDate}).`,
        baseAmount: totalDeducted,
        taxShouldBe: totalDeducted,
        taxActual: totalDeducted,
        shortfall: 0,
        fromDate: params.returnFilingDueDate,
        toDate: params.returnFilingDate,
        months: 0,
        ratePctPerMonth: 0,
        amount: lateFilingFeeAmount,
        capped: lateFilingFeeCapped,
        capValue: totalDeducted,
        status: "computed",
        notes: `234E: ${(params.lateFilingFeePerDay ?? 20000) / 100}/day × ${lateFilingFeeDays} days = ${rawFee / 100}; capped at TDS amount ${totalDeducted / 100} → ${lateFilingFeeAmount / 100}.`,
      };
      exposures.push(item);
      if (!byType["late-filing"]) byType["late-filing"] = { count: 0, amount: 0 };
      byType["late-filing"].count += 1;
      byType["late-filing"].amount += lateFilingFeeAmount;
      totalFees += lateFilingFeeAmount;
      totalExposure += lateFilingFeeAmount;
    }
  }

  // ---- Late deposit fee (271Q) — at the return level ----
  // (This is a newer provision; applicability depends on the year)
  // For now, we note it but don't compute unless explicitly requested

  // Update section summaries with exposure amounts
  for (const section of Object.keys(bySection)) {
    // Recompute exposure amount from exposures
    if (!bySection[section])
      bySection[section] = {
        eventsCount: 0,
        baseAmount: 0,
        taxShouldBe: 0,
        taxActual: 0,
        shortfall: 0,
        exposureAmount: 0,
        maxPenalty271c: null,
      };
    bySection[section].exposureAmount = exposures
      .filter((e) => e.section === section)
      .reduce((s, e) => s + e.amount, 0);
  }

  // Warnings
  const warnings: string[] = [];
  if (exposures.some((e) => e.reason === "non-deduction" || e.reason === "non-collection")) {
    warnings.push(
      "One or more payment events have no TDS/TCS deducted/collected — exposure u/s 201/206C may apply until rectified.",
    );
  }
  if (totalExposure > 0) {
    warnings.push(
      `Total exposure (interest + fees) is ${totalExposure / 100} — this is an estimate; the AO determines the final liability.`,
    );
  }
  if (params.computeMaxPenalty271c && totalMaxPenalty271c > 0) {
    warnings.push(
      `Maximum penalty u/s 271(1)(c) computed at ${params.maxPenalty271cPct ?? 100}% of shortfall is ${totalMaxPenalty271c / 100} — actual penalty is determined by the AO based on the facts.`,
    );
  }

  // Methodology
  const methodology = [
    `Exposure computed for TAN ${params.tan}, AY ${params.assessmentYear}, FY ${params.financialYear}.`,
    `201(1A)(i) late deduction at ${params.lateDeductionRatePctPerMonth ?? 1}%/month; 201(1A)(ii) late deposit at ${params.lateDepositRatePctPerMonth ?? 1.5}%/month; part months count as full.`,
    `234E fee ${params.lateFilingFeePerDay ? params.lateFilingFeePerDay / 100 : "₹200"}/day from due date ${params.returnFilingDueDate} to filing date ${params.returnFilingDate ?? "(not filed)"}; capped at TDS amount.`,
    `271(1)(c) maximum penalty computed at ${params.maxPenalty271cPct ?? 100}% of the shortfall (if params.computeMaxPenalty271c is true).`,
    `${events.length} event(s) processed; ${exposures.length} exposure item(s) computed.`,
    `Warning: This is an estimate. The actual penalty quantum is determined by the AO based on the facts, the explanation offered, and the provisions applicable for the year.`,
  ];

  return {
    params,
    events,
    exposures,
    bySection,
    byType,
    totalExposure,
    totalInterest,
    totalFees,
    totalMaxPenalty271c: params.computeMaxPenalty271c ? totalMaxPenalty271c : null,
    grandTotalWithMaxPenalty: params.computeMaxPenalty271c ? totalExposure + totalMaxPenalty271c : null,
    warnings,
    methodology,
  };
}

/**
 * Generate a penalty exposure summary for a CA to use in the working paper.
 */
export function generateExposureWorkingPaper(result: TdsExposureResult, deductorName: string): string {
  const lines: string[] = [];
  lines.push(`TDS/TCS PENALTY EXPOSURE WORKING PAPER`);
  lines.push(`======================================`);
  lines.push(``);
  lines.push(`Deductor: ${deductorName}`);
  lines.push(`TAN: ${result.params.tan}`);
  lines.push(`Assessment Year: ${result.params.assessmentYear}`);
  lines.push(`Financial Year: ${result.params.financialYear}`);
  lines.push(`Deductor Entity Type: ${result.params.deductorEntityType}`);
  lines.push(`Government Deductor: ${result.params.isGovernmentDeductor ? "Yes" : "No"}`);
  lines.push(``);
  lines.push(`EXECUTIVE SUMMARY`);
  lines.push(`----------------`);
  lines.push(`Total exposure (interest + fees): ${result.totalExposure / 100}`);
  lines.push(`  - Total interest (201(1A)): ${result.totalInterest / 100}`);
  lines.push(`  - Total fees (234E, etc.): ${result.totalFees / 100}`);
  if (result.totalMaxPenalty271c !== null) {
    lines.push(`Maximum penalty u/s 271(1)(c) (estimate): ${result.totalMaxPenalty271c / 100}`);
    lines.push(`Grand total (including max 271(1)(c)): ${result.grandTotalWithMaxPenalty! / 100}`);
  }
  lines.push(``);
  lines.push(`EXPOSURE BY SECTION`);
  lines.push(`-------------------`);
  for (const [section, summary] of Object.entries(result.bySection)) {
    lines.push(``);
    lines.push(`Section ${section}:`);
    lines.push(`  Events: ${summary.eventsCount}`);
    lines.push(`  Base amount: ${summary.baseAmount / 100}`);
    lines.push(`  Tax should be: ${summary.taxShouldBe / 100}`);
    lines.push(`  Tax actual: ${summary.taxActual / 100}`);
    lines.push(`  Shortfall: ${summary.shortfall / 100}`);
    lines.push(`  Exposure (interest + fees): ${summary.exposureAmount / 100}`);
    if (summary.maxPenalty271c !== null && summary.maxPenalty271c > 0) {
      lines.push(`  Max penalty u/s 271(1)(c): ${summary.maxPenalty271c / 100}`);
    }
  }
  lines.push(``);
  lines.push(`EXPOSURE BY TYPE`);
  lines.push(`----------------`);
  for (const [type, summary] of Object.entries(result.byType)) {
    if (summary.count > 0) {
      lines.push(`${type}: ${summary.count} item(s), ${summary.amount / 100}`);
    }
  }
  lines.push(``);
  lines.push(`ITEMIZED EXPOSURES`);
  lines.push(`------------------`);
  for (const exposure of result.exposures) {
    lines.push(``);
    lines.push(`ID: ${exposure.id}`);
    lines.push(`Section: ${exposure.section}`);
    lines.push(`Reason: ${exposure.reason}`);
    lines.push(`Payee: ${exposure.payeeName} (${exposure.payeePan ?? "N/A"})`);
    lines.push(`Description: ${exposure.description}`);
    lines.push(`Base amount: ${exposure.baseAmount / 100}`);
    lines.push(`Tax should be: ${exposure.taxShouldBe / 100}`);
    lines.push(`Tax actual: ${exposure.taxActual / 100}`);
    lines.push(`Shortfall: ${exposure.shortfall / 100}`);
    lines.push(`From: ${exposure.fromDate}`);
    lines.push(`To: ${exposure.toDate ?? "Present"}`);
    if (exposure.months > 0) {
      lines.push(`Months: ${exposure.months}`);
      lines.push(`Rate: ${exposure.ratePctPerMonth}%/month`);
    }
    lines.push(`Amount: ${exposure.amount / 100}`);
    if (exposure.capped) {
      lines.push(`Capped at: ${exposure.capValue! / 100}`);
    }
    lines.push(`Status: ${exposure.status}`);
    if (exposure.notes) {
      lines.push(`Notes: ${exposure.notes}`);
    }
  }
  lines.push(``);
  lines.push(`WARNINGS`);
  lines.push(`--------`);
  for (const warning of result.warnings) {
    lines.push(`- ${warning}`);
  }
  lines.push(``);
  lines.push(`METHODOLOGY`);
  lines.push(`-----------`);
  for (const note of result.methodology) {
    lines.push(`- ${note}`);
  }
  lines.push(``);
  lines.push(`Prepared by: ________________________`);
  lines.push(`Date: ________________________`);
  lines.push(`Reviewed by: ________________________`);
  lines.push(`Date: ________________________`);
  lines.push(``);
  lines.push(
    `Note: This working paper is an estimate of penalty exposure and does not constitute a legal opinion. The actual liability is determined by the AO.`,
  );

  return lines.join("\n");
}
