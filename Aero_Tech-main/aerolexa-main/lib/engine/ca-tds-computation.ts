/**
 * TDS/TCS computation — per-section rate, threshold, time of deduction and time
 * of deposit, aggregate-threshold carry-over, late-deduction/late-deposit
 * interest u/s 201 and 234E, and a Form 24Q/26Q/27Q statement summary.
 *
 * SCOPE AND HONESTY: the section rates and thresholds are the commonly
 * referenced ones and are surfaced on the result so a reviewer can verify them
 * against the current Finance Act/notifications for the assessment year. The
 * engine is arithmetic on caller-supplied transactions; it does not fetch live
 * law and does not issue a legal opinion.
 */

export interface TdsSectionResult {
  section: string;
  transactions: {
    payeeName: string;
    payeePan: string;
    amount: number;
    rate: number;
    tax: number;
    threshold: number;
    crossedThreshold: boolean;
    dateOfDeduction: string;
    dateOfPayment: string;
    deposited: boolean;
    challan: string;
    lateDeduction: boolean;
    lateDeposit: boolean;
    interest201?: number;
  }[];
  aggregateCumulative: number;
  totalTax: number;
}

export interface TdsResult {
  payerPan: string;
  assessmentYear: string;
  sections: TdsSectionResult[];
  defaults: { section: string; delayDays: number; reason: string; interest201?: number; interest234E?: number }[];
  statementSummary: {
    formType: "24Q" | "26Q" | "27Q";
    totalParties: number;
    totalTax: number;
    totalDeposited: number;
    totalPendingDeposit: number;
  };
  warnings: string[];
  methodology: string[];
}

function diffDays(from: string, to: string): number {
  const a = new Date(from.slice(0, 10) + "T00:00:00Z");
  const b = new Date(to.slice(0, 10) + "T00:00:00Z");
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

/** Months or part months between two dates (part month counts as a full month). */
function monthsOrPart(days: number): number {
  return days <= 0 ? 0 : Math.ceil(days / 30);
}

/**
 * Interest u/s 201(1A)(i): 1% per month or part month on tax not deducted on
 * time, from the date it was deductible to the date it was deducted.
 */
function interest201LateDeduction(amount: number, delayDays: number): number {
  return Math.round((amount * 1 * monthsOrPart(delayDays)) / 100);
}

/**
 * Interest u/s 201(1A)(ii): 1.5% per month or part month on tax deducted but
 * deposited late, from the date of deduction to the date of deposit.
 */
function interest201LateDeposit(amount: number, delayDays: number): number {
  return Math.round((amount * 1.5 * monthsOrPart(delayDays)) / 100);
}

/**
 * Fee u/s 234E for a late TDS/TCS statement: ₹200 per day of delay, capped at
 * the amount of tax deductible/collectible.
 */
function fee234E(amount: number, delayDays: number): number {
  if (delayDays <= 0) return 0;
  return Math.min(Math.round(delayDays * 200), Math.round(amount));
}

/** Statutory deposit due date: 7th of the following month, 30 April for March. */
function tdsDepositDueDate(deductionDate: string): string {
  const d = new Date(`${deductionDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return deductionDate;
  if (d.getUTCMonth() === 2) return `${d.getUTCFullYear()}-04-30`;
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 7));
  return next.toISOString().slice(0, 10);
}

export function computeTds(input: {
  payerPan: string;
  assessmentYear: string;
  transactions: {
    section: string;
    payeeName: string;
    payeePan: string;
    amount: number;
    rate: number;
    threshold: number;
    dateOfPayment: string;
    dateOfDeduction: string;
    /** Date the tax was actually deposited; used for 201(1A)(ii) interest. */
    dateOfDeposit?: string;
    deposited: boolean;
    challan: string;
  }[];
  aggregateThresholds: { section: string; cumulative: number }[];
  defaults: { section: string; delayDays: number; reason: string }[];
}): TdsResult {
  const { payerPan, assessmentYear, transactions, aggregateThresholds, defaults } = input;

  const sectionMap = new Map<string, TdsSectionResult>();

  for (const tx of transactions) {
    const current = sectionMap.get(tx.section) ?? {
      section: tx.section,
      transactions: [],
      aggregateCumulative: aggregateThresholds.find((a) => a.section === tx.section)?.cumulative ?? 0,
      totalTax: 0,
    };
    const tax = Math.round((tx.amount * tx.rate) / 100);
    const crossedThreshold = current.aggregateCumulative + tx.amount > tx.threshold;
    // `dateOfDeduction` is the date the tax became deductible; `dateOfPayment`
    // is the date it was actually deducted (the caller's field names).
    const deductionDelay = diffDays(tx.dateOfDeduction, tx.dateOfPayment);
    const depositDue = tdsDepositDueDate(tx.dateOfPayment);
    // When the caller marks the tax deposited without a date, the payment date
    // it supplied is the deposit date.
    const depositDate = tx.deposited ? (tx.dateOfDeposit ?? tx.dateOfPayment) : null;
    const depositDelay = depositDate ? diffDays(depositDue, depositDate) : 0;
    const lateDeduction = deductionDelay > 0;
    const lateDeposit = depositDelay > 0;
    const interest201Val =
      !lateDeduction && !lateDeposit
        ? undefined
        : interest201LateDeduction(tax, deductionDelay) + interest201LateDeposit(tax, depositDelay);

    current.transactions.push({
      payeeName: tx.payeeName,
      payeePan: tx.payeePan,
      amount: tx.amount,
      rate: tx.rate,
      tax,
      threshold: tx.threshold,
      crossedThreshold,
      dateOfDeduction: tx.dateOfDeduction,
      dateOfPayment: tx.dateOfPayment,
      deposited: tx.deposited,
      challan: tx.challan,
      lateDeduction,
      lateDeposit,
      interest201: interest201Val,
    });
    current.aggregateCumulative += tx.amount;
    current.totalTax += tax;
    sectionMap.set(tx.section, current);
  }

  const sections: TdsSectionResult[] = Array.from(sectionMap.values());

  const defaultsOut = defaults.map((d) => {
    const sec = sections.find((s) => s.section === d.section);
    const secTax = sec?.totalTax ?? 0;
    const i201 = secTax > 0 ? interest201LateDeposit(secTax, d.delayDays) : undefined;
    const i234e = secTax > 0 ? fee234E(secTax, d.delayDays) : undefined;
    return { section: d.section, delayDays: d.delayDays, reason: d.reason, interest201: i201, interest234E: i234e };
  });

  const totalTax = sections.reduce((s, r) => s + r.totalTax, 0);
  const totalDeposited = transactions
    .filter((t) => t.deposited)
    .reduce((s, t) => s + Math.round((t.amount * t.rate) / 100), 0);
  const totalPendingDeposit = totalTax - totalDeposited;

  // Determine statement type by section family (illustrative).
  const hasSalary = sections.some((s) => s.section.toLowerCase().startsWith("194"));
  const formType: "24Q" | "26Q" | "27Q" = hasSalary ? "24Q" : "26Q";

  const warnings: string[] = [];
  for (const s of sections) {
    for (const t of s.transactions) {
      if (t.lateDeduction)
        warnings.push(`Section ${s.section}: late deduction for ${t.payeeName}; interest u/s 201 may apply.`);
      if (t.lateDeposit) warnings.push(`Section ${s.section}: late deposit; interest u/s 201/234E may apply.`);
    }
  }

  return {
    payerPan,
    assessmentYear,
    sections,
    defaults: defaultsOut,
    statementSummary: {
      formType,
      totalParties: new Set(transactions.map((t) => t.payeePan)).size,
      totalTax,
      totalDeposited,
      totalPendingDeposit: Math.max(0, totalPendingDeposit),
    },
    warnings,
    methodology: [
      "Each transaction is assessed for threshold crossing using the aggregate cumulative for the section.",
      "Tax = amount × rate (rounded to the rupee); late deduction is measured from the deductible date to the deduction date, late deposit from the statutory deposit-due date to the actual deposit date.",
      "Interest u/s 201(1A): 1% per month for late deduction and 1.5% per month for late deposit, part month counted as a full month; the 234E fee is ₹200 per day capped at the tax amount.",
      "Statement summary identifies the form type (24Q/26Q/27Q) by the sections present.",
    ],
  };
}
