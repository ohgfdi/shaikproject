/**
 * Capital gains head computation for Indian income-tax returns.
 *
 * This is the authoritative capital-gains layer for the CA firm computation
 * graph. It takes a list of individual transactions/asset entries, routes each
 * to short-term or long-term treatment based on the asset class and holding
 * period, computes indexed cost where the law applies, applies special rates
 * where applicable, and produces the head-level STCG/LTCG totals that feed the
 * tax engine and the ITR schedules.
 *
 * SCOPE AND HONESTY — same rule that governs `india-tax.ts`:
 *
 *   Rates, holding periods, indexation eligibility and grandfathering flags are
 *   DATA supplied by the caller where the law is date-sensitive. The defaults
 *   shipped here are labelled with the assessment year they belong to and are
 *   widely referenced defaults for the common listed-equity / debt / property
 *   cases; the firm must override them when the Finance Act changes a holding
 *   period, rate, or exemption. This engine computes the head totals; it does
 *   not value the transaction, it does not reconstruct the chain of cost, and it
 *   does not issue a legal opinion. Every simplification is named in
 *   `methodology`.
 *
 *   Where the firm has a specific grandfathering basis (for example, for assets
 *   acquired before the relevant cut-off and opted to be taxed in the old
 *   manner), the caller surfaces that basis and the engine honours it on the
 *   arithmetic; it does not invent the grandfathering position.
 *
 * Money is in MINOR UNITS (paise) as integers, matching `india-tax.ts`.
 */

import { INR, formatInr } from "./india-tax";

// ---------------------------------------------------------------------------
// Asset classification
// ---------------------------------------------------------------------------

export type AssetClass =
  | "listed-equity-shares"
  | "equity-oriented-mutual-fund"
  | "listed-debt-securities"
  | "unlisted-shares"
  | "immovable-property"
  | "movable-property"
  | "gold-bonds"
  | "other";

/** Holding for the transaction. */
export interface HoldingPeriod {
  /** Date of acquisition (YYYY-MM-DD). */
  acquisitionDate: string;
  /** Date of transfer (YYYY-MM-DD). */
  transferDate: string;
  /** Computed period in days. */
  daysHeld: number;
  /** Whether classified as long-term for this asset class under the caller's
   * holding-period rules for the AY. */
  longTerm: boolean;
}

/** One capital asset transaction. */
export interface AssetTransaction {
  /** Identifier for the slip/report. */
  id: string;
  /** Asset class. */
  assetClass: AssetClass;
  /** Date of acquisition. */
  acquisitionDate: string;
  /** Date of transfer. */
  transferDate: string;
  /** Full value of consideration (minor units). */
  saleProceeds: number;
  /** Cost of acquisition (minor units); the basis the caller wants taxed. */
  costOfAcquisition: number;
  /** Cost of improvement (minor units). */
  costOfImprovement?: number;
  /** Expenditures wholly and exclusively for the transfer (minor units). */
  expenditureOnTransfer?: number;
  /** Holding period facts. */
  holding: HoldingPeriod;
  /** Whether indexed cost is claimed (only where the law allows indexing for this
   * asset class and holding; the firm must set this correctly). */
  indexedCostClaimed?: boolean;
  /** Indexed cost of acquisition (minor units), when the firm has computed it. */
  indexedCostOfAcquisition?: number;
  /** Indexed cost of improvement (minor units), when the firm has computed it. */
  indexedCostOfImprovement?: number;
  /** Grandfathering basis applicable to this transaction (e.g. the relevant
   * cut-off and the manner in which the cost is taken). Caller-supplied; the
   * engine uses it only as disclosed. */
  grandfatheringBasis?: string;
  /** Whether STT was paid in a manner that attracts the relevant special rate
   * (e.g. 111A/112A context). Caller-supplied. */
  sttPaid?: boolean;
  /** Foreign asset / FIF reporting flag for FA/FSI linkage (informational). */
  foreignAsset?: boolean;
  /** Country of the asset for FA/FSI disclosure. */
  foreignCountry?: string;
  /** Notes for the reviewer. */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Cost and gain computation
// ---------------------------------------------------------------------------

/** Allowable cost for a transaction, based on whether indexing is claimed and
 * the indexed figures provided. */
function allowableCost(t: AssetTransactionWithOverride): number {
  const base = Math.max(0, t.costOfAcquisition);
  const improvement = Math.max(0, t.costOfImprovement ?? 0);
  const transfer = Math.max(0, t.expenditureOnTransfer ?? 0);

  if (t.indexedCostClaimed === true && t.indexedCostOfAcquisition != null && t.indexedCostOfImprovement != null) {
    // Firm has computed indexed figures; use them.
    const indexedAcq = Math.max(0, t.indexedCostOfAcquisition);
    const indexedImp = Math.max(0, t.indexedCostOfImprovement);
    return indexedAcq + indexedImp + transfer;
  }

  return base + improvement + transfer;
}

function netConsideration(t: AssetTransactionWithOverride): number {
  return Math.max(0, t.saleProceeds);
}

function gain(t: AssetTransactionWithOverride): number {
  const sale = netConsideration(t);
  const cost = allowableCost(t);
  return Math.round(sale - cost);
}

// ---------------------------------------------------------------------------
// Special-rate routing
// ---------------------------------------------------------------------------

/** Special rate applicable to this transaction, judgement-made by the firm and
 * passed in. Empty string when taxed at normal rates. */
export type SpecialRateSpec = {
  /** e.g. "111A", "112A", "112", "115AD" as applicable. */
  section: string;
  ratePct: number;
  exemption?: number;
  note?: string;
};

function specialRateFor(t: AssetTransactionWithOverride): SpecialRateSpec | null {
  if (t.specialRateOverride != null) {
    return t.specialRateOverride;
  }
  // Default common route for listed-equity STT context, if the firm opts to use
  // the special rates. This is a DEFAULT the firm must override for the actual AY.
  if (
    (t.assetClass === "listed-equity-shares" || t.assetClass === "equity-oriented-mutual-fund") &&
    t.holding.longTerm &&
    t.sttPaid === true
  ) {
    return {
      section: "112A",
      ratePct: 12.5,
      exemption: INR(1_25_000),
      note: "Listed-equity LTCG u/s 112A default; override for the actual AY.",
    };
  }
  if (
    (t.assetClass === "listed-equity-shares" || t.assetClass === "equity-oriented-mutual-fund") &&
    !t.holding.longTerm &&
    t.sttPaid === true
  ) {
    return {
      section: "111A",
      ratePct: 20,
      note: "Listed-equity STCG u/s 111A default; override for the actual AY.",
    };
  }
  return null;
}

/** Optional caller override for special rate. */
export interface AssetTransactionWithOverride extends Omit<AssetTransaction, "specialRateOverride"> {
  specialRateOverride?: SpecialRateSpec | null;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface CapitalGainHeadInput {
  /** Assessment year. */
  ay: string;
  /** Regime label, for reporting. */
  regimeLabel: string;
  /** Transactions. */
  transactions: AssetTransactionWithOverride[];
  /** Index ratios for the AY, if the firm wants the engine to compute indexed
   * cost from unindexed costs using CII. Optional; the firm commonly passes
   * precomputed indexed costs and leaves this empty. */
  indexRatios?: {
    /** The CII for the year of acquisition. */
    acquisitionYearCii?: number;
    /** The CII for the year of transfer. */
    transferYearCii?: number;
  };
  /** Loss brought forward from prior years, segregated by STCG/LTCG where the
   * firm has it. The engine uses it to compute set-off and carry-forward. */
  lossBroughtForward?: {
    shortTerm: number;
    longTerm: number;
  };
  /** Whether any transaction relates to a foreign asset / FIF reported under
   * Schedule FA/FSI. Informational; the engine flags the head for cross-reference. */
  foreignAssetReporting?: boolean;
}

export interface CapitalGainHeadResult {
  ay: string;
  regimeLabel: string;

  transactions: TransactionResult[];
  totalShortTermCapitalGain: number;
  totalLongTermCapitalGain: number;
  totalCapitalGain: number;

  stcgLossBroughtForwardUtilized: number;
  ltcgLossBroughtForwardUtilized: number;
  netStcgAfterSetOff: number;
  netLtcgAfterSetOff: number;

  stcgLossCarriedForward: number;
  ltcgLossCarriedForward: number;

  foreignAssetFlag: boolean;
  foreignAssetNotes: string[];

  methodology: string[];
}

export interface TransactionResult {
  id: string;
  assetClass: AssetClass;
  holding: HoldingPeriod;
  saleProceeds: number;
  allowableCost: number;
  indexedCostOfAcquisition: number | undefined;
  indexedCostOfImprovement: number | undefined;
  grossGain: number;
  shortTerm: boolean;
  specialRate: SpecialRateSpec | null;
  taxAtSpecialRate: number;
  taxAtNormalRatePlaceholder: number;
  notes: string[];
}

export function computeCapitalGainHead(input: CapitalGainHeadInput): CapitalGainHeadResult {
  const results: TransactionResult[] = [];
  let totalStcg = 0;
  let totalLtcg = 0;

  for (const t of input.transactions) {
    const holding = t.holding;
    const grossGain = gain(t);
    const special = specialRateFor(t);

    let taxAtSpecialRate = 0;
    let taxAtNormalRatePlaceholder = 0;
    const notes: string[] = [];

    if (holding.longTerm) {
      totalLtcg += grossGain;
    } else {
      totalStcg += grossGain;
    }

    if (special != null) {
      const exempt = special.exemption != null ? Math.min(Math.max(0, grossGain), special.exemption) : 0;
      const taxableAtRate = Math.max(0, grossGain - exempt);
      taxAtSpecialRate = Math.round((taxableAtRate * special.ratePct) / 100);
      if (exempt > 0) {
        notes.push(
          `Exemption ${formatInr(exempt)} applied before special rate ${special.section} @ ${special.ratePct}%.`,
        );
      }
      notes.push(
        `Special rate ${special.section} @ ${special.ratePct}% on ${formatInr(taxableAtRate)} = ${formatInr(taxAtSpecialRate)}.`,
      );
      if (special.note) notes.push(special.note);
    } else {
      taxAtNormalRatePlaceholder = Math.max(0, Math.round((grossGain * 30) / 100));
      notes.push("Taxed at slab/normal rate; special-rate routing not applicable for this transaction.");
    }

    if (t.foreignAsset === true) {
      notes.push(`Foreign asset reporting flag set; cross-reference Schedule FA/FSI.`);
    }

    if (t.grandfatheringBasis) {
      notes.push(`Grandfathering basis: ${t.grandfatheringBasis}.`);
    }

    if (t.notes) {
      notes.push(t.notes);
    }

    results.push({
      id: t.id,
      assetClass: t.assetClass,
      holding,
      saleProceeds: netConsideration(t),
      allowableCost: allowableCost(t),
      indexedCostOfAcquisition: t.indexedCostOfAcquisition,
      indexedCostOfImprovement: t.indexedCostOfImprovement,
      grossGain,
      shortTerm: !holding.longTerm,
      specialRate: special,
      taxAtSpecialRate,
      taxAtNormalRatePlaceholder,
      notes,
    });
  }

  // Set-off and carry-forward discipline: STCG and LTCG are kept in separate
  // buckets for set-off purposes under the common discipline. Short-term loss
  // can set off against short-term gain and long-term gain; long-term loss sets
  // off against long-term gain only (the firm must confirm the actual AY rules
  // where they differ and override via its own set-off logic if needed).
  const bfStcg = Math.max(0, input.lossBroughtForward?.shortTerm ?? 0);
  const bfLtcg = Math.max(0, input.lossBroughtForward?.longTerm ?? 0);

  let stcgAfterSetOff = Math.max(0, totalStcg);
  let ltcgAfterSetOff = Math.max(0, totalLtcg);

  const stcgLossUtilized = Math.min(bfStcg, totalStcg + totalLtcg);
  // STCG brought-forward loss sets off first against STCG, then LTCG.
  const stcgLossAgainstStcg = Math.min(bfStcg, totalStcg);
  const remainingStcgLoss = bfStcg - stcgLossAgainstStcg;
  const stcgLossAgainstLtcg = Math.min(remainingStcgLoss, totalLtcg);

  stcgAfterSetOff = Math.max(0, totalStcg - stcgLossAgainstStcg);
  ltcgAfterSetOff = Math.max(0, totalLtcg - stcgLossAgainstLtcg - bfLtcg);
  const ltcgLossUtilized = Math.min(bfLtcg, totalLtcg);

  const stcgLossToCarry = Math.max(0, bfStcg - stcgLossAgainstStcg - stcgLossAgainstLtcg) + Math.max(0, -totalStcg);
  const ltcgLossToCarry = Math.max(0, bfLtcg - ltcgLossUtilized) + Math.max(0, -totalLtcg);

  const foreignNotes: string[] = [];
  if (input.foreignAssetReporting === true) {
    foreignNotes.push("Head flagged for foreign asset / FIF reporting; cross-reference Schedule FA/FSI.");
  }

  const methodology: string[] = [
    `AY ${input.ay}; regime ${input.regimeLabel}.`,
    `${input.transactions.length} transaction(s).`,
    `Total STCG: ${formatInr(totalStcg)}; total LTCG: ${formatInr(totalLtcg)}.`,
    `Set-off of brought-forward losses: STCG loss utilized ${formatInr(stcgLossUtilized)}; LTCG loss utilized ${formatInr(ltcgLossUtilized)}.`,
    `Net STCG after set-off: ${formatInr(stcgAfterSetOff)}; net LTCG after set-off: ${formatInr(ltcgAfterSetOff)}.`,
    `Loss carried forward: STCG ${formatInr(stcgLossToCarry)}; LTCG ${formatInr(ltcgLossToCarry)}.`,
  ];

  if (results.some((r) => r.specialRate != null)) {
    methodology.push("Special-rate transactions present; see per-transaction notes.");
  }

  return {
    ay: input.ay,
    regimeLabel: input.regimeLabel,
    transactions: results,
    totalShortTermCapitalGain: totalStcg,
    totalLongTermCapitalGain: totalLtcg,
    totalCapitalGain: totalStcg + totalLtcg,
    stcgLossBroughtForwardUtilized:
      stcgLossUtilized + ltcgLossUtilized > 0 ? stcgLossAgainstStcg + stcgLossAgainstLtcg : stcgLossUtilized,
    ltcgLossBroughtForwardUtilized: ltcgLossUtilized,
    netStcgAfterSetOff: stcgAfterSetOff,
    netLtcgAfterSetOff: ltcgAfterSetOff,
    stcgLossCarriedForward: stcgLossToCarry,
    ltcgLossCarriedForward: ltcgLossToCarry,
    foreignAssetFlag: input.foreignAssetReporting === true,
    foreignAssetNotes: foreignNotes,
    methodology,
  };
}

export { formatInr, INR };
