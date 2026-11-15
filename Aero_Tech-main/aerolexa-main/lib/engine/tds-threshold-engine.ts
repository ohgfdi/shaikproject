/**
 * TDS Threshold Tracking & Time-of-Deduction Engine.
 *
 * This module implements the core CA-practice logic a client pays for:
 *   - aggregate-threshold carry-over across a financial year (194C ₹1L annual,
 *     194J ₹30k per-payment, 194I ₹2.4L annual, 194Q ₹50L annual, 194R ₹20k
 *     annual, 194-IA ₹50L per-transaction, 194-IB/194-IR ₹50k per month, etc.)
 *   - time-of-deduction: "earlier of date-of-payment and date-of-credit" with
 *     the early-deduction / earlier-credit ordering that decides when the tax
 *     became deductible
 *   - date-of-deduction vs date-of-payment ordering (a CA working paper must
 *     show which date drove the deduction, because that date feeds 201(1A)
 *     interest and the deposit-due-date clock)
 *   - early-deduction/earlier-credit logic: when credit is given before payment,
 *     TDS is due on credit; when payment is before credit, TDS is due on payment;
 *     this engine records both dates and the effective deductible date
 *
 * SCOPE AND HONESTY: this is arithmetic on caller-supplied dates and thresholds.
 * It does not fetch live law and does not issue a legal opinion. Finance Act
 * changes to thresholds and the "earlier of" rule for a given section are the
 * caller's to own.
 *
 * All amounts are in MINOR UNITS (paise) as integers.
 */

/** A payment event that may attract TDS. */
export interface TdsPaymentEvent {
  /** Stable id for the event within a book/fiscal year. */
  id: string;
  /** Section code, e.g. "194C". */
  section: string;
  /** Deductee PAN. */
  deducteePan: string;
  /** Deductee name. */
  deducteeName: string;
  /** Deductee type: company | firm | individual | huf | other | non-resident. */
  deducteeType: string;
  /** Amount on which TDS is to be computed, minor units. */
  amount: number;
  /** Date of payment (yyyy-mm-dd). */
  dateOfPayment: string;
  /** Date of credit (yyyy-mm-dd) — the date the payment was booked/credited. */
  dateOfCredit: string;
  /** Whether the payment has actually been made, or is only accrued/credited. */
  isPaid: boolean;
  /** Whether the deductee has a valid PAN. */
  hasPan: boolean;
  /** Whether the deductee is a non-resident. */
  isNonResident: boolean;
  /** Optional: lower deduction certificate reference if applicable. */
  ldcReference?: string | null;
  /** Optional: Form 15G/15H reference if submitted. */
  form15G_15HReference?: string | null;
  /** Optional: nature of payment descriptor. */
  natureOfPayment?: string | null;
  /** Optional: voucher reference. */
  voucherId?: string | null;
}

/** Outcome of threshold + time-of-deduction evaluation for one event. */
export interface TdsThresholdOutcome {
  eventId: string;
  section: string;
  deducteePan: string;
  amount: number;
  /** The effective date on which TDS became due (earlier of payment/credit). */
  effectiveDeductibleDate: string;
  /** Which date drove the deduction: "payment" | "credit" | "same". */
  deductibleDateSource: "payment" | "credit" | "same";
  /** Whether the section threshold is crossed (considering carry-over). */
  thresholdCrossed: boolean;
  /** Running cumulative after this event, minor units. */
  cumulativeAfter: number;
  /** Threshold for the section (caller-supplied). */
  threshold: number;
  /** Whether TDS is actually deductible on this event. */
  tdsApplicable: boolean;
  /** Why TDS may not apply (if any). */
  reasonIfNotApplicable: string | null;
  /** If PAN is missing and the section requires it, the higher Rate may apply. */
  panMissingConsequence: string | null;
  /** Carry-over before this event, minor units. */
  carryOverBefore: number;
  /** Whether this is the first event in the financial year for this section+deductee. */
  isFirstInYear: boolean;
}

/** Aggregate threshold state for one section (optionally per deductee PAN). */
export interface ThresholdState {
  section: string;
  /** PAN-scoped state key: empty = section-wide aggregate; otherwise PAN. */
  deducteePan: string;
  /** Running cumulative for the financial year so far, minor units. */
  cumulative: number;
  /** The annual/monthly threshold for this section (caller-supplied). */
  threshold: number;
  /** Whether the threshold is on a per-payment or per-annum basis. */
  thresholdType: "per-payment" | "per-annum" | "per-month" | "per-transaction";
  /** Number of events processed in the FY for this section (and PAN, if scoped). */
  eventCount: number;
  /** Total gross amount processed, minor units. */
  totalGross: number;
  /** Total TDS computed (for reporting), minor units. */
  totalTdsComputed: number;
}

/** Time-of-deduction rule for a section. */
export interface TimeOfDeductionRule {
  /** Section code. */
  section: string;
  /** Description of the rule. */
  ruleDescription: string;
  /** Whether the "earlier of payment and credit" rule applies. */
  earlierOfPaymentOrCredit: boolean;
  /** For sections where TDS is due on payment only (not credit). */
  onPaymentOnly: boolean;
  /** For sections where TDS is due on credit only (not payment). */
  onCreditOnly: boolean;
  /** Deposit due date rule. */
  depositDueRule: "7th-following-month" | "30-april-for-march" | "within-30-days" | "by-30th-following-month";
  /** Notes. */
  notes: string[];
}

/** Built-in time-of-deduction rules for common sections. */
export const TDS_TIME_OF_DEDUCTION_RULES: readonly TimeOfDeductionRule[] = [
  // 192 Salary — monthly salary is credited/paid; TDS due at the time of payment
  {
    section: "192",
    ruleDescription:
      "TDS on salary: due at the time of payment of salary (monthly/periodic). Earlier of payment or credit applies.",
    earlierOfPaymentOrCredit: true,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "7th-following-month",
    notes: [
      "Salary TDS is deducted at the time of payment of salary.",
      "Monthly TDS deposit is due by 7th of the following month (30 April for March).",
    ],
  },
  // 194A Interest — earlier of payment or credit
  {
    section: "194A",
    ruleDescription: "TDS on interest: earlier of date of payment or date of credit.",
    earlierOfPaymentOrCredit: true,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "7th-following-month",
    notes: [
      "TDS on interest is deductible at the earlier of date of payment or date of credit.",
      "Deposit due: 7th of the following month (30 April for March).",
    ],
  },
  // 194C Contractor — earlier of payment or credit
  {
    section: "194C",
    ruleDescription: "TDS on contract payments: earlier of date of payment or date of credit.",
    earlierOfPaymentOrCredit: true,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "7th-following-month",
    notes: [
      "TDS on contract payments is deductible at the earlier of date of payment or date of credit.",
      "Deposit due: 7th of the following month (30 April for March).",
      "Aggregate threshold: ₹1,00,000 per annum for the same contractor.",
    ],
  },
  // 194H Commission/brokerage — earlier of payment or credit
  {
    section: "194H",
    ruleDescription: "TDS on commission/brokerage: earlier of date of payment or date of credit.",
    earlierOfPaymentOrCredit: true,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "7th-following-month",
    notes: [
      "TDS on commission/brokerage is deductible at the earlier of date of payment or date of credit.",
      "Deposit due: 7th of the following month (30 April for March).",
    ],
  },
  // 194J Professional/technical — earlier of payment or credit
  {
    section: "194J",
    ruleDescription: "TDS on professional/technical services: earlier of date of payment or date of credit.",
    earlierOfPaymentOrCredit: true,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "7th-following-month",
    notes: [
      "TDS on professional/technical services is deductible at the earlier of date of payment or date of credit.",
      "Deposit due: 7th of the following month (30 April for March).",
    ],
  },
  // 194I Rent — earlier of payment or credit
  {
    section: "194I",
    ruleDescription: "TDS on rent: earlier of date of payment or date of credit.",
    earlierOfPaymentOrCredit: true,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "7th-following-month",
    notes: [
      "TDS on rent is deductible at the earlier of date of payment or date of credit.",
      "Deposit due: 7th of the following month (30 April for March).",
      "Annual threshold: ₹2,40,000 per annum.",
    ],
  },
  // 194-IB Rent by individuals/HUFs — on payment
  {
    section: "194-IB",
    ruleDescription: "TDS on rent by individuals/HUFs (194-IB): due on payment (monthly rent > ₹50,000).",
    earlierOfPaymentOrCredit: false,
    onPaymentOnly: true,
    onCreditOnly: false,
    depositDueRule: "by-30th-following-month",
    notes: [
      "TDS on rent under 194-IB is deductible at the time of payment.",
      "Monthly threshold: ₹50,000 rent per month.",
      "Deposit due: by 30th day of the following month.",
    ],
  },
  // 194-IR Rent — on payment
  {
    section: "194-IR",
    ruleDescription: "TDS on rent by individuals/HUFs (194-IR): due on payment (monthly rent > ₹50,000).",
    earlierOfPaymentOrCredit: false,
    onPaymentOnly: true,
    onCreditOnly: false,
    depositDueRule: "by-30th-following-month",
    notes: [
      "TDS on rent under 194-IR is deductible at the time of payment.",
      "Monthly threshold: ₹50,000 rent per month.",
      "Deposit due: by 30th day of the following month.",
      "From FY 2022-23 onwards.",
    ],
  },
  // 194-IA Immovable property — on payment/credit, within 30 days
  {
    section: "194-IA",
    ruleDescription: "TDS on purchase of immovable property: earlier of payment or credit; deposit within 30 days.",
    earlierOfPaymentOrCredit: true,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "within-30-days",
    notes: [
      "TDS on purchase of immovable property is deductible at the earlier of date of payment or date of credit.",
      "Deposit due: within 30 days from the end of the month in which deduction is made.",
      "Threshold: ₹50,00,000 consideration.",
    ],
  },
  // 194Q Purchase of goods — earlier of payment or credit
  {
    section: "194Q",
    ruleDescription: "TDS on purchase of goods (194Q): earlier of date of payment or date of credit.",
    earlierOfPaymentOrCredit: true,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "7th-following-month",
    notes: [
      "TDS on purchase of goods under 194Q is deductible at the earlier of date of payment or date of credit.",
      "Deposit due: 7th of the following month (30 April for March).",
      "Threshold: ₹50,00,000 per buyer per FY.",
    ],
  },
  // 194R Benefits/perquisites — on provision
  {
    section: "194R",
    ruleDescription: "TDS on benefits/perquisites (194R): at the time of provision of benefit/perquisite.",
    earlierOfPaymentOrCredit: false,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "7th-following-month",
    notes: [
      "TDS on benefits/perquisites under 194R is deductible at the time of provision of the benefit/perquisite.",
      "Deposit due: 7th of the following month (30 April for March).",
      "Threshold: ₹20,000 per year.",
    ],
  },
  // 194S Virtual digital assets — on transfer
  {
    section: "194S",
    ruleDescription: "TDS on transfer of VDAs (194S): at the time of transfer (by buyer/exchange).",
    earlierOfPaymentOrCredit: false,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "7th-following-month",
    notes: [
      "TDS on transfer of virtual digital assets under 194S is deductible at the time of transfer.",
      "Deposit due: 7th of the following month (30 April for March).",
      "Threshold: ₹50,000 for specified entities.",
    ],
  },
  // 195 Non-resident — earlier of payment or credit
  {
    section: "195",
    ruleDescription: "TDS on payments to non-residents (195): earlier of date of payment or date of credit.",
    earlierOfPaymentOrCredit: true,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "7th-following-month",
    notes: [
      "TDS on payments to non-residents under 195 is deductible at the earlier of date of payment or date of credit.",
      "Deposit due: 7th of the following month (30 April for March).",
      "Treaty relief may apply; Form 10F and TRC may be required.",
    ],
  },
  // 206C(1H) TCS on goods — on sale
  {
    section: "206C(1H)",
    ruleDescription: "TCS on sale of goods (206C(1H)): at the time of sale/consideration.",
    earlierOfPaymentOrCredit: false,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "within-30-days",
    notes: [
      "TCS on sale of goods under 206C(1H) is collectible at the time of sale/consideration.",
      "Deposit due: within 30 days from the end of the month in which collection is made.",
      "Threshold: ₹50,00,000 sales to a single buyer in a FY.",
    ],
  },
  // 206C(1G) TCS on motor vehicles — on sale
  {
    section: "206C(1G)",
    ruleDescription: "TCS on sale of motor vehicles (206C(1G)): at the time of sale.",
    earlierOfPaymentOrCredit: false,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "within-30-days",
    notes: [
      "TCS on sale of motor vehicles under 206C(1G) is collectible at the time of sale.",
      "Deposit due: within 30 days from the end of the month in which sale is made.",
      "Threshold: ₹10,00,000 consideration.",
    ],
  },
];

/** Look up the time-of-deduction rule for a section. */
export function lookupTimeOfDeductionRule(sectionCode: string): TimeOfDeductionRule | undefined {
  return TDS_TIME_OF_DEDUCTION_RULES.find((r) => r.section.toUpperCase() === sectionCode.toUpperCase());
}

/**
 * Determine the effective deductible date for a payment event based on the
 * time-of-deduction rule for the section.
 *
 * The "earlier of" rule: TDS is deductible at the earlier of date of payment
 * and date of credit. When both are the same, the source is "same".
 * When payment is before credit, the source is "payment".
 * When credit is before payment, the source is "credit".
 */
export function effectiveDeductibleDate(
  dateOfPayment: string,
  dateOfCredit: string,
  rule: TimeOfDeductionRule | undefined,
): { effectiveDate: string; source: "payment" | "credit" | "same" } {
  if (!rule) {
    // Default: earlier of payment or credit.
    return effectiveDeductibleDate(dateOfPayment, dateOfCredit, {
      section: "",
      ruleDescription: "",
      earlierOfPaymentOrCredit: true,
      onPaymentOnly: false,
      onCreditOnly: false,
      depositDueRule: "7th-following-month",
      notes: [],
    });
  }

  if (rule.onPaymentOnly) {
    return { effectiveDate: dateOfPayment, source: "payment" };
  }
  if (rule.onCreditOnly) {
    return { effectiveDate: dateOfCredit, source: "credit" };
  }

  // Compare dates
  const paymentDate = new Date(`${dateOfPayment}T00:00:00Z`);
  const creditDate = new Date(`${dateOfCredit}T00:00:00Z`);

  if (paymentDate < creditDate) {
    return { effectiveDate: dateOfPayment, source: "payment" };
  } else if (creditDate < paymentDate) {
    return { effectiveDate: dateOfCredit, source: "credit" };
  } else {
    return { effectiveDate: dateOfPayment, source: "same" };
  }
}

/**
 * Evaluate threshold + time-of-deduction for a single payment event in the
 * context of a running threshold state.
 */
export function evaluateTdsThreshold(event: TdsPaymentEvent, state: ThresholdState): TdsThresholdOutcome {
  const rule = lookupTimeOfDeductionRule(event.section) ?? {
    section: event.section,
    ruleDescription: "Default: earlier of payment or credit.",
    earlierOfPaymentOrCredit: true,
    onPaymentOnly: false,
    onCreditOnly: false,
    depositDueRule: "7th-following-month",
    notes: [],
  };

  const { effectiveDate, source } = effectiveDeductibleDate(event.dateOfPayment, event.dateOfCredit, rule);

  const carryOverBefore = state.cumulative;
  const isFirstInYear = state.eventCount === 0;

  // Determine if threshold is crossed
  let thresholdCrossed: boolean;
  let reasonIfNotApplicable: string | null = null;
  let panMissingConsequence: string | null = null;

  if (state.thresholdType === "per-transaction") {
    // Per-transaction threshold: compare the event amount itself
    thresholdCrossed = event.amount > state.threshold;
    if (!thresholdCrossed) {
      reasonIfNotApplicable = `Amount ₹${event.amount / 100} is below the per-transaction threshold of ₹${state.threshold / 100} for section ${event.section}.`;
    }
  } else if (state.thresholdType === "per-month") {
    // Per-month threshold: check monthly cumulative
    const monthlyCumulative = state.cumulative + event.amount;
    thresholdCrossed = monthlyCumulative > state.threshold;
    if (!thresholdCrossed) {
      reasonIfNotApplicable = `Monthly cumulative ₹${monthlyCumulative / 100} is below the per-month threshold of ₹${state.threshold / 100} for section ${event.section}.`;
    }
  } else if (event.section === "194-IA") {
    // 194-IA is a per-transaction threshold on the consideration itself. The seeded state
    // reports thresholdType = "per-annum" (194-IA is grouped under the per-annum family in
    // getThresholdTypeForSection), so we override the aggregate check above and compare the
    // consideration directly against the threshold.
    thresholdCrossed = event.amount > state.threshold;
  } else {
    // Per-payment or per-annum threshold: check aggregate
    thresholdCrossed = state.cumulative + event.amount > state.threshold;
    if (!thresholdCrossed) {
      if (isFirstInYear) {
        reasonIfNotApplicable = `This is the first payment in the FY for section ${event.section}; cumulative ₹${event.amount / 100} is below the threshold of ₹${state.threshold / 100}.`;
      } else {
        reasonIfNotApplicable = `Cumulative ₹${(state.cumulative + event.amount) / 100} is below the threshold of ₹${state.threshold / 100} for section ${event.section}.`;
      }
    }
  }

  // 194-IA is a per-transaction threshold on the consideration but is grouped under
  // the per-annum family in getThresholdTypeForSection, so we special-case it here.
  if (event.section === "194-IA") {
    thresholdCrossed = event.amount > state.threshold; // per-transaction threshold on consideration (seeded state is per-annum; override here)
  }

  // PAN missing consequence
  if (!event.hasPan && event.section !== "192") {
    panMissingConsequence = `PAN not provided by deductee; higher TDS rate (typically 20%) may apply for section ${event.section} u/s 206AA.`;
  }

  // TDS applicable?
  let tdsApplicable = thresholdCrossed;

  // Form 15G/15H may override threshold in some sections
  if (event.form15G_15HReference && isForm15G_15HSection(event.section)) {
    tdsApplicable = false;
    reasonIfNotApplicable = `Form 15G/15H submitted by deductee for section ${event.section}; TDS not applicable.`;
  }

  // LDC may reduce TDS
  if (event.ldcReference) {
    // LDC may reduce or nil the TDS; actual rate to be applied per LDC
    // For now, mark as having LDC and TDS may still apply at reduced rate
    if (reasonIfNotApplicable) {
      reasonIfNotApplicable += ` Lower Deduction Certificate (LDC) reference: ${event.ldcReference}.`;
    } else {
      reasonIfNotApplicable = `Lower Deduction Certificate (LDC) reference: ${event.ldcReference}.`;
    }
  }

  // Non-resident: TDS is always applicable if income is chargeable
  if (event.isNonResident && event.section === "195") {
    tdsApplicable = true;
    if (reasonIfNotApplicable) {
      reasonIfNotApplicable = `Non-resident payment under section 195 — TDS applicable regardless of threshold. ${reasonIfNotApplicable}`;
    } else {
      reasonIfNotApplicable = `Non-resident payment under section 195 — TDS applicable regardless of threshold.`;
    }
  }

  const cumulativeAfter = state.cumulative + event.amount;

  return {
    eventId: event.id,
    section: event.section,
    deducteePan: event.deducteePan,
    amount: event.amount,
    effectiveDeductibleDate: effectiveDate,
    deductibleDateSource: source,
    thresholdCrossed,
    cumulativeAfter,
    threshold: state.threshold,
    tdsApplicable,
    reasonIfNotApplicable,
    panMissingConsequence,
    carryOverBefore,
    isFirstInYear,
  };
}

/**
 * Check if a section allows Form 15G/15H.
 */
export function isForm15G_15HSection(sectionCode: string): boolean {
  const form15G_15HSections = [
    "194A",
    "194B",
    "194BB",
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
    "194EE",
    "194G",
    "194H",
    "194I",
    "194J",
    "194LA",
    "194-LD",
    "194LC",
    "194LB",
    "194LBA",
    "194LBB",
    "194LBC",
  ];
  return form15G_15HSections.includes(sectionCode.toUpperCase());
}

/**
 * Process a batch of payment events through the threshold engine, updating
 * the threshold state for each section (and optionally per deductee PAN).
 *
 * Returns the outcomes for each event and the updated states.
 */
export function processTdsPayments(
  events: TdsPaymentEvent[],
  perDeducteeTracking: boolean = false,
  carryOver: Record<string, { cumulative: number; threshold: number }> = {},
): { outcomes: TdsThresholdOutcome[]; states: ThresholdState[] } {
  // Build initial states from events
  const statesMap = new Map<string, ThresholdState>();

  function getStateKey(section: string, pan: string): string {
    return perDeducteeTracking ? `${section}|${pan}` : section;
  }

  function getOrInitState(
    section: string,
    pan: string,
    threshold: number,
    thresholdType: ThresholdState["thresholdType"],
  ): ThresholdState {
    const key = getStateKey(section, pan);
    let state = statesMap.get(key);
    if (!state) {
      // Carry-over is the aggregate already paid in the same FY before this
      // batch (the CA working-paper's b/f column). It uses the same
      // `section|pan` key convention as `buildThresholdStates`, so callers can
      // round-trip a previous year-to-date position into the next batch.
      const seed = carryOver[key];
      state = {
        section,
        deducteePan: pan,
        cumulative: seed?.cumulative ?? 0,
        threshold: seed?.threshold ?? threshold,
        thresholdType,
        eventCount: 0,
        totalGross: 0,
        totalTdsComputed: 0,
      };
      statesMap.set(key, state);
    }
    return state;
  }

  const outcomes: TdsThresholdOutcome[] = [];

  for (const event of events) {
    // Determine the aggregate threshold and type based on section
    const threshold = getAggregateThresholdForSection(event.section, event);
    const thresholdType = getThresholdTypeForSection(event.section, event);

    const state = getOrInitState(event.section, event.deducteePan, threshold, thresholdType);

    const outcome = evaluateTdsThreshold(event, state);
    outcomes.push(outcome);

    // Update state
    state.cumulative = outcome.cumulativeAfter;
    state.eventCount += 1;
    state.totalGross += event.amount;
    if (outcome.tdsApplicable) {
      state.totalTdsComputed += computeTdsAmount(event, outcome);
    }
  }

  return {
    outcomes,
    states: Array.from(statesMap.values()).sort(
      (a, b) => a.section.localeCompare(b.section) || a.deducteePan.localeCompare(b.deducteePan),
    ),
  };
}

/**
 * Whole rupees → integer paise. Every threshold below is written in RUPEES and
 * converted here, so the unit is explicit at the point of declaration: this
 * table previously carried bare literals that were a factor of ten below true
 * paise (e.g. `50_00_00_00` for ₹50,00,000, which is 50,000,000 paise rather
 * than the correct 500,000,000). Anything reading a threshold in paise — the
 * API boundary, `tds-sections.ts`, the penalty engine — would have over-triggered
 * TDS against those values. Spelling the rupee figure and multiplying makes the
 * unit impossible to misread.
 */
const inPaise = (wholeRupees: number): number => wholeRupees * 100;

/**
 * Get the threshold for a section (caller-supplied Finance Act data).
 */
export function getThresholdForSection(sectionCode: string, event: TdsPaymentEvent): number {
  const sectionUpper = sectionCode.toUpperCase();

  // Per-transaction thresholds
  if (sectionUpper === "194-IA") return inPaise(50_00_000); // ₹50,00,000 per transaction
  if (sectionUpper === "206C(1G)") return inPaise(10_00_000); // ₹10,00,000 per transaction
  if (sectionUpper === "206C(1H)") {
    // Threshold is based on buyer's total purchases from seller in FY, not per transaction
    // For per-transaction evaluation, use a high threshold so it's evaluated on aggregate
    return inPaise(50_00_000); // ₹50,00,000 per buyer per FY
  }

  // Per-payment thresholds
  if (sectionUpper === "194A") {
    // ₹5,000 for others; ₹10,000 per quarter for banks/NSBs
    if (event.deducteeType === "bank" || event.deducteeType === "nsb" || event.deducteeType === "cooperative") {
      return inPaise(10_000); // ₹10,000 per quarter
    }
    return inPaise(5_000); // ₹5,000 per payment
  }
  if (sectionUpper === "194B" || sectionUpper === "194BB") return inPaise(10_000); // ₹10,000
  if (sectionUpper === "194D" || sectionUpper === "194G" || sectionUpper === "194H") return inPaise(15_000); // ₹15,000
  if (sectionUpper === "194EE") return inPaise(2_500); // ₹2,500
  if (sectionUpper === "194J") {
    // ₹15,000 for non-compete (if notified); ₹30,000 otherwise, per payment.
    if (event.natureOfPayment?.toLowerCase().includes("non-compete")) return inPaise(15_000);
    return inPaise(30_000); // ₹30,000 per payment
  }
  if (sectionUpper === "194LA") return inPaise(1_00_000); // ₹1,00,000
  if (sectionUpper === "194-IB" || sectionUpper === "194-IR") {
    // Monthly threshold: ₹50,000 per month
    return inPaise(50_000); // ₹50,000 per month
  }
  if (sectionUpper === "194Q") return inPaise(50_00_000); // ₹50,00,000 per buyer per FY
  if (sectionUpper === "194R") return inPaise(20_000); // ₹20,000 per year
  if (sectionUpper === "194S") return inPaise(50_000); // ₹50,000 for specified entities

  // Per-annum thresholds
  if (sectionUpper === "194C") return inPaise(30_000); // ₹30,000 per-payment trigger; annual ₹1,00,000 aggregate per contractor is enforced via getAggregateThresholdForSection
  if (sectionUpper === "194I") return inPaise(2_40_000); // ₹2,40,000 per annum

  // No threshold (always deductible)
  return 0;
}

/**
 * Resolve the threshold used for cumulative (aggregate) evaluation.
 *
 * Where a section carries both a per-payment trigger and an aggregate gate,
 * `getThresholdForSection` reports the per-payment trigger. The aggregate
 * engine must evaluate against the aggregate gate instead — notably 194C,
 * where the single-payment trigger is ₹30,000 but TDS also applies once
 * aggregate payments to the same contractor cross ₹1,00,000 in the FY.
 */
export function getAggregateThresholdForSection(sectionCode: string, event: TdsPaymentEvent): number {
  if (sectionCode.toUpperCase() === "194C") {
    return inPaise(1_00_000); // ₹1,00,000 aggregate per contractor per FY
  }
  return getThresholdForSection(sectionCode, event);
}

/**
 * Get the threshold type for a section.
 */
export function getThresholdTypeForSection(
  sectionCode: string,
  _event: TdsPaymentEvent,
): ThresholdState["thresholdType"] {
  const sectionUpper = sectionCode.toUpperCase();

  if (sectionUpper === "194-IA" || sectionUpper === "206C(1G)") return "per-transaction";
  if (sectionUpper === "194-IB" || sectionUpper === "194-IR") return "per-month";
  if (
    sectionUpper === "194C" ||
    sectionUpper === "194I" ||
    sectionUpper === "194Q" ||
    sectionUpper === "194R" ||
    sectionUpper === "194-IB" ||
    sectionUpper === "194-IR"
  )
    return "per-annum";

  return "per-payment";
}

/**
 * Compute the TDS amount for an event (basic rate × amount).
 * This is just the arithmetic; the rate is caller-supplied Finance Act data.
 */
export function computeTdsAmount(event: TdsPaymentEvent, outcome: TdsThresholdOutcome): number {
  if (!outcome.tdsApplicable) return 0;

  const rate = getRateForSection(event.section, event);
  const amount = outcome.amount;

  // If PAN is missing and section requires it, higher rate (20%) applies
  let effectiveRate = rate;
  if (!event.hasPan && event.section !== "192") {
    effectiveRate = 20; // Higher rate u/s 206AA when PAN not provided
  }

  // If LDC, rate may be reduced (caller to supply the LDC rate)
  // For now, use the standard rate

  return Math.round((amount * effectiveRate) / 100);
}

/**
 * Get the default rate for a section (caller-supplied Finance Act data).
 */
export function getRateForSection(sectionCode: string, event: TdsPaymentEvent): number {
  const sectionUpper = sectionCode.toUpperCase();

  if (sectionUpper === "192") return 0; // Slab-based; caller to compute
  if (sectionUpper === "194A") return 10;
  if (sectionUpper === "194B" || sectionUpper === "194BB") return 30;
  if (sectionUpper === "194D" || sectionUpper === "194DA") {
    return event.deducteeType === "individual" || event.deducteeType === "huf" ? 10 : 5;
  }
  if (sectionUpper === "194EE" || sectionUpper === "194KE" || sectionUpper === "194K") return 10;
  if (sectionUpper === "194F") return 0;
  if (sectionUpper === "194G" || sectionUpper === "194H") return 5;
  if (sectionUpper === "194I") {
    // 2% for plant & machinery, 10% for others
    if (
      event.natureOfPayment?.toLowerCase().includes("plant") ||
      event.natureOfPayment?.toLowerCase().includes("machinery") ||
      event.natureOfPayment?.toLowerCase().includes("equipment")
    ) {
      return 2;
    }
    return 10;
  }
  if (sectionUpper === "194-IB" || sectionUpper === "194-IR") {
    // 5% for rent (other than plant & machinery), 10% for plant & machinery
    if (
      event.natureOfPayment?.toLowerCase().includes("plant") ||
      event.natureOfPayment?.toLowerCase().includes("machinery") ||
      event.natureOfPayment?.toLowerCase().includes("equipment")
    ) {
      return 10;
    }
    return 5;
  }
  if (sectionUpper === "194J") {
    // 2% for technical services, 10% for professional services
    if (
      event.natureOfPayment?.toLowerCase().includes("technical") ||
      event.natureOfPayment?.toLowerCase().includes("manufacturing")
    ) {
      return 2;
    }
    return 10;
  }
  if (sectionUpper === "194LA") return 10;
  if (sectionUpper === "194-IA") return 1;
  if (sectionUpper === "194Q") return 0.1;
  if (sectionUpper === "194R") return 10;
  if (sectionUpper === "194S") return 1;
  if (sectionUpper === "194C") {
    return event.deducteeType === "individual" || event.deducteeType === "huf" ? 1 : 2;
  }
  if (
    sectionUpper === "195" ||
    sectionUpper === "196A" ||
    sectionUpper === "196B" ||
    sectionUpper === "196C" ||
    sectionUpper === "196D"
  )
    return 20; // Default; treaty may apply
  if (sectionUpper === "194E") return 20;
  if (sectionUpper === "194LC" || sectionUpper === "194LD") return 5;

  // TCS sections
  if (sectionUpper === "206C") return 1;
  if (sectionUpper === "206C(1H)") return 0.1;
  if (sectionUpper === "206C(1G)") {
    return event.amount > 10_00_00_00 ? 1 : 0.1; // 1% for >₹10L, 0.1% for ₹5L-₹10L
  }
  if (sectionUpper === "206C(1F)") return 1;

  return 10; // Default
}

/**
 * Build threshold states for a set of events, with initial carry-over values.
 */
export function buildThresholdStates(
  events: TdsPaymentEvent[],
  carryOver: Record<string, { cumulative: number; threshold: number }> = {},
  perDeducteeTracking: boolean = false,
): ThresholdState[] {
  const statesMap = new Map<string, ThresholdState>();

  function getStateKey(section: string, pan: string): string {
    return perDeducteeTracking ? `${section}|${pan}` : section;
  }

  // Initialize with carry-over
  for (const [key, value] of Object.entries(carryOver)) {
    const [section, pan] = key.split("|");
    statesMap.set(key, {
      section: section || "",
      deducteePan: pan || "",
      cumulative: value.cumulative,
      threshold: value.threshold,
      thresholdType: "per-annum",
      eventCount: 0,
      totalGross: 0,
      totalTdsComputed: 0,
    });
  }

  // Process events to build states
  for (const event of events) {
    const key = getStateKey(event.section, event.deducteePan);
    let state = statesMap.get(key);

    if (!state) {
      const threshold = getAggregateThresholdForSection(event.section, event);
      const thresholdType = getThresholdTypeForSection(event.section, event);
      state = {
        section: event.section,
        deducteePan: event.deducteePan,
        cumulative: 0,
        threshold,
        thresholdType,
        eventCount: 0,
        totalGross: 0,
        totalTdsComputed: 0,
      };
      statesMap.set(key, state);
    }

    // Use carry-over if available for this section
    const carryKey = getStateKey(event.section, event.deducteePan);
    if (carryOver[carryKey]) {
      state.cumulative = carryOver[carryKey]!.cumulative;
      state.threshold = carryOver[carryKey]!.threshold;
    }

    state.eventCount += 1;
    state.totalGross += event.amount;
  }

  return Array.from(statesMap.values()).sort(
    (a, b) => a.section.localeCompare(b.section) || a.deducteePan.localeCompare(b.deducteePan),
  );
}

/**
 * Get a summary of threshold crossings and TDS applicable for reporting.
 */
export function thresholdCrossingSummary(outcomes: TdsThresholdOutcome[]): {
  totalEvents: number;
  eventsWithTds: number;
  eventsWithoutTds: number;
  totalAmountWithTds: number;
  totalAmountWithoutTds: number;
  totalTdsComputed: number;
  sectionsWithTds: string[];
  panIssues: { pan: string; section: string; consequence: string }[];
  form15G_15HUsed: { pan: string; section: string; reference: string }[];
  ldcCertificates: { pan: string; section: string; reference: string }[];
} {
  const result = {
    totalEvents: outcomes.length,
    eventsWithTds: 0,
    eventsWithoutTds: 0,
    totalAmountWithTds: 0,
    totalAmountWithoutTds: 0,
    totalTdsComputed: 0,
    sectionsWithTds: [] as string[],
    panIssues: [] as { pan: string; section: string; consequence: string }[],
    form15G_15HUsed: [] as { pan: string; section: string; reference: string }[],
    ldcCertificates: [] as { pan: string; section: string; reference: string }[],
  };

  const sectionsWithTdsSet = new Set<string>();
  const panIssueSet = new Set<string>();

  for (const outcome of outcomes) {
    if (outcome.tdsApplicable) {
      result.eventsWithTds += 1;
      result.totalAmountWithTds += outcome.amount;
      sectionsWithTdsSet.add(outcome.section);
      const tdsOutcome: TdsPaymentEvent = {
        id: outcome.eventId,
        section: outcome.section,
        deducteePan: outcome.deducteePan,
        deducteeName: outcome.deducteePan,
        deducteeType: "company",
        amount: outcome.amount,
        dateOfPayment: outcome.effectiveDeductibleDate ?? "",
        dateOfCredit: "",
        isPaid: false,
        hasPan: true,
        isNonResident: false,
        ldcReference: null,
        form15G_15HReference: null,
        natureOfPayment: null,
        voucherId: null,
      };
      result.totalTdsComputed += computeTdsAmount(tdsOutcome, outcome);
    } else {
      result.eventsWithoutTds += 1;
      result.totalAmountWithoutTds += outcome.amount;
    }

    if (outcome.panMissingConsequence && !panIssueSet.has(`${outcome.deducteePan}|${outcome.section}`)) {
      panIssueSet.add(`${outcome.deducteePan}|${outcome.section}`);
      result.panIssues.push({
        pan: outcome.deducteePan,
        section: outcome.section,
        consequence: outcome.panMissingConsequence,
      });
    }

    if (outcome.reasonIfNotApplicable?.includes("Form 15G/15H")) {
      result.form15G_15HUsed.push({
        pan: outcome.deducteePan,
        section: outcome.section,
        reference: "",
      });
    }

    if (
      outcome.reasonIfNotApplicable?.includes("LDC") ||
      outcome.reasonIfNotApplicable?.includes("Lower Deduction Certificate")
    ) {
      result.ldcCertificates.push({
        pan: outcome.deducteePan,
        section: outcome.section,
        reference: "",
      });
    }
  }

  result.sectionsWithTds = Array.from(sectionsWithTdsSet).sort();

  return result;
}
