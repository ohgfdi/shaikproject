/**
 * House property head computation for Indian income-tax returns.
 *
 * This is the authoritative house-property layer for the CA firm computation
 * graph. It covers let-out property, self-occupied property, deemed letting,
 * NAV mechanics (municipal value / fair rent / standard rent / expected rent /
 * rent received), 30% standard deduction, housing loan interest with the
 * relevant caps, loss computation, and loss set-off and carry-forward
 * discipline.
 *
 * SCOPE AND HONESTY — same rule that governs `india-tax.ts`:
 *
 *   Caps and ceilings are DATA supplied by the caller where the law is
 *   date-sensitive. The defaults shipped here are labelled with the assessment
 *   year they belong to. This engine computes the head-level numbers; it does
 *   not fetch live law, it does not value municipal capsules, and it does not
 *   issue a legal opinion. Every simplification is named in `methodology`.
 *
 *   Loss set-off and carry-forward here is the head-discipline layer: it states
 *   what may be set off now and what must be carried forward, and it flags the
 *   cases where the firm must apply the head-specific restriction (for example,
 *   the restriction on set-off of HP loss against other heads in a given year
 *   for an individual; see the warnings on the result).
 *
 * Money is in MINOR UNITS (paise) as integers, matching `india-tax.ts`.
 */

import { INR, formatInr } from "./india-tax";

// ---------------------------------------------------------------------------
// Input model
// ---------------------------------------------------------------------------

export type PropertyStatus = "let-out" | "self-occupied" | "deemed-let-out" | "part-self-occupied-part-let-out";

/** One property. A return may have multiple; this engine computes per-property
 * and aggregates. */
export interface HousePropertyInput {
  /** Short identifier for the slip/report, e.g. "HP-1". */
  id: string;
  /** Status that drives the regime. */
  status: PropertyStatus;
  /** Municipal value for the property (minor units). */
  municipalValue: number;
  /** Fair rent for the property (minor units). */
  fairRent?: number;
  /** Standard rent, if applicable (minor units). */
  standardRent?: number;
  /** Rent actually received/receivable in the year (minor units). */
  rentReceived: number;
  /** Unrealized rent actually realized during the year (minor units), if any. */
  unrealizedRealized?: number;
  /** Municipal taxes paid by owner during the year (minor units). */
  municipalTaxPaid: number;
  /** Interest on loan taken for acquisition/construction (minor units). */
  interestOnHousingLoan: number;
  /** Pre-construction interest, if any (minor units); apportioned under 24(b). */
  preConstructionInterest?: number;
  /** Whether the lender has deducted TDS u/s 194(ix); for disclosure only. */
  tdsDeductedByLender?: number;
  /** Repairs and other expenses actually paid by owner, if the owner opts to
   * claim actual (only where actual is permitted; otherwise the 30% standard
   * deduction model applies). Used for context and flagged if disallowed. */
  actualExpenses?: number;
  /** Optional override of the self-occupied interest ceiling (e.g. ₹30,000 for
   * loans under the pre-1999 scheme). Defaults to ₹2,00,000. */
  interestCeiling?: number;
  /** Notes/reason for any special treatment the reviewer should see. */
  notes?: string;
}

/** Aggregate inputs for the aggregate computation. */
export interface HousePropertyAggregateInput {
  /** Assessment year, e.g. "2025-26". */
  ay: string;
  /** Relevant regime label (for reporting only; the head math is regime-neutral
   * except for carrying the regime label through). */
  regimeLabel: string;
  /** The properties. If more than one self-occupied, the self-occupied rules
   * apply per the regime (commonly only one self-occupied may claim the nil/low
   * income treatment; the rest are deemed let-out). The engine does not
   * adjudicate that selection; it flags it. */
  properties: HousePropertyInput[];
  /** Option to treat one self-occupied as self-occupied and the rest as deemed
   * let-out. If false, all self-occupied are treated on their own; the caller
   * must ensure the correct deemed-let-out conversions. */
  electOneSelfOccupiedAsNil?: boolean;
  /** Ceiling on set-off of current-year HP loss against other heads u/s 71(3A).
   * Default ₹2,00,000. Pass Infinity to disable the cap (non-individual/HUF). */
  otherHeadsSetOffCap?: number;
}

// ---------------------------------------------------------------------------
// Common ceilings (labelled by AY)
// ---------------------------------------------------------------------------

/** Self-occupied interest deduction ceiling commonly referenced for the relevant
 * AY. Override by passing values into the caller's computation if the exact
 * figure differs. */
export const SELF_OCCUPIED_INTEREST_CEILING_COMMON = INR(200_000);

/** Where the property is acquired/constructed after a date that qualifies for the
 * lower ceiling on let-out/self-occupied without the higher limit. This constant
 * is contextual only; the caller passes the actual ceiling they intend. */
export const LOWER_INTEREST_CEILING_COMMON = INR(30_000);

// ---------------------------------------------------------------------------
// NAV helpers
// ---------------------------------------------------------------------------

function expectedRent(municipalValue: number, fairRent: number | undefined, standardRent: number | undefined): number {
  // Expected rent = higher of municipal value and fair rent, subject to standard
  // rent where applicable.
  const mv = Math.max(0, municipalValue);
  const fr = fairRent != null ? Math.max(0, fairRent) : mv;
  const higher = Math.max(mv, fr);
  const sr = standardRent != null ? Math.max(0, standardRent) : null;
  return sr != null ? Math.min(higher, sr) : higher;
}

/**
 * Gross annual value u/s 23(1)(a)-(c): the higher of the expected rent and the
 * actual rent received/receivable, less municipal taxes paid by the owner.
 * `actualRent` already includes unrealized rent later realized (s.25A), which is
 * taxable in the year of receipt.
 */
function netAnnualValue(expectedRent: number, actualRent: number, municipalTaxPaid: number): number {
  const rr = Math.max(0, actualRent);
  const er = Math.max(0, expectedRent);
  const grossValue = Math.max(er, rr);
  return Math.max(0, grossValue - Math.max(0, municipalTaxPaid));
}

// ---------------------------------------------------------------------------
// Per-property computation
// ---------------------------------------------------------------------------

export interface PropertyResult {
  id: string;
  status: PropertyStatus;
  municipalValue: number;
  fairRent: number | undefined;
  standardRent: number | undefined;
  expectedRent: number;
  rentReceived: number;
  municipalTaxPaid: number;
  nav: number;
  standardDeduction30: number;
  netAnnualValueAfterStdDed: number;
  interestOnHousingLoan: number;
  preConstructionInterest: number | undefined;
  totalDeductionUnder24: number;
  incomeFromHouseProperty: number;
  lossFromHouseProperty: number;
  notes: string[];
  methodology: string[];
}

export function computeProperty(input: HousePropertyInput): PropertyResult {
  const mv = Math.max(0, input.municipalValue);
  const fr = input.fairRent != null ? Math.max(0, input.fairRent) : mv;
  const sr = input.standardRent != null ? Math.max(0, input.standardRent) : undefined;
  const er = expectedRent(mv, fr, sr);
  const rentReceivable = Math.max(0, input.rentReceived);
  const ur = Math.max(0, input.unrealizedRealized ?? 0);
  const rr = rentReceivable + ur;
  const mt = Math.max(0, input.municipalTaxPaid);

  // A self-occupied house has NO annual value: s.23(2) puts its GAV at nil, so
  // the 30% deduction and municipal-tax arithmetic never start. Only the
  // interest under 24(b) survives (capped at the self-occupied ceiling).
  const selfOccupied = input.status === "self-occupied";
  const nav = selfOccupied ? 0 : netAnnualValue(er, rr, mt);

  // Standard deduction under 24(a): 30% of NAV.
  const std30 = Math.round(nav * 0.3);
  const navAfterStd30 = nav - std30;

  // Interest under 24(b): current year interest plus the pre-construction
  // interest apportioned to this year (the caller supplies the 1/5 instalment).
  const currentInterest = Math.max(0, input.interestOnHousingLoan);
  const preCon = Math.max(0, input.preConstructionInterest ?? 0);
  const totalInterest = currentInterest + preCon;

  // Apply relevant ceiling by status.
  let admissibleInterest = totalInterest;
  const notes: string[] = [];
  const methodology: string[] = [
    `Property ${input.id}: status ${input.status}.`,
    `Municipal value ${formatInr(mv)}; fair rent ${formatInr(fr)}; standard rent ${sr != null ? formatInr(sr) : "—"}.`,
    `Expected rent ${formatInr(er)}; rent received ${formatInr(rentReceivable)} (unrealized rent realized ${formatInr(ur)}).`,
    selfOccupied
      ? `Self-occupied: gross annual value is NIL under s.23(2); NAV nil.`
      : `NAV ${formatInr(nav)} = max(expected rent, actual rent ${formatInr(rr)}) - municipal tax ${formatInr(mt)}.`,
    `30% standard deduction: ${formatInr(std30)}.`,
    `Net annual value after 30% deduction: ${formatInr(navAfterStd30)}.`,
    `Interest on housing loan: current ${formatInr(currentInterest)}; pre-construction apportioned ${formatInr(preCon)}.`,
  ];

  // Self-occupied: interest admissible up to the relevant ceiling.
  if (selfOccupied) {
    const ceiling = Math.max(0, Math.round(input.interestCeiling ?? SELF_OCCUPIED_INTEREST_CEILING_COMMON));
    admissibleInterest = Math.min(totalInterest, ceiling);
    if (totalInterest > ceiling) {
      notes.push(
        `Interest of ${formatInr(totalInterest)} exceeds the self-occupied ceiling of ${formatInr(ceiling)}; admissible ${formatInr(admissibleInterest)}; excess ${formatInr(totalInterest - admissibleInterest)} is not deductible.`,
      );
    }
  } else {
    // Let-out / deemed-let-out: full interest admissible under 24(b) — a loss is
    // allowed and is then subject to the s.71(3A) set-off cap at the aggregate.
    notes.push(`Interest of ${formatInr(totalInterest)} admissible in full under 24(b) for let-out/deemed-let-out.`);
  }

  const income = Math.max(0, navAfterStd30) - admissibleInterest;
  const loss = income < 0 ? -income : 0;

  methodology.push(
    `Total deduction u/s 24: ${formatInr(admissibleInterest)} (interest ${formatInr(admissibleInterest)}; pre-construction apportioned).`,
  );
  methodology.push(`Income/loss from house property: ${formatInr(income)} (loss ${formatInr(loss)}).`);

  if (input.tdsDeductedByLender != null && input.tdsDeductedByLender > 0) {
    methodology.push(
      `Note: TDS u/s 194(ix) deducted by lender ${formatInr(input.tdsDeductedByLender)}; credit claimed elsewhere.`,
    );
  }
  if (input.actualExpenses != null && input.actualExpenses > 0) {
    methodology.push(
      `Actual expenses ${formatInr(input.actualExpenses)} noted; 24(a) standard deduction of 30% applies by default; actual-expense election is not modeled here unless the law permits for this status.`,
    );
  }
  if (input.notes) {
    notes.push(input.notes);
  }

  return {
    id: input.id,
    status: input.status,
    municipalValue: mv,
    fairRent: fr,
    standardRent: sr,
    expectedRent: er,
    rentReceived: rr,
    municipalTaxPaid: mt,
    nav,
    standardDeduction30: std30,
    netAnnualValueAfterStdDed: navAfterStd30,
    interestOnHousingLoan: currentInterest,
    preConstructionInterest: preCon,
    totalDeductionUnder24: admissibleInterest,
    incomeFromHouseProperty: income,
    lossFromHouseProperty: loss,
    notes,
    methodology,
  };
}

// ---------------------------------------------------------------------------
// Aggregate + loss discipline
// ---------------------------------------------------------------------------

export interface HousePropertyAggregateResult {
  ay: string;
  regimeLabel: string;
  properties: PropertyResult[];
  totalNav: number;
  totalStd30: number;
  totalInterestDeductible: number;
  totalIncomeFromHouseProperty: number;
  totalLossFromHouseProperty: number;
  lossCarriedForwardFromPriorYears: number;
  lossSetOffAgainstHousePropertyThisYear: number;
  lossSetOffAgainstOtherHeadsThisYear: number;
  lossToBeCarriedForwardToNextYear: number;
  /** HP income after brought-forward loss set-off (negative when a loss). */
  netIncomeAfterSetOff: number;
  notes: string[];
  methodology: string[];
}

export function computeHousePropertyAggregate(
  input: HousePropertyAggregateInput,
  priorYearLossBroughtForward: number,
  priorYearLossAlreadySetOffInPriorYears?: number,
): HousePropertyAggregateResult {
  const props = input.properties.map(computeProperty);
  const totalNav = props.reduce((s, p) => s + p.nav, 0);
  const totalStd30 = props.reduce((s, p) => s + p.standardDeduction30, 0);
  const totalInterestDeductible = props.reduce((s, p) => s + p.totalDeductionUnder24, 0);
  const totalIncomeFromHP = props.reduce((s, p) => s + p.incomeFromHouseProperty, 0);
  const currentYearLoss = Math.max(0, -totalIncomeFromHP);

  const notes: string[] = [];
  const methodology: string[] = [
    `AY ${input.ay}; regime ${input.regimeLabel}.`,
    `${props.length} house property(ies).`,
    `Aggregate NAV ${formatInr(totalNav)}; 30% standard deduction ${formatInr(totalStd30)}.`,
    `Aggregate deductible interest u/s 24(b) ${formatInr(totalInterestDeductible)}.`,
    `Aggregate income from house property (before set-off) ${formatInr(totalIncomeFromHP)}.`,
  ];

  // Prior-year loss brought forward: HP loss can be carried forward for 8 AYs and
  // set off against HP income in a later year. For an individual, the current-year
  // HP loss can also be set off against other heads in the same year only to the
  // extent permitted; this engine flags the restriction.
  const broughtForwardLoss = Math.max(0, priorYearLossBroughtForward);
  const alreadySetOff =
    priorYearLossAlreadySetOffInPriorYears != null ? Math.max(0, priorYearLossAlreadySetOffInPriorYears) : 0;
  const remainingBfLoss = Math.max(0, broughtForwardLoss - alreadySetOff);
  // s.71(3A): an individual/HUF may set off a current-year house-property loss
  // against other heads only up to ₹2,00,000 in the year. The balance is
  // carried forward for 8 AYs and set off only against house-property income.
  const otherHeadsCap = Math.max(0, Math.round(input.otherHeadsSetOffCap ?? INR(200000)));

  let lossSetOffAgainstHP = 0;
  const lossSetOffAgainstOtherHeadsThisYear = Math.min(currentYearLoss, otherHeadsCap);
  let lossToBeCarriedForward = 0;

  if (totalIncomeFromHP >= 0) {
    // Current year HP income can absorb prior-year HP loss.
    lossSetOffAgainstHP = Math.min(remainingBfLoss, totalIncomeFromHP);
    const netAfterBfSetOff = totalIncomeFromHP - lossSetOffAgainstHP;
    notes.push(
      `Current-year HP income ${formatInr(totalIncomeFromHP)} set off against brought-forward HP loss ${formatInr(remainingBfLoss)} => set off ${formatInr(lossSetOffAgainstHP)}; net HP income after set-off ${formatInr(netAfterBfSetOff)}.`,
    );
    methodology.push(
      `Set off brought-forward HP loss ${formatInr(lossSetOffAgainstHP)} against current HP income ${formatInr(totalIncomeFromHP)}; net HP income after set-off ${formatInr(netAfterBfSetOff)}.`,
    );
    lossToBeCarriedForward = remainingBfLoss - lossSetOffAgainstHP;
  } else {
    // Current year is itself a loss.
    const currentYearLossAmount = currentYearLoss;
    notes.push(
      `Current year is a house property loss of ${formatInr(currentYearLossAmount)}: ${formatInr(lossSetOffAgainstOtherHeadsThisYear)} set off against other heads (s.71(3A) cap ${formatInr(otherHeadsCap)}); the balance is carried forward for 8 AYs and set off only against house-property income.`,
    );
    methodology.push(
      `Current-year HP loss ${formatInr(currentYearLossAmount)}: set off against other heads ${formatInr(lossSetOffAgainstOtherHeadsThisYear)} (cap ${formatInr(otherHeadsCap)}).`,
    );
    // Carry forward the part of the current-year loss that could not be set off
    // in the year, plus any unabsorbed brought-forward loss.
    lossToBeCarriedForward = currentYearLossAmount - lossSetOffAgainstOtherHeadsThisYear + remainingBfLoss;
  }

  if (lossToBeCarriedForward > 0) {
    notes.push(
      `Loss to be carried forward to next 8 AYs: ${formatInr(lossToBeCarriedForward)} (current-year loss ${formatInr(currentYearLoss)} + unabsorbed brought-forward ${formatInr(Math.max(0, remainingBfLoss - lossSetOffAgainstHP))}).`,
    );
    methodology.push(`Loss carried forward to next 8 AYs: ${formatInr(lossToBeCarriedForward)}.`);
  }

  if (input.properties.some((p) => p.status === "self-occupied")) {
    const soCount = input.properties.filter((p) => p.status === "self-occupied").length;
    if (soCount > 1 && input.electOneSelfOccupiedAsNil !== true) {
      notes.push(
        `More than one self-occupied property (${soCount}) provided; the regime permitting one self-occupied at nil/low income and deeming the rest let-out must be applied by the firm before filing.`,
      );
    }
  }

  return {
    ay: input.ay,
    regimeLabel: input.regimeLabel,
    properties: props,
    totalNav,
    totalStd30,
    totalInterestDeductible,
    totalIncomeFromHouseProperty: totalIncomeFromHP,
    totalLossFromHouseProperty: currentYearLoss,
    lossCarriedForwardFromPriorYears: broughtForwardLoss,
    lossSetOffAgainstHousePropertyThisYear: lossSetOffAgainstHP,
    lossSetOffAgainstOtherHeadsThisYear: lossSetOffAgainstOtherHeadsThisYear,
    lossToBeCarriedForwardToNextYear: lossToBeCarriedForward,
    netIncomeAfterSetOff: totalIncomeFromHP - lossSetOffAgainstHP,
    notes,
    methodology,
  };
}

export { formatInr, INR };
