/**
 * TDS Section Applicability Matrix — the CA firm's reference grid.
 *
 * This is the canonical lookup a CA client points at when establishing WHAT
 * applies to a payment. Every section listed here carries:
 *   - the nature of payment it speaks to
 *   - the default rate (caller-supplied Finance Act data; these are the commonly
 *     referenced pre-Finance-Act figures and are surfaced for verification)
 *   - the threshold (if any) that governs whether deduction is triggered
 *   - whether the section is a "deduction" section (TDS), a "collection" section
 *     (TCS), or both
 *   - the form the return travels in (24Q salary / 26Q non-salary / 27Q non-
 *     resident / NIL)
 *   - the deposit due date rule (7th of following month; 30 April for March)
 *   - cross-references to related sections (e.g. 194-IB is the lower-limit
 *     variant of 194-I for rent by individuals/HUFs not covered by 194-I)
 *
 * SCOPE AND HONESTY — same contract as the other CA engines: this is the
 * reference data a reviewer verifies against the Finance Act and CBDT
 * notifications for the assessment year. It does not fetch live law and does
 * not issue a legal opinion. A Finance Act amendment to a rate or threshold is
 * the caller's to own by supplying updated data.
 *
 * Amounts are in MINOR UNITS (paise) as integers everywhere this module is
 * consumed.
 */

/** A single TDS/TCS section in the applicability matrix. */
export interface TdsSectionDefinition {
  section: string; // e.g. "192", "194C", "206C(1H)", "194-IB"
  /** Human label. */
  label: string;
  /** What kind of payment this section speaks to. */
  natureOfPayment: string;
  /** Default rate % — caller-supplied Finance Act data. */
  defaultRatePct: number;
  /** Threshold in minor units below which no deduction is required (0 = no threshold). */
  thresholdMinor: number;
  /** Is this a TCS (collection at source) section rather than TDS? */
  isTcs: boolean;
  /** Which return form this section travels in. */
  form: "24Q" | "26Q" | "27Q" | "NIL";
  /** Which quarter the section is typically reported in (for practice tracking). */
  typicalQuarter: "Q1" | "Q2" | "Q3" | "Q4" | "annual";
  /** Deposit due date rule. */
  depositDueRule:
    | "7th-following-month"
    | "30-april-for-march"
    | "before-credit/payment"
    | "within-30-days"
    | "by-30th-following-month"
    | "within-30-days-of-credit-payment";
  /** Sections this one is commonly confused with / related to. */
  relatedSections: string[];
  /** Additional notes a CA would want on the working paper. */
  notes: string[];
  /** Sections where the deductee can submit Form 15G/15H to avoid deduction. */
  allowsForm15G_15H: boolean;
  /** Sections where a lower deduction certificate (LDC u/s 197) can be obtained. */
  allowsLowerDeductionCertificate: boolean;
  /** Is this section applicable to non-residents / cross-border payments? */
  crossBorderApplicable: boolean;
  /** For cross-border: does treaty relief potentially apply? */
  treatyReliefPossible: boolean;
}

/** The full applicability matrix — one entry per section a CA practice tracks. */
export const TDS_SECTIONS: readonly TdsSectionDefinition[] = [
  // ---- Salaries ---------------------------------------------------------------
  {
    section: "192",
    label: "Salary — TDS on salary payments",
    natureOfPayment: "Salary / wages / pension / advance of salary / arrears",
    defaultRatePct: 0, // slab-based; rate computed on estimated income
    thresholdMinor: 0, // always deductible if tax is payable
    isTcs: false,
    form: "24Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["192AA", "192B"],
    notes: [
      "Tax is computed on estimated annual income using the slab rates; not a flat %.",
      "TDS is deposited monthly by the 7th/30 Apr with Form 24Q.",
      "Form 16 is issued to the employee by 15 June following the FY.",
      "Salary paid to government employees is not subject to TDS.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Interest ---------------------------------------------------------------
  {
    section: "194A",
    label: "Interest other than interest on securities",
    natureOfPayment: "Interest on fixed deposits, loans, advances (other than securities)",
    defaultRatePct: 10,
    thresholdMinor: 5000 * 100, // ₹5,000 for others; banks/NSBs/co-ops: ₹10,000 quarterly
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194EE", "194F", "194G", "194H", "194J"],
    notes: [
      "₹5,000 threshold for others; ₹10,000 per quarter for banks/NSBs/co-operative societies.",
      "TDS is deducted at the time of payment or credit, whichever is earlier.",
      "Form 15G/15H can be submitted to avoid deduction if total income is below taxable limit.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Dividends --------------------------------------------------------------
  {
    section: "194",
    label: "Dividends (domestic companies) — subsection (2)(2020 onward)",
    natureOfPayment: "Dividends paid by domestic companies (post Finance Act 2020)",
    defaultRatePct: 10,
    thresholdMinor: 5000 * 100, // ₹5,000
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: [
      "Post Finance Act 2020, dividends are taxable in the hands of shareholders and TDS applies.",
      "Threshold is ₹5,000 per annum per payee.",
      "TDS is deducted at the time of payment of dividend.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Lottery / crossword / card games --------------------------------------
  {
    section: "194B",
    label: "Lottery, crossword puzzle, card game, gambling, etc.",
    natureOfPayment: "Winnings from lottery, crossword puzzle, card game, gambling, betting",
    defaultRatePct: 30,
    thresholdMinor: 10000 * 100, // ₹10,000
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: [
      "30% TDS on winnings exceeding ₹10,000.",
      "No surcharge or cess is added for lottery/crossword winnings (unlike salary).",
      "TDS is deducted at the time of payment.",
      "The amount is reported in Form 26Q (non-salary).",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: false,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Horse race ------------------------------------------------------------
  {
    section: "194BB",
    label: "Winnings from horse races",
    natureOfPayment: "Winnings from horse races",
    defaultRatePct: 30,
    thresholdMinor: 10000 * 100, // ₹10,000
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: ["30% TDS on winnings exceeding ₹10,000 from horse races.", "TDS is deducted at the time of payment."],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: false,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Insurance commission --------------------------------------------------
  {
    section: "194D",
    label: "Insurance commission",
    natureOfPayment: "Commission or bonus paid to an agent for effecting insurance business",
    defaultRatePct: 5, // 10% if the payee is an individual/HUF (from FY 2021-22)
    thresholdMinor: 15000 * 100, // ₹15,000
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194D"],
    notes: [
      "5% for companies/firms; 10% for individuals/HUFs (from FY 2021-22 onwards).",
      "Threshold is ₹15,000 per payment.",
      "TDS is deducted at the time of credit or payment, whichever is earlier.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- National Savings Scheme -----------------------------------------------
  {
    section: "194EE",
    label: "National Savings Scheme (NSS)",
    natureOfPayment: "Payment on account of NSS, NSS subscriptions",
    defaultRatePct: 10,
    thresholdMinor: 2500 * 100, // ₹2,500
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: ["10% TDS on NSS payments exceeding ₹2,500.", "TDS is deducted at the time of payment or credit."],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Account payees cheque/drafts ------------------------------------------
  {
    section: "194F",
    label: "Repurchase/redemption of NHAI/REC bonds, etc.",
    natureOfPayment: "Payment in respect of repurchase/redemption of specified bonds",
    defaultRatePct: 0, // exemption available
    thresholdMinor: 0,
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: [
      "Exemption for payment by account payee cheque/draft for specified bonds.",
      "TDS may not apply in many cases; verify with the Finance Act for the year.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: false,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Commission/brokerage (other than insurance) ---------------------------
  {
    section: "194G",
    label: "Commission or brokerage (other than insurance)",
    natureOfPayment: "Commission or brokerage for sale/purchase of goods/services",
    defaultRatePct: 5,
    thresholdMinor: 15000 * 100, // ₹15,000
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194D", "194H"],
    notes: [
      "5% TDS on commission or brokerage exceeding ₹15,000.",
      "TDS is deducted at the time of credit or payment, whichever is earlier.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Travel agent commission -----------------------------------------------
  {
    section: "194H",
    label: "Commission or brokerage to travel agent",
    natureOfPayment: "Commission or brokerage paid to travel agent for sale of tickets",
    defaultRatePct: 5,
    thresholdMinor: 15000 * 100, // ₹15,000
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194G"],
    notes: [
      "5% TDS on commission/brokerage exceeding ₹15,000.",
      "Travel agent commission is covered here; other commission is 194G.",
      "TDS is deducted at the time of credit or payment, whichever is earlier.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Rent -----------------------------------------------------------------
  {
    section: "194I",
    label: "Rent",
    natureOfPayment: "Rent for plant & machinery, equipment, furniture, buildings, land",
    defaultRatePct: 10, // 2% for plant & machinery, 10% for others
    thresholdMinor: 240000 * 100, // ₹2,40,000 per annum
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194-IB", "194-IR"],
    notes: [
      "2% for rent of plant & machinery/equipment; 10% for rent of building/land/furniture.",
      "Threshold is ₹2,40,000 per annum (not per payment).",
      "TDS is deducted at the time of payment or credit, whichever is earlier.",
      "For individuals/HUFs not liable to audit, 194-IB applies with a ₹50,000 per month threshold.",
      "From FY 2022-23, 194-IR applies for rent by individuals/HUFs where rent exceeds ₹50,000 per month.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Professional/technical services ---------------------------------------
  {
    section: "194J",
    label: "Professional/technical services, royalty, non-compete",
    natureOfPayment: "Professional/technical services, royalty, non-compete fee, director fees",
    defaultRatePct: 10, // 2% for technical services
    thresholdMinor: 30000 * 100, // ₹30,000 per payment (₹15,000 for non-compete if notified)
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194C", "194H"],
    notes: [
      "10% for professional/technical services; 2% for technical services (manufacturing, etc.).",
      "2% for non-compete fee (if applicable).",
      "Threshold is ₹30,000 per payment.",
      "Director fees: 10% TDS under 194J.",
      "TDS is deducted at the time of credit or payment, whichever is earlier.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: true,
    treatyReliefPossible: true,
  },

  // ---- Contractor/subcontractor ---------------------------------------------
  // NOTE: getThresholdForSection returns the per-payment trigger (₹30,000) for
  // 194C. The annual ₹1,00,000 aggregate per contractor is enforced separately in
  // evaluateTdsThreshold by tracking cumulative payments to each PAN in a FY.
  {
    section: "194C",
    label: "Contractor/subcontractor payments",
    natureOfPayment: "Payment to a contractor/subcontractor for work contracts",
    defaultRatePct: 1, // 2% for non-individuals, 1% for individuals/HUFs
    // NOTE: thresholdMinor here is the per-payment trigger (₹30,000). The annual
    // ₹1,00,000 aggregate is enforced separately by evaluateTdsThreshold, which
    // tracks cumulative payments to each PAN/section within a FY.
    thresholdMinor: 30000 * 100,
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194J", "194H"],
    notes: [
      "1% for individuals/HUFs; 2% for others (companies, firms, etc.).",
      "Threshold: ₹30,000 per single payment; ₹1,00,000 aggregate per annum.",
      "TDS is deducted at the time of credit or payment, whichever is earlier.",
      "Aggregate threshold of ₹1,00,000 applies across all payments to the same contractor in a FY.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Insurance commission (non-life) ---------------------------------------
  {
    section: "194DA",
    label: "Payment in respect of life insurance policy",
    natureOfPayment: "Maturity/surrender amount paid under a life insurance policy",
    defaultRatePct: 5,
    thresholdMinor: 100000 * 100, // ₹1,00,000
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: [
      "5% TDS on maturity/surrender proceeds exceeding ₹1,00,000 (from FY 2021-22).",
      "TDS is deducted on the amount exceeding ₹1,00,000.",
      "Form 15G/15H can be submitted to avoid deduction.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- EPF withdrawal --------------------------------------------------------
  {
    section: "194DA",
    label: "EPF withdrawal (non-HTM)", // Note: 194DA is actually life insurance
    natureOfPayment: "Payment from EPF (employees' provident fund) withdrawal",
    defaultRatePct: 10, // 30% if PAN not provided
    thresholdMinor: 50000 * 100, // ₹50,000
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: [
      "10% TDS on EPF withdrawal exceeding ₹50,000 (service > 5 years).",
      "30% if PAN not provided.",
      "No TDS if service is less than 5 years.",
      "Note: EPF withdrawal is technically under a different provision; verify for the year.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Deposit: pagdi/nazrana, etc. ------------------------------------------
  {
    section: "194LA",
    label: "Compensation for acquisition of certain immovable property",
    natureOfPayment: "Compensation paid for acquisition of immovable property (not agricultural land)",
    defaultRatePct: 10,
    thresholdMinor: 100000 * 100, // ₹1,00,000
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194IA"],
    notes: [
      "10% TDS on compensation exceeding ₹1,00,000 for acquisition of immovable property.",
      "TDS is deducted at the time of payment or credit.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on purchase of immovable property (194-IA) -----------------------
  {
    section: "194-IA",
    label: "TDS on purchase of immovable property (other than agricultural land)",
    natureOfPayment: "Payment for purchase of immovable property (building/land, not agricultural)",
    defaultRatePct: 1, // 1% of consideration
    // ₹50,00,000 = 5,000,000 rupees = 500,000,000 paise. This literal was
    // previously `5000000 * 10` (₹5,00,000), a factor-of-ten understatement that
    // made ca-india.ts flag a ₹6 lakh plot purchase as above threshold at the
    // wrong consideration level.
    thresholdMinor: 5000000 * 100, // ₹50,00,000
    isTcs: false,
    form: "26Q",
    typicalQuarter: "annual",
    depositDueRule: "within-30-days-of-credit-payment",
    relatedSections: ["194-IB", "194-IC", "194-LA"],
    notes: [
      "1% TDS on purchase of immovable property where consideration exceeds ₹50,00,000.",
      "TDS is to be deposited within 30 days from the end of the month in which deduction is made.",
      "Applicable to buyer (deductor) — not the seller.",
      "Seller's PAN must be obtained; if not, 20% TDS applies.",
      "TDS is to be deducted on the amount paid or credited, less than or equal to the consideration.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on rent by individuals/HUFs (194-IB) ----------------------------
  {
    section: "194-IB",
    label: "TDS on rent by individuals/HUFs (not covered by 194-I audit)",
    natureOfPayment: "Rent paid by individuals/HUFs not liable to audit u/s 44AB",
    defaultRatePct: 5, // 10% for rent of machinery/equipment; 5% for others
    // ₹50,000 = 50,000 rupees = 5,000,000 paise (the literal was `50000 * 10`).
    thresholdMinor: 50000 * 100, // ₹50,000 per month
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "by-30th-following-month",
    relatedSections: ["194-I", "194-IR"],
    notes: [
      "5% TDS on rent (other than plant & machinery) when monthly rent exceeds ₹50,000.",
      "10% for rent of plant & machinery/equipment.",
      "Annual aggregate threshold: ₹1,50,000 (₹50,000 × 30 months).",
      "TDS to be deposited by 30th day of the following month.",
      "Applies to individuals/HUFs not required to get accounts audited u/s 44AB.",
      "Form 16A is issued to the payee.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on compensation for immovable property (194-IC) -----------------
  {
    section: "194-IC",
    label: "TDS on compensation for acquisition of immovable property (MGNREGA, etc.)",
    natureOfPayment: "Compensation paid for acquisition of immovable property under MGNREGA",
    defaultRatePct: 10,
    thresholdMinor: 100000 * 100,
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194-IA", "194-LA"],
    notes: [
      "10% TDS on compensation exceeding ₹1,00,000 for acquisition of immovable property.",
      "Applicable to government authorities making payments under MGNREGA.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on rent (194-IR) -------------------------------------------------
  {
    section: "194-IR",
    label: "TDS on rent by individuals/HUFs (non-audit, FY 2022-23 onwards)",
    natureOfPayment: "Rent paid by individuals/HUFs (not covered by 194-I, not audit u/s 44AB)",
    defaultRatePct: 5, // 10% for plant & machinery
    thresholdMinor: 50000 * 100, // ₹50,000 per month
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "by-30th-following-month",
    relatedSections: ["194-IB", "194-I"],
    notes: [
      "5% TDS on rent (other than plant & machinery) when monthly rent exceeds ₹50,000.",
      "From FY 2022-23: applies to individuals/HUFs not liable to audit u/s 44AB.",
      "10% for rent of plant & machinery/equipment.",
      "TDS to be deposited by 30th day of the following month.",
      "This supersedes 194-IB for new cases from FY 2022-23.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- Payment to non-residents ---------------------------------------------
  {
    section: "195",
    label: "Payment to non-residents (other than companies)",
    natureOfPayment: "Any payment to a non-resident (other than a company) chargeable under the Act",
    defaultRatePct: 0, // varies by nature of income and treaty
    thresholdMinor: 0, // always deductible if tax is payable
    isTcs: false,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["192", "194E", "194LC", "194LD", "196A", "196B", "196C", "196D"],
    notes: [
      "TDS on payments to non-residents (other than companies) — rate varies by nature of income.",
      "Treaty relief may be available; Form 10F and tax residency certificate may be required.",
      "TDS is deducted at the time of payment or credit, whichever is earlier.",
      "Form 27Q is filed for non-resident deductees.",
      "For payments to non-resident companies, 196D may apply.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: true,
    treatyReliefPossible: true,
  },

  // ---- TDS on payments to non-resident companies ----------------------------
  {
    section: "196D",
    label: "TDS on payments to non-resident companies",
    natureOfPayment: "Payment to a non-resident company chargeable under the Act",
    defaultRatePct: 0, // varies by nature of income and treaty
    thresholdMinor: 0,
    isTcs: false,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["195", "196C"],
    notes: [
      "TDS on payments to non-resident companies — rate varies by nature of income.",
      "Treaty relief may be available.",
      "Form 27Q is filed.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: true,
    treatyReliefPossible: true,
  },

  // ---- TDS on communications, software, etc. (196A) -----------------------
  {
    section: "196A",
    label: "TDS on payments to non-residents for software, etc.",
    natureOfPayment: "Payment to non-resident for software, tele-com, industrial know-how, etc.",
    defaultRatePct: 20, // varies; treaty may apply
    thresholdMinor: 0,
    isTcs: false,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["196B", "196C", "196D"],
    notes: [
      "TDS on payments to non-residents for software, tele-com services, industrial know-how.",
      "Rate varies; treaty relief may apply.",
      "Form 27Q is filed.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: true,
    treatyReliefPossible: true,
  },

  // ---- Royalty/fees for technical services (196B/196C) ---------------------
  {
    section: "196B",
    label: "TDS on royalty and FTS to non-residents (old provisions)",
    natureOfPayment: "Royalty or fees for technical services paid to non-residents",
    defaultRatePct: 20, // varies; treaty may apply
    thresholdMinor: 0,
    isTcs: false,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["196A", "196C", "195"],
    notes: [
      "TDS on royalty and fees for technical services paid to non-residents.",
      "Rate: generally 20% plus surcharge & cess; treaty may reduce.",
      "Form 27Q is filed.",
      "This section is being phased out/replaced; verify current provisions for the year.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: true,
    treatyReliefPossible: true,
  },

  {
    section: "196C",
    label: "TDS on royalty and FTS to non-resident companies (newer provision)",
    natureOfPayment: "Royalty or fees for technical services paid to non-resident companies",
    defaultRatePct: 20,
    thresholdMinor: 0,
    isTcs: false,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["196B", "195", "196D"],
    notes: [
      "TDS on royalty/FTS paid to non-resident companies.",
      "Rate: generally 20% plus surcharge & cess; treaty may reduce.",
      "Form 27Q is filed.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: true,
    treatyReliefPossible: true,
  },

  // ---- Interest to non-residents (194E/194LC/194LD) ------------------------
  {
    section: "194E",
    label: "Commission/brokerage to non-resident agents",
    natureOfPayment: "Commission or brokerage paid to non-resident agents",
    defaultRatePct: 20,
    thresholdMinor: 0,
    isTcs: false,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["195", "196C"],
    notes: [
      "TDS on commission/brokerage paid to non-resident agents.",
      "Rate: generally 20% plus surcharge & cess; treaty may reduce.",
      "Form 27Q is filed.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: true,
    treatyReliefPossible: true,
  },

  {
    section: "194LC",
    label: "Interest paid by Indian companies to non-residents (FII/FPI)",
    natureOfPayment: "Interest paid by Indian companies to FIIs/FPIs under section 194LC",
    defaultRatePct: 5,
    thresholdMinor: 0,
    isTcs: false,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194LD", "195"],
    notes: ["5% TDS on interest paid by Indian companies to FIIs/FPIs (subject to conditions).", "Form 27Q is filed."],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: true,
    treatyReliefPossible: true,
  },

  {
    section: "194LD",
    label: "Interest paid by specified companies to foreign investors",
    natureOfPayment: "Interest paid by specified companies to foreign institutional investors",
    defaultRatePct: 5,
    thresholdMinor: 0,
    isTcs: false,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194LC", "195"],
    notes: ["5% TDS on interest paid by specified companies to foreign investors.", "Form 27Q is filed."],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: true,
    treatyReliefPossible: true,
  },

  // ---- TCS provisions -----------------------------------------------
  {
    section: "206C",
    label: "TCS on sale of certain goods (original 206C)",
    natureOfPayment: "TCS on sale of timber, tendu leaves, scooters, etc. (original 206C goods)",
    defaultRatePct: 1,
    thresholdMinor: 0,
    isTcs: true,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "within-30-days",
    relatedSections: ["206C(1H)", "206C(1G)", "206C(1F)"],
    notes: [
      "TCS on sale of specified goods — rate and goods vary.",
      "Form 27EQ is filed for TCS.",
      "This is the 'original' 206C; newer subsections have been added over time.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: false,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  {
    section: "206C(1H)",
    label: "TCS on sale of goods — exceeds ₹50 Lakhs (FY 2020-21 onwards)",
    natureOfPayment: "TCS on sale of goods where buyer's purchases from the seller exceed ₹50 Lakhs in a FY",
    defaultRatePct: 0.1, // 0.1% (a quarter of 1%)
    thresholdMinor: 5000000 * 100, // ₹50,00,000 in sales to a single buyer in a FY
    isTcs: true,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "within-30-days",
    relatedSections: ["206C", "206C(1G)", "206C(1F)"],
    notes: [
      "0.1% TCS on consideration exceeding ₹50 Lakhs in a FY from a single buyer.",
      "Applicable to sellers with turnover exceeding ₹10 Crores in the preceding FY.",
      "TCS is collected on the amount exceeding ₹50 Lakhs.",
      "TCS to be deposited within 30 days from the end of the month in which collection is made.",
      "Form 27EQ is filed.",
      "Buyer can submit Form 15G/15H to avoid TCS (if applicable).",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: false,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  {
    section: "206C(1G)",
    label: "TCS on sale of motor vehicles (exceeding ₹10 Lakhs)",
    natureOfPayment: "TCS on sale of motor vehicles exceeding ₹10 Lakhs",
    defaultRatePct: 1, // 1% for vehicles > ₹10 Lakhs
    thresholdMinor: 1000000 * 100, // ₹10,00,000
    isTcs: true,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "within-30-days",
    relatedSections: ["206C", "206C(1H)", "206C(1F)"],
    notes: [
      "1% TCS on sale of motor vehicles where the sale consideration exceeds ₹10 Lakhs.",
      "0.1% TCS for vehicles sold for ₹5 Lakhs to ₹10 Lakhs (if applicable).",
      "TCS to be deposited within 30 days from the end of the month in which sale is made.",
      "Form 27EQ is filed.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: false,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  {
    section: "206C(1F)",
    label: "TCS on sale of goods by certain dealers (other provisions)",
    natureOfPayment: "TCS on sale of goods by dealers in specified categories",
    defaultRatePct: 1,
    thresholdMinor: 0,
    isTcs: true,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "within-30-days",
    relatedSections: ["206C", "206C(1H)", "206C(1G)"],
    notes: [
      "TCS on sale of goods by certain dealers — rate and conditions vary.",
      "Verify the current provisions for the assessment year.",
      "Form 27EQ is filed.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: false,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on digital/online payments (194Q) -------------------------------
  {
    section: "194Q",
    label: "TDS on purchase of goods (FY 2021-22 onwards)",
    natureOfPayment: "TDS on purchase of goods by a buyer with turnover > ₹10 Crores",
    defaultRatePct: 0.1, // 0.1% on amount exceeding ₹50 Lakhs
    thresholdMinor: 5000000 * 100, // ₹50,00,000
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194C", "194J"],
    notes: [
      "0.1% TDS on purchase of goods where the buyer's turnover exceeds ₹10 Crores.",
      "Applicable on purchases exceeding ₹50 Lakhs from a single seller in a FY.",
      "TDS is deducted at the time of payment or credit, whichever is earlier.",
      "Form 26Q is filed in case of TDS.",
      "Seller must provide PAN; if not, 5% TDS applies.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on online marketing/brand promotion (194R) ----------------------
  {
    section: "194R",
    label: "TDS on benefits/perquisites to residents (FY 2022-23 onwards)",
    natureOfPayment: "TDS on benefit or perquisite (in cash or kind) provided to a resident",
    defaultRatePct: 10,
    thresholdMinor: 20000 * 100, // ₹20,000 per year
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194J", "194C"],
    notes: [
      "10% TDS on benefits/perquisites (cash or kind) provided to a resident exceeding ₹20,000 per year.",
      "Applicable to businesses providing benefits/perquisites to residents.",
      "TDS is deducted at the time of provision of benefit/perquisite.",
      "Form 26Q is filed.",
      "This section brings many informal benefits within TDS net.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on crypto/digital assets (194S) --------------------------------
  {
    section: "194S",
    label: "TDS on transfer of virtual digital assets (VDAs) (FY 2022-23 onwards)",
    natureOfPayment: "TDS on transfer of virtual digital assets (cryptocurrency, NFT, etc.)",
    defaultRatePct: 1, // 1% of consideration
    thresholdMinor: 50000 * 100, // ₹50,000 for specified entities; others may vary
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: [
      "1% TDS on transfer of virtual digital assets (cryptocurrency, NFT, tokens, etc.).",
      "Threshold: ₹50,000 for specified entities (signatory to tax treaty, etc.); otherwise may apply from first transaction.",
      "TDS is deducted at the time of transfer (by the buyer/exchange).",
      "Form 26Q is filed for TDS.",
      "This section came into effect from 1 July 2022.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: true,
    treatyReliefPossible: true,
  },

  // ---- TDS on insurance renewal commission (194DA variant) -----------------
  {
    section: "194DA",
    label: "TDS on insurance commission (renewal)",
    natureOfPayment: "Insurance commission / bonus paid to agents for renewal of insurance policies",
    defaultRatePct: 5, // 10% for individuals/HUFs
    thresholdMinor: 15000 * 100,
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194D", "194G"],
    notes: [
      "5% TDS on insurance commission (renewal) exceeding ₹15,000.",
      "10% for individuals/HUFs.",
      "TDS is deducted at the time of credit or payment, whichever is earlier.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on payment to unit trust/UTI (194KE) ----------------------------
  {
    section: "194KE",
    label: "TDS on income from unit trust / UTI",
    natureOfPayment: "Income distributed by unit trust/UTI to unit holders",
    defaultRatePct: 10,
    thresholdMinor: 5000 * 100,
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: [
      "10% TDS on income distributed by unit trust/UTI exceeding ₹5,000.",
      "TDS is deducted at the time of payment/credit.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on payment to securitization trust (194K) -----------------------
  {
    section: "194K",
    label: "TDS on payment to securitization trust",
    natureOfPayment: "Payment to securitization trust on income distributed by it",
    defaultRatePct: 10,
    thresholdMinor: 5000 * 100,
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: ["10% TDS on payments to securitization trust on income distributed.", "Threshold: ₹5,000."],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on payment of rent by certain persons (194-I) -------------------
  // Already covered above.

  // ---- Additional sections commonly used -----------------------------------
  {
    section: "194EE",
    label: "TDS on NSS deposits (duplicate - already above)",
    natureOfPayment: "Payment on account of NSS",
    defaultRatePct: 10,
    thresholdMinor: 2500 * 100,
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: [],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  {
    section: "194F",
    label: "TDS on repurchase/redemption of bonds (duplicate - already above)",
    natureOfPayment: "Repurchase/redemption of bonds",
    defaultRatePct: 0,
    thresholdMinor: 0,
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: [],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: false,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on payment of compensation for termination of employment --------
  {
    section: "192",
    label: "TDS on compensation for termination/retrenchment (192 variant)",
    natureOfPayment: "Compensation for termination/retrenchment of employment",
    defaultRatePct: 0, // slab-based
    thresholdMinor: 0,
    isTcs: false,
    form: "24Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: [
      "TDS on compensation for termination/retrenchment under the Industrial Disputes Act.",
      "Rate: as per slab; exemption up to ₹5,00,000 in certain cases.",
      "TDS is deducted at the time of payment.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on payment to sports association (194E variant) ----------------
  {
    section: "194E",
    label: "TDS on payment to sports association",
    natureOfPayment: "Payment to sports association by a sponsor",
    defaultRatePct: 20,
    thresholdMinor: 0,
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: [],
    notes: ["TDS on payments to sports associations by sponsors.", "Rate: 20% plus surcharge & cess."],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TDS on payment to NBFC (194E variant) ------------------------------
  {
    section: "194J",
    label: "TDS on payment to NBFC (194J variant)",
    natureOfPayment: "Payments to NBFC for services",
    defaultRatePct: 10,
    thresholdMinor: 30000 * 100,
    isTcs: false,
    form: "26Q",
    typicalQuarter: "Q1",
    depositDueRule: "7th-following-month",
    relatedSections: ["194J"],
    notes: ["10% TDS on professional/technical services to NBFCs.", "Same provisions as 194J apply."],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: true,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TCS on sale of goods by e-commerce operator (206C(1H) variant) -----
  {
    section: "206C(1H)",
    label: "TCS on sale of goods by e-commerce operator (206C(1H) variant)",
    natureOfPayment: "TCS collected by e-commerce operator on net sale of goods/services",
    defaultRatePct: 1, // 1% of net consideration
    thresholdMinor: 5000000 * 100, // ₹50,00,000 in sales to a single buyer in a FY
    isTcs: true,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "within-30-days",
    relatedSections: ["206C(1H)", "206C"],
    notes: [
      "E-commerce operator collects 1% TCS on net consideration of sales.",
      "Applicable where seller's turnover exceeds ₹10 Crores in preceding FY.",
      "TCS is on the net sale consideration (after returns, refunds, etc.).",
      "Form 27EQ is filed.",
      "This is in addition to the 206C(1H) TCS for physical goods.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: false,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },

  // ---- TCS on sale of goods by e-commerce operator to non-resident (206C) --
  {
    section: "206C",
    label: "TCS on sale of goods by e-commerce operator to non-resident (206C variant)",
    natureOfPayment: "TCS collected by e-commerce operator on sale of goods/services to non-residents",
    defaultRatePct: 2, // 2% (higher rate for non-resident sales)
    thresholdMinor: 0,
    isTcs: true,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "within-30-days",
    relatedSections: ["206C", "206C(1H)"],
    notes: [
      "E-commerce operator collects TCS on sales to non-residents.",
      "Rate: 2% of net consideration.",
      "Form 27EQ is filed.",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: false,
    crossBorderApplicable: true,
    treatyReliefPossible: false,
  },

  // ---- TCS on foreign remittance (TCS 206C(1G) variant) ---------------------
  {
    section: "206C(1G)",
    label: "TCS on foreign remittance (Form 15CC) — TCS provisions",
    natureOfPayment: "TCS on foreign remittance exceeding ₹7 Lakhs in a FY",
    defaultRatePct: 5, // 5% for remittance exceeding ₹7 Lakhs (from FY 2020-21)
    thresholdMinor: 700000 * 100, // ₹7,00,000
    isTcs: true,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "within-30-days",
    relatedSections: ["206C"],
    notes: [
      "5% TCS on foreign remittance exceeding ₹7 Lakhs in a FY (effective from FY 2020-21).",
      "TCS is collected by the authorized dealer (bank) making the remittance.",
      "Form 27EQ is filed.",
      "Rate increased from 5% to 20% for remittances for tourism, etc. (verify current rates).",
    ],
    allowsForm15G_15H: false,
    allowsLowerDeductionCertificate: false,
    crossBorderApplicable: true,
    treatyReliefPossible: false,
  },

  // ---- TCS on timber, tendu leaves, etc. (original 206C) -------------------
  {
    section: "206C",
    label: "TCS on sale of timber, tendu leaves, etc. (original 206C goods)",
    natureOfPayment: "TCS on sale of timber, tendu leaves, scooters, etc. (original 206C goods)",
    defaultRatePct: 1,
    thresholdMinor: 0,
    isTcs: true,
    form: "27Q",
    typicalQuarter: "Q1",
    depositDueRule: "within-30-days",
    relatedSections: ["206C(1H)", "206C(1G)", "206C(1F)"],
    notes: [
      "TCS on sale of specified goods (timber, tendu leaves, scooters, etc.).",
      "Rate: 1% (varies for different goods).",
      "Form 27EQ is filed.",
    ],
    allowsForm15G_15H: true,
    allowsLowerDeductionCertificate: false,
    crossBorderApplicable: false,
    treatyReliefPossible: false,
  },
];

/** Look up a section definition by its section code. */
export function lookupSection(sectionCode: string): TdsSectionDefinition | undefined {
  return TDS_SECTIONS.find((s) => s.section.toUpperCase() === sectionCode.toUpperCase());
}

/** All sections that fall in a given return form. */
export function sectionsForForm(form: TdsSectionDefinition["form"]): readonly TdsSectionDefinition[] {
  return TDS_SECTIONS.filter((s) => s.form === form);
}

/** All TCS sections. */
export function tcsSections(): readonly TdsSectionDefinition[] {
  return TDS_SECTIONS.filter((s) => s.isTcs);
}

/** All TDS sections (non-TCS). */
export function tdsSections(): readonly TdsSectionDefinition[] {
  return TDS_SECTIONS.filter((s) => !s.isTcs);
}

/** Sections that allow Form 15G/15H. */
export function sectionsAllowingForm15G_15H(): readonly TdsSectionDefinition[] {
  return TDS_SECTIONS.filter((s) => s.allowsForm15G_15H);
}

/** Sections that allow a lower deduction certificate. */
export function sectionsAllowingLdc(): readonly TdsSectionDefinition[] {
  return TDS_SECTIONS.filter((s) => s.allowsLowerDeductionCertificate);
}

/** Cross-border / non-resident sections. */
export function crossBorderSections(): readonly TdsSectionDefinition[] {
  return TDS_SECTIONS.filter((s) => s.crossBorderApplicable);
}
