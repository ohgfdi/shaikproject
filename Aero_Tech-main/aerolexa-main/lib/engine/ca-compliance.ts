/**
 * Compliance calendar + tax audit engine - the deadlines a CA firm tracks for
 * every client and the audit-threshold tests u/s 44AB (audit of businesses)
 * and 44ADA (presumptive taxation for professionals).
 *
 * The engine does not read the portal, does not file returns, and does not
 * fetch live rate tables. Turnover, cash-book limits and professional receipts
 * are caller-supplied DATA - the thresholds are labelled with the assessment
 * year they apply to, so a Finance Act change is the caller's to own.
 *
 * Money is in MINOR UNITS (paise) as integers, matching the rest of the CA
 * engines. Dates are ISO yyyy-mm-dd.
 */

export class ComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceError";
  }
}

// ---------------------------------------------------------------------------
// Thresholds (labelled defaults - caller overrides)
// ---------------------------------------------------------------------------

/** A turnover / receipt threshold that applies from a given assessment year. */
export interface Threshold {
  /** Assessment year the threshold takes effect, e.g. "2025-26". */
  fromAy: string;
  /** Turnover/receipt limit in minor units. */
  limitMinor: number;
  /** Cash-component limit (u/s 44AB(a)) in minor units; 0 = not applicable. */
  cashLimitMinor?: number;
}

/** Auditable turnover/receipt thresholds for businesses (u/s 44AB).
 *
 * The defaulter thresholds below are labelled for AY 2025-26 and reflect the
 * cash-receipt limit of ₹10 crore (5% cash). Override per the client's AY.
 */
export const DEFAULT_44AB_THRESHOLDS: readonly Threshold[] = [
  { fromAy: "2025-26", limitMinor: 100_00_00_000, cashLimitMinor: 50_00_00_000 }, // ₹10 crore total, ₹5 crore cash
  { fromAy: "2021-22", limitMinor: 100_00_00_000, cashLimitMinor: 50_00_00_000 },
  { fromAy: "2019-20", limitMinor: 500_00_00_000, cashLimitMinor: 50_00_00_000 }, // ₹5 crore total, ₹2.5 crore cash (pre-amendment)
];

/** Presumptive taxation threshold for professionals u/s 44ADA.
 *
 * ₹75 lakh (now ₹50 lakh unless 95% receipts are through banking channels),
 * labelled for AY 2025-26. Override per the client's AY.
 */
export const DEFAULT_44ADA_THRESHOLD: { fromAy: string; limitMinor: number } | null = {
  fromAy: "2025-26",
  limitMinor: 75_00_00_000,
};

/** Presumptive turnover threshold for businesses u/s 44AD.
 *
 * ₹3 crore (now ₹2 crore unless 95% receipts through banking), labelled AY 2025-26.
 */
export const DEFAULT_44AD_THRESHOLD: { fromAy: string; limitMinor: number } | null = {
  fromAy: "2025-26",
  limitMinor: 300_00_00_000,
};

// ---------------------------------------------------------------------------
// Filing due dates (labelled - the caller overrides for special categories)
// ---------------------------------------------------------------------------

/** A statutory filing deadline for one return / statement / audit report. */
export interface FilingDeadline {
  /** What is due. */
  description: string;
  /** The entity type this deadline applies to, e.g. "individual", "company", "gtr-recipient". */
  appliesTo: string;
  dueDate: string; // yyyy-mm-dd
  /** Whether the deadline is extended by a surcharge if filed late (the engine does not compute the surcharge - that is the tax engine's job). */
  lateFeeApplicable: boolean;
  /** Short note for the reviewer. */
  note?: string;
}

/** Standard filing calendar for a financial year. The caller may override any entry.
 *
 * Defaults are labelled for a generic AY; companies, GSTR recipients, TDS deductors
 * and TDS/TCS PAYEES each have their own due-date schedule, which the caller supplies
 * when it differs from the defaults.
 */
export function defaultFilingCalendar(fy: string): FilingDeadline[] {
  const startYear = Number(fy.slice(0, 4));
  if (!Number.isFinite(startYear) || !/^\d{4}-\d{2}$/.test(fy)) {
    throw new ComplianceError(`fy must look like "2025-26"; got "${fy}".`);
  }
  return [
    {
      description: "TDS/TCS return (Form 24Q/26Q/27Q) - Q1 (Apr-Jun)",
      appliesTo: "tds-deductor",
      dueDate: `${startYear}-07-15`,
      lateFeeApplicable: true,
      note: "Due 15 Jul following the quarter; deposit by 7th of the following month.",
    },
    {
      description: "TDS/TCS return (Form 24Q/26Q/27Q) - Q2 (Jul-Sep)",
      appliesTo: "tds-deductor",
      dueDate: `${startYear}-10-15`,
      lateFeeApplicable: true,
    },
    {
      description: "TDS/TCS return (Form 24Q/26Q/27Q) - Q3 (Oct-Dec)",
      appliesTo: "tds-deductor",
      dueDate: `${startYear + 1}-01-15`,
      lateFeeApplicable: true,
    },
    {
      description: "TDS/TCS return (Form 24Q/26Q/27Q) - Q4 (Jan-Mar) + reconciliation",
      appliesTo: "tds-deductor",
      dueDate: `${startYear + 1}-05-31`,
      lateFeeApplicable: true,
      note: "Q4 return due 31 May following the FY end (30 Apr deposit for March deductions).",
    },
    {
      description: "Advance tax (self-assessment) - final installment",
      appliesTo: "individual",
      dueDate: `${startYear + 1}-03-15`,
      lateFeeApplicable: true,
      note: "100% of advance tax by 15 March; interest u/s 234B/234C runs from 1 April.",
    },
    {
      description: "GSTR-1 (outward supplies) - annual return",
      appliesTo: "gtr-registered",
      dueDate: `${startYear + 1}-12-31`,
      lateFeeApplicable: true,
      note: "GSTR-9 annual return due 31 December of the year following the FY.",
    },
    {
      description: "GSTR-9C (reconciliation statement)",
      appliesTo: "gtr-registered-turnover-above-2crore",
      dueDate: `${startYear + 1}-12-31`,
      lateFeeApplicable: true,
      note: "Applicable when aggregate turnover exceeds ₹2 crore (composition dealers excluded).",
    },
    {
      description: "Income-tax return (ITR) - individual / HUF (not audit-required)",
      appliesTo: "individual-no-audit",
      dueDate: `${startYear + 1}-07-31`,
      lateFeeApplicable: true,
      note: "Extended to 31 December only for notified categories; audit-required returns are due 31 October.",
    },
    {
      description: "Income-tax return (ITR) - audit required (business/profession above threshold)",
      appliesTo: "audit-required",
      dueDate: `${startYear + 1}-10-31`,
      lateFeeApplicable: true,
      note: "Due 31 October following the FY end when books are audited u/s 44AB or 44ADA.",
    },
    {
      description: "Income-tax return (ITR) - company",
      appliesTo: "company",
      dueDate: `${startYear + 1}-10-31`,
      lateFeeApplicable: true,
    },
    {
      description: "Audit report (Form 3CD) - tax audit u/s 44AB",
      appliesTo: "audit-required",
      dueDate: `${startYear + 1}-09-30`,
      lateFeeApplicable: true,
      note: "Audit report due 30 September following the FY end; the return follows 31 October.",
    },
    {
      description: "ROC annual filing (AOC-4 + MGT-7) - company",
      appliesTo: "company",
      dueDate: `${startYear + 1}-10-31`,
      lateFeeApplicable: true,
      note: "Financial statements (AOC-4) and annual return (MGT-7) due 31 October.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Tax audit thresholds (44AB / 44ADA / 44AD)
// ---------------------------------------------------------------------------

/** The audit determination for one client. */
export interface AuditDetermination {
  ay: string;
  regime: "44AB-business" | "44ADA-professional" | "44AD-business-presumptive";
  turnoverMinor: number;
  receiptsMinor: number; // gross receipts for 44ADA; turnover for 44AB
  cashReceiptsMinor: number; // cash component (44AB(a) test)
  /** The threshold that applies to this AY. */
  threshold: Threshold; // 44AB uses the business threshold; 44ADA uses a single threshold
  /** Whether the entity crosses the aggregate turnover / receipts limit. */
  exceedsLimit: boolean;
  /** Whether the cash component crosses the cash threshold (44AB(a) only). */
  exceedsCashLimit: boolean | null; // null for 44ADA
  /** Result the CA uses to decide whether to conduct / report an audit. */
  auditRequired: boolean;
  /** Conditions the CA must verify before relying on the determination. */
  conditions: string[];
  methodology: string[];
}

/** Find the threshold that applies to a given assessment year. */
function thresholdFor(thresholds: readonly Threshold[], ay: string): Threshold {
  const applicable = thresholds.filter((t) => t.fromAy <= ay);
  if (applicable.length === 0) throw new ComplianceError(`No threshold found for AY ${ay} in the supplied table.`);
  return applicable.reduce((best, t) => (t.fromAy > best.fromAy ? t : best));
}

/**
 * Determine whether a business requires a tax audit u/s 44AB for a given AY.
 *
 * The rule: audit is required when aggregate turnover/receipts exceed the
 * threshold for the AY, OR when cash receipts exceed the cash limit (44AB(a)).
 * Both tests are evaluated against the caller-supplied figures.
 */
export function auditRequired44AB(opts: {
  ay: string;
  turnoverMinor: number;
  cashReceiptsMinor: number;
  thresholds?: readonly Threshold[];
}): AuditDetermination {
  const thresholds = opts.thresholds ?? DEFAULT_44AB_THRESHOLDS;
  const threshold = thresholdFor(thresholds, opts.ay);
  const exceedsLimit = opts.turnoverMinor > threshold.limitMinor;
  const exceedsCashLimit = opts.cashReceiptsMinor > (threshold.cashLimitMinor ?? Infinity);

  const conditions: string[] = [
    `Aggregate turnover/receipts for AY ${opts.ay}: ${opts.turnoverMinor} (threshold ${threshold.limitMinor}).`,
    `Cash receipts for AY ${opts.ay}: ${opts.cashReceiptsMinor}${threshold.cashLimitMinor ? ` (cash limit ${threshold.cashLimitMinor})` : " (no cash test applicable)"}.`,
    "The determination is based on the figures supplied by the caller; the CA must verify against the audited / unaudited books before signing the audit report.",
    "Turnover includes all business income (sales, services, export, inter-state and intra-state supplies) - confirm the scope with the client.",
    "Excluded from the 44AB limit: advances against which no supply was made, and money received in a financial year that does not relate to that FY's turnover (confirm applicability).",
  ];

  if (exceedsCashLimit && exceedsLimit) {
    conditions.push(
      `Both the aggregate-turnover limit (${threshold.limitMinor}) and the cash-receipt limit (${threshold.cashLimitMinor}) are exceeded - audit is required on both grounds.`,
    );
  } else if (exceedsLimit) {
    conditions.push(`Aggregate turnover/receipts exceed the threshold - audit required u/s 44AB.`);
  } else if (exceedsCashLimit) {
    conditions.push(
      `Cash receipts exceed the cash limit - audit required u/s 44AB(a) even though aggregate turnover is within the limit.`,
    );
  } else {
    conditions.push(
      `Aggregate turnover/receipts and cash receipts are both within the thresholds for AY ${opts.ay} - audit is not required under 44AB.`,
    );
  }

  return {
    ay: opts.ay,
    regime: "44AB-business",
    turnoverMinor: opts.turnoverMinor,
    receiptsMinor: opts.turnoverMinor,
    cashReceiptsMinor: opts.cashReceiptsMinor,
    threshold,
    exceedsLimit,
    exceedsCashLimit,
    auditRequired: exceedsLimit || exceedsCashLimit,
    conditions,
    methodology: [
      `44AB determination for AY ${opts.ay}: aggregate turnover ${opts.turnoverMinor} vs threshold ${threshold.limitMinor}; cash receipts ${opts.cashReceiptsMinor} vs cash limit ${threshold.cashLimitMinor ?? "n/a"}.`,
      `Audit required: ${opts.turnoverMinor > threshold.limitMinor || (threshold.cashLimitMinor ? opts.cashReceiptsMinor > threshold.cashLimitMinor : false) ? "yes" : "no"}.`,
    ],
  };
}

/**
 * Determine whether a professional requires audit u/s 44ADA for a given AY.
 *
 * The rule: audit is required when gross receipts exceed the threshold for the AY.
 * 44ADA also requires the assessee to maintain books if income is claimed below
 * the presumptive slab - that condition is flagged here.
 */
export function auditRequired44ADA(opts: {
  ay: string;
  grossReceiptsMinor: number;
  bankingChannelPct: number; // 0-100; 95%+ banking unlocks the higher limit in law
  thresholds?: { fromAy: string; limitMinor: number }[];
}): AuditDetermination {
  const table = opts.thresholds ?? [DEFAULT_44ADA_THRESHOLD!];
  const t = thresholdFor(table as unknown as readonly Threshold[], opts.ay) as Threshold;
  const limit = t.limitMinor;
  const exceedsLimit = opts.grossReceiptsMinor > limit;

  // 44ADA: the higher threshold (₹75L) is available only when 95%+ receipts
  // are through banking channels; otherwise the older ₹50L limit applies.
  // The caller supplies the banking-channel percentage; the engine does not
  // fetch it.
  const bankingEligible = opts.bankingChannelPct >= 95 && limit >= 75_00_00_000;
  const effectiveLimit = bankingEligible ? 75_00_00_000 : 50_00_00_000;
  const exceedsEffectiveLimit = opts.grossReceiptsMinor > effectiveLimit;

  const conditions: string[] = [
    `Gross receipts for AY ${opts.ay}: ${opts.grossReceiptsMinor} (limit ${limit}).`,
    `Banking-channel receipts: ${opts.bankingChannelPct}% - ${bankingEligible ? "95%+ banking qualifies for the ₹75L limit" : "below 95% banking - ₹50L limit applies"}.`,
    `Effective threshold: ₹${effectiveLimit / 100} lakh - audit ${exceedsEffectiveLimit ? "required" : "not required"}.`,
    "If the assessee claims presumptive income below 50% of receipts (business) / 60% (profession), books must be maintained and audited - confirm the declaration.",
    "The determination is based on the figures supplied by the caller; the CA must verify against the books before signing.",
  ];

  return {
    ay: opts.ay,
    regime: "44ADA-professional",
    turnoverMinor: opts.grossReceiptsMinor,
    receiptsMinor: opts.grossReceiptsMinor,
    cashReceiptsMinor: 0,
    threshold: { fromAy: opts.ay, limitMinor: limit, cashLimitMinor: 0 },
    exceedsLimit: exceedsLimit,
    exceedsCashLimit: null,
    auditRequired: exceedsEffectiveLimit,
    conditions,
    methodology: [
      `44ADA determination for AY ${opts.ay}: gross receipts ${opts.grossReceiptsMinor}; banking ${opts.bankingChannelPct}% → effective limit ₹${effectiveLimit / 100} lakh; audit ${exceedsEffectiveLimit ? "required" : "not required"}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Compliance status for a client
// ---------------------------------------------------------------------------

/** The compliance posture for one client in one financial year. */
export interface ComplianceStatus {
  clientName: string;
  fy: string;
  ay: string;
  entityType: string; // "individual", "company", "gtr-registered", "tds-deductor", …
  calendar: FilingDeadline[];
  /** Overdue deadlines (date before today's date) - the engine does not know today's date, so the caller flags them. */
  overdue: FilingDeadline[];
  /** Deadlines falling within the next 30 days of a caller-supplied reference date. */
  upcoming: FilingDeadline[];
  /** Tax-audit determination for the entity, if applicable. */
  auditDetermination: AuditDetermination | null;
  warnings: string[];
  methodology: string[];
}

/**
 * Build the compliance posture for a client.
 *
 * The caller supplies the reference date (today's date in the CA's timezone) so
 * the engine can flag overdue and upcoming items without depending on the system
 * clock - which keeps the computation deterministic and reproducible.
 */
export function complianceStatus(opts: {
  clientName: string;
  fy: string;
  entityType: string;
  /** ISO date the CA is running the check from (e.g. "2026-10-06"). */
  referenceDate: string;
  /** Optional: override the default calendar with client-specific deadlines. */
  calendar?: FilingDeadline[];
  /** Optional: tax-audit determination (44AB / 44ADA / 44AD) if the entity is auditable. */
  auditDetermination?: AuditDetermination | null;
}): ComplianceStatus {
  const fyStartYear = Number(opts.fy.slice(0, 4));
  if (!Number.isFinite(fyStartYear) || !/^\d{4}-\d{2}$/.test(opts.fy)) {
    throw new ComplianceError(`fy must look like "2025-26"; got "${opts.fy}".`);
  }
  const ay = `${fyStartYear + 1}-${String(fyStartYear + 1).slice(2)}`;
  const calendar = opts.calendar ?? defaultFilingCalendar(opts.fy);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.referenceDate)) {
    throw new ComplianceError(`referenceDate must be yyyy-mm-dd (got "${opts.referenceDate}").`);
  }

  const refMs = new Date(`${opts.referenceDate}T00:00:00Z`).getTime();
  const dayMs = 86_400_000;

  const overdue: FilingDeadline[] = [];
  const upcoming: FilingDeadline[] = [];
  for (const d of calendar) {
    const dueMs = new Date(`${d.dueDate}T00:00:00Z`).getTime();
    if (dueMs < refMs) {
      overdue.push(d);
    } else if (dueMs - refMs <= 30 * dayMs) {
      upcoming.push(d);
    }
  }

  const warnings: string[] = [];
  for (const d of overdue) {
    warnings.push(`${d.description} was due ${d.dueDate} - late fee u/s applicable; confirm the filing status.`);
  }
  for (const d of upcoming) {
    warnings.push(`${d.description} is due ${d.dueDate} - action required within 30 days of ${opts.referenceDate}.`);
  }

  if (opts.auditDetermination) {
    warnings.push(
      `Tax audit u/s ${opts.auditDetermination.regime}: ${opts.auditDetermination.auditRequired ? "required - plan the audit and Form 3CD" : "not required for this AY"}.`,
    );
  }

  return {
    clientName: opts.clientName,
    fy: opts.fy,
    ay,
    entityType: opts.entityType,
    calendar,
    overdue,
    upcoming,
    auditDetermination: opts.auditDetermination ?? null,
    warnings,
    methodology: [
      `Compliance calendar for FY ${opts.fy} (AY ${ay}), entity type "${opts.entityType}", checked as at ${opts.referenceDate}.`,
      `Overdue: ${overdue.length} deadline(s); upcoming (within 30 days): ${upcoming.length} deadline(s).`,
      opts.auditDetermination
        ? `Tax audit determination: ${opts.auditDetermination.regime} - ${opts.auditDetermination.auditRequired ? "required" : "not required"}.`
        : "No tax-audit determination supplied.",
    ],
  };
}
