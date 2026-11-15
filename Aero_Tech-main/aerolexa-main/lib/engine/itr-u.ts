/**
 * ITR-U (updated return) engine — s.139(8A) filing with the s.140B additional
 * tax, and the payload the e-filing gateway needs.
 *
 * What it actually does: given the original return's figures and the updated
 * ones, it works out the additional income, the additional tax on it, which
 * s.140B rate band the filing date falls into (measured from the end of the
 * relevant assessment year), the additional tax itself, interest already
 * computed by the caller, the net payable, the eligibility blockers, and a
 * validated ITR-U payload.
 *
 * SCOPE AND HONESTY: eligibility is a legal question. The blockers checked here
 * are the ones the caller flags as fact (pending proceedings, search/survey,
 * reducing reported income, claiming a refund, showing a loss). The engine does
 * not fetch live law, does not decide whether the year can still be updated,
 * and does not file anything — it builds a payload and says what it assumed.
 * The rate bands are DEFAULTS the caller may override; every result names the
 * band it applied.
 *
 * All amounts are in MINOR UNITS (paise) as integers.
 */

export class ItrUError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItrUError";
  }
}

export interface UpdatedReturnBand {
  /** Upper bound of the band, in whole months from the end of the relevant AY. */
  upToMonths: number;
  /** Additional tax as a percentage of tax + interest on the updated figures. */
  ratePct: number;
}

/**
 * Default s.140B bands, measured from the END OF THE RELEVANT ASSESSMENT YEAR:
 * up to 12 months 25%, 12–24 months 50%, 24–36 months 60%, 36–48 months 70%.
 * Finance Act data — verify against the current section before filing.
 */
export const DEFAULT_140B_BANDS: readonly UpdatedReturnBand[] = [
  { upToMonths: 12, ratePct: 25 },
  { upToMonths: 24, ratePct: 50 },
  { upToMonths: 36, ratePct: 60 },
  { upToMonths: 48, ratePct: 70 },
];

function parseIso(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ItrUError(`${field} must be yyyy-mm-dd, received "${value}".`);
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t)) throw new ItrUError(`Unparseable ${field} "${value}".`);
  return t;
}

/**
 * The end of the assessment year, e.g. "2023-24" → "2024-03-31". The AY label is
 * the two-year span in which the previous year's income is assessed, so it ends
 * on 31 March of the second year.
 */
export function endOfAssessmentYear(assessmentYear: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(assessmentYear);
  if (!m) throw new ItrUError(`assessmentYear must look like "2023-24", received "${assessmentYear}".`);
  const startYear = Number(m[1]);
  const endShort = Number(m[2]);
  if ((startYear + 1) % 100 !== endShort) {
    throw new ItrUError(
      `assessmentYear "${assessmentYear}" is not a consecutive pair (expected ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}).`,
    );
  }
  return `${startYear + 1}-03-31`;
}

/** Whole months elapsed between two dates (calendar months, rounded down). */
export function monthsBetween(fromIso: string, toIso: string): number {
  const from = new Date(parseIso(fromIso, "from"));
  const to = new Date(parseIso(toIso, "to"));
  if (to < from) return 0;
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/** Add whole calendar months to a date, clamping to the end of a short month. */
export function addMonths(fromIso: string, months: number): string {
  const d = new Date(parseIso(fromIso, "from"));
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

/** The s.140B rate for a filing that many whole months after the AY end, or null past the last band. */
export function additionalTaxRatePct(
  monthsElapsed: number,
  bands: readonly UpdatedReturnBand[] = DEFAULT_140B_BANDS,
): number | null {
  if (monthsElapsed < 0) throw new ItrUError("monthsElapsed must not be negative.");
  for (const band of bands) {
    if (monthsElapsed <= band.upToMonths) return band.ratePct;
  }
  return null;
}

/**
 * Pick the band by comparing the filing date with each band's exact closing
 * date. Counting whole months alone is off by a day at the boundary: 1 April is
 * one day past a 31 March window close even though only 12 whole months have
 * elapsed, and s.140B turns on whether the filing is *after* the window.
 */
export function bandForFilingDate(
  endOfAyIso: string,
  filingIso: string,
  bands: readonly UpdatedReturnBand[] = DEFAULT_140B_BANDS,
): { ratePct: number; upToMonths: number; windowEndsOn: string } | null {
  const filing = parseIso(filingIso, "filingDate");
  for (const band of bands) {
    const windowEndsOn = addMonths(endOfAyIso, band.upToMonths);
    if (filing <= parseIso(windowEndsOn, "windowEndsOn")) {
      return { ratePct: band.ratePct, upToMonths: band.upToMonths, windowEndsOn };
    }
  }
  return null;
}

export interface UpdatedReturnInput {
  pan: string;
  name: string;
  assessmentYear: string;
  /** Date the original return was filed, or null when none was filed. */
  originalReturnFiledDate: string | null;
  updatedReturnFilingDate: string;
  originalTotalIncomeMinor: number;
  updatedTotalIncomeMinor: number;
  /** Tax on the original figures, minor units. */
  taxOnOriginalMinor: number;
  /** Tax on the updated figures, minor units. */
  taxOnUpdatedMinor: number;
  /** Interest u/s 234A/234B/234C already computed on the updated figures. */
  interestOnUpdatedMinor: number;
  /** Tax + interest already paid. */
  taxAlreadyPaidMinor: number;
  /** Fact flags the caller owns — the engine only reports them as blockers. */
  pendingProceedings?: boolean;
  searchOrSurvey?: boolean;
  /** True when the update would reduce the reported income or claim a refund. */
  reducesReportedIncome?: boolean;
  /** True when the update would show or increase a brought-forward loss. */
  showsLoss?: boolean;
  reasons?: string[];
  bands?: readonly UpdatedReturnBand[];
}

export interface UpdatedReturnResult {
  pan: string;
  name: string;
  assessmentYear: string;
  endOfAssessmentYear: string;
  monthsElapsed: number;
  bandRatePct: number | null;
  originalTotalIncomeMinor: number;
  updatedTotalIncomeMinor: number;
  additionalIncomeMinor: number;
  taxOnUpdatedMinor: number;
  taxOnOriginalMinor: number;
  /** Additional tax on the updated figures (excludes the s.140B charge). */
  additionalTaxOnIncomeMinor: number;
  interestOnUpdatedMinor: number;
  /** Base the s.140B percentage applies to = additional tax on income + interest. */
  baseForAdditionalTaxMinor: number;
  additionalTax140BMinor: number;
  totalLiabilityMinor: number;
  taxAlreadyPaidMinor: number;
  netPayableMinor: number;
  eligible: boolean;
  blockers: string[];
  breakdown: string[];
  payload: {
    form: "ITR-U";
    assessmentYear: string;
    pan: string;
    name: string;
    reason: string[];
    income: {
      updatedTotalIncomeMinor: number;
      originalTotalIncomeMinor: number;
      additionalIncomeMinor: number;
    };
    tax: {
      taxOnUpdatedMinor: number;
      interestOnUpdatedMinor: number;
      additionalTax140BMinor: number;
      additionalTaxRatePct: number | null;
      totalLiabilityMinor: number;
      taxAlreadyPaidMinor: number;
      netPayableMinor: number;
    };
    verification: { filedBy: string; filingDate: string };
  };
  methodology: string[];
}

/**
 * Compute the updated-return position and build the ITR-U payload.
 */
export function buildUpdatedReturn(input: UpdatedReturnInput): UpdatedReturnResult {
  parseIso(input.updatedReturnFilingDate, "updatedReturnFilingDate");
  if (input.originalReturnFiledDate) parseIso(input.originalReturnFiledDate, "originalReturnFiledDate");
  for (const [field, value] of [
    ["originalTotalIncomeMinor", input.originalTotalIncomeMinor],
    ["updatedTotalIncomeMinor", input.updatedTotalIncomeMinor],
    ["taxOnOriginalMinor", input.taxOnOriginalMinor],
    ["taxOnUpdatedMinor", input.taxOnUpdatedMinor],
    ["interestOnUpdatedMinor", input.interestOnUpdatedMinor],
    ["taxAlreadyPaidMinor", input.taxAlreadyPaidMinor],
  ] as const) {
    if (!Number.isFinite(value) || value < 0)
      throw new ItrUError(`${field} must be a finite, non-negative amount in paise.`);
  }

  const endOfAy = endOfAssessmentYear(input.assessmentYear);
  const monthsElapsed = monthsBetween(endOfAy, input.updatedReturnFilingDate);
  const bands = input.bands ?? DEFAULT_140B_BANDS;
  const band = bandForFilingDate(endOfAy, input.updatedReturnFilingDate, bands);
  const bandRatePct = band?.ratePct ?? null;

  const blockers: string[] = [];
  if (band === null) {
    const lastBand = bands[bands.length - 1];
    blockers.push(
      lastBand
        ? `Filing is after the end of the ${lastBand.upToMonths}-month window (it closed ${addMonths(endOfAy, lastBand.upToMonths)}) for AY ${input.assessmentYear}.`
        : `No s.140B band is configured, so no update window is modelled for AY ${input.assessmentYear}.`,
    );
  }
  if (input.pendingProceedings) blockers.push("A proceeding for assessment or reassessment is pending for this year.");
  if (input.searchOrSurvey) blockers.push("The year is covered by a search or survey.");
  if (input.reducesReportedIncome)
    blockers.push("An updated return cannot reduce the income already reported or result in a refund.");
  if (input.showsLoss) blockers.push("An updated return cannot show or increase a loss (s.139(8A) proviso).");
  if (input.updatedTotalIncomeMinor < input.originalTotalIncomeMinor) {
    blockers.push(
      "The updated total income is lower than the original — an updated return cannot reduce reported income.",
    );
  }

  const additionalIncomeMinor = Math.max(0, input.updatedTotalIncomeMinor - input.originalTotalIncomeMinor);
  const additionalTaxOnIncomeMinor = Math.max(0, input.taxOnUpdatedMinor - input.taxOnOriginalMinor);
  const baseForAdditionalTaxMinor = additionalTaxOnIncomeMinor + input.interestOnUpdatedMinor;
  const additionalTax140BMinor = bandRatePct === null ? 0 : Math.round((baseForAdditionalTaxMinor * bandRatePct) / 100);
  const totalLiabilityMinor = input.taxOnUpdatedMinor + input.interestOnUpdatedMinor + additionalTax140BMinor;
  const netPayableMinor = totalLiabilityMinor - input.taxAlreadyPaidMinor;

  const bandLabel = bandRatePct === null ? "outside every modelled band" : `${bandRatePct}%`;
  const breakdown = [
    `Assessment year ${input.assessmentYear} ended ${endOfAy}; the updated return is filed ${monthsElapsed} whole month(s) later.`,
    band
      ? `s.140B band applied: ${bandLabel} — the ${band.upToMonths}-month window closed on ${band.windowEndsOn}.`
      : `s.140B band applied: ${bandLabel}.`,
    `Additional income ₹${additionalIncomeMinor / 100} → additional tax on income ₹${additionalTaxOnIncomeMinor / 100}.`,
    `Interest on the updated figures ₹${input.interestOnUpdatedMinor / 100}.`,
    `Base for the s.140B charge = additional tax + interest = ₹${baseForAdditionalTaxMinor / 100}.`,
    bandRatePct === null
      ? "No s.140B charge computed because the filing falls outside the modelled window."
      : `s.140B additional tax = ${bandRatePct}% × ₹${baseForAdditionalTaxMinor / 100} = ₹${additionalTax140BMinor / 100}.`,
    `Total liability ₹${totalLiabilityMinor / 100} less tax already paid ₹${input.taxAlreadyPaidMinor / 100} = net payable ₹${netPayableMinor / 100}.`,
  ];

  const reasons = input.reasons?.length
    ? [...input.reasons]
    : ["Return previously filed with under-reported income; updating voluntarily."];

  return {
    pan: input.pan,
    name: input.name,
    assessmentYear: input.assessmentYear,
    endOfAssessmentYear: endOfAy,
    monthsElapsed,
    bandRatePct,
    originalTotalIncomeMinor: input.originalTotalIncomeMinor,
    updatedTotalIncomeMinor: input.updatedTotalIncomeMinor,
    additionalIncomeMinor,
    taxOnUpdatedMinor: input.taxOnUpdatedMinor,
    taxOnOriginalMinor: input.taxOnOriginalMinor,
    additionalTaxOnIncomeMinor,
    interestOnUpdatedMinor: input.interestOnUpdatedMinor,
    baseForAdditionalTaxMinor,
    additionalTax140BMinor,
    totalLiabilityMinor,
    taxAlreadyPaidMinor: input.taxAlreadyPaidMinor,
    netPayableMinor,
    eligible: blockers.length === 0,
    blockers,
    breakdown,
    payload: {
      form: "ITR-U",
      assessmentYear: input.assessmentYear,
      pan: input.pan,
      name: input.name,
      reason: reasons,
      income: {
        updatedTotalIncomeMinor: input.updatedTotalIncomeMinor,
        originalTotalIncomeMinor: input.originalTotalIncomeMinor,
        additionalIncomeMinor,
      },
      tax: {
        taxOnUpdatedMinor: input.taxOnUpdatedMinor,
        interestOnUpdatedMinor: input.interestOnUpdatedMinor,
        additionalTax140BMinor,
        additionalTaxRatePct: bandRatePct,
        totalLiabilityMinor,
        taxAlreadyPaidMinor: input.taxAlreadyPaidMinor,
        netPayableMinor,
      },
      verification: { filedBy: input.name, filingDate: input.updatedReturnFilingDate },
    },
    methodology: [
      "The update window and the s.140B bands run from the END of the relevant assessment year.",
      "Additional tax on income = tax on the updated figures − tax on the original figures.",
      "The s.140B percentage applies to additional tax + interest, not to the tax alone.",
      "Blockers reported here are the caller's factual flags; eligibility in law is the caller's call.",
      "The payload carries the figures and the band applied so the working paper can be checked line by line.",
    ],
  };
}

export interface ItrUValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Validate an ITR-U payload before it goes to the gateway. */
export function validateItrUPayload(payload: unknown): ItrUValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const p = payload as Partial<UpdatedReturnResult["payload"]> | null;

  if (!p || typeof p !== "object") {
    return { valid: false, errors: ["Payload is not an object."], warnings };
  }
  if (p.form !== "ITR-U") errors.push('form must be "ITR-U".');
  if (!p.assessmentYear || !/^\d{4}-\d{2}$/.test(p.assessmentYear))
    errors.push('assessmentYear must look like "2023-24".');
  if (!p.pan || !/^[A-Z]{5}\d{4}[A-Z]$/.test(p.pan)) errors.push("pan must be a valid 10-character PAN.");
  if (!p.name) errors.push("name is required.");
  if (!p.reason?.length) errors.push("At least one reason for updating the return is required.");
  if (!p.tax) {
    errors.push("tax block is required.");
  } else {
    if (p.tax.additionalTaxRatePct === null)
      warnings.push("No s.140B band was applied — confirm the filing is really outside the window.");
    if (p.tax.netPayableMinor < 0) warnings.push("Net payable is negative: an updated return cannot produce a refund.");
  }
  if (!p.verification?.filingDate) errors.push("A verification filing date is required.");

  return { valid: errors.length === 0, errors, warnings };
}
