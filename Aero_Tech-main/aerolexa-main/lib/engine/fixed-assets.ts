/**
 * Fixed asset register engine — one asset lifecycle, two depreciation regimes.
 *
 * The register a CA maintains for every client: assets with their acquisition
 * details, the COMPANIES ACT book depreciation (Schedule II useful lives) for
 * the balance sheet, and the INCOME TAX block WDV for the tax computation.
 * The two regimes answer different questions and must never be conflated —
 * `depreciation.ts` holds the pure arithmetic; this module keeps the ASSET
 * ledger: acquisition, put-to-use, disposal (with the book gain/loss and the
 * tax u/s 50 outcome) and the roll-forward from opening to closing net block.
 *
 * SCOPE AND HONESTY — useful lives and block rates are DATA supplied by the
 * caller (labelled defaults are re-exported). Book WDV is per ASSET; tax WDV
 * is per BLOCK — an asset sold out of a tax block does not book a loss against
 * itself; only sale proceeds exceeding the whole block are a gain u/s 50. The
 * tax side's opening WDV per block is caller-supplied (`taxOpeningWdv`) when a
 * real block ledger exists; otherwise it is DERIVED from the asset rows and
 * the result is flagged in methodology — an approximation a CA must confirm.
 *
 * Money is in MINOR UNITS (paise) as integers.
 */

import {
  COMPANIES_ACT_USEFUL_LIVES,
  companiesActDepreciation,
  INCOME_TAX_BLOCK_RATES,
  incomeTaxDepreciation,
  type UsefulLifeClass,
} from "./depreciation";
import { formatInr } from "./india-tax";

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    throw new AssetRegisterError(`Invalid date — expected yyyy-mm-dd (got "${fromIso}" .. "${toIso}").`);
  }
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

export class AssetRegisterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetRegisterError";
  }
}

export { COMPANIES_ACT_USEFUL_LIVES, INCOME_TAX_BLOCK_RATES };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface Asset {
  id: string;
  name: string;
  /** Acquisition cost, minor units. */
  cost: number;
  acquisitionDate: string;
  /** Date first put to use (drives the tax half-year rule). */
  putToUseDate: string;
  /** Companies Act useful-life class id (see COMPANIES_ACT_USEFUL_LIVES). */
  bookClass: string;
  /** Income-tax block id (see INCOME_TAX_BLOCK_RATES). */
  taxBlock: string;
  /** Accumulated BOOK depreciation brought forward to the FY start. */
  openingBookDepreciation: number;
  /** Omit for assets still in use. */
  disposal?: { date: string; saleProceeds: number } | null;
}

export interface AssetRegisterInput {
  assets: Asset[];
  /** Financial year, "2025-26" style. */
  fy: string;
  /** Book depreciation method. Default "slm". */
  method?: "slm" | "wdv";
  /** Residual value as % of cost (Schedule II ceiling 5). Default 5. */
  residualPct?: number;
  /** Tax opening WDV per block id, minor units. Supply when a block ledger exists. */
  taxOpeningWdv?: Record<string, number>;
  /** 32(1)(iia) additional depreciation rate on eligible plant; omit = none. */
  additionalDepreciationPct?: number;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface AssetRow {
  assetId: string;
  name: string;
  disposed: boolean;
  book: {
    openingWdv: number;
    depreciation: number;
    /** WDV over proceeds on disposal (positive = loss, negative = book gain). */
    disposalEffect: number;
    closingWdv: number;
    usefulLifeYears: number;
    residual: number;
  };
  tax: {
    block: string;
    blockRatePct: number;
    /** This asset's cost as a block addition (full-rate or half-rate bucket). */
    addition: number;
    halfRate: boolean;
  };
  methodology: string[];
}

export interface AssetRegisterResult {
  fy: string;
  rows: AssetRow[];
  book: { openingNetBlock: number; depreciation: number; disposalEffect: number; closingNetBlock: number };
  taxBlocks: {
    block: string;
    ratePct: number;
    openingWdv: number;
    openingWdvDerived: boolean;
    fullRateAdditions: number;
    halfRateAdditions: number;
    saleProceeds: number;
    depreciation: number;
    additionalDepreciation: number;
    closingWdv: number;
    shortTermCapitalGain: number;
  }[];
  warnings: string[];
  methodology: string[];
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

function fyBounds(fy: string): { from: string; to: string } {
  const y = Number(fy.slice(0, 4));
  if (!Number.isFinite(y) || !/^\d{4}-\d{2}$/.test(fy)) {
    throw new AssetRegisterError(`fy must look like "2025-26"; got "${fy}".`);
  }
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
}

/** The day AFTER an iso date — the exclusive period end for `daysBetween`. */
function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function buildAssetRegister(input: AssetRegisterInput): AssetRegisterResult {
  const { from, to } = fyBounds(input.fy);
  const method = input.method ?? "slm";
  const residualPct = input.residualPct ?? 5;
  if (residualPct < 0 || residualPct > 5) {
    throw new AssetRegisterError(`Residual ${residualPct}% exceeds the Schedule II 5% ceiling.`);
  }

  const lives = new Map<string, UsefulLifeClass>(COMPANIES_ACT_USEFUL_LIVES.map((c) => [c.id, c] as const));
  const rates = new Map(INCOME_TAX_BLOCK_RATES.map((b) => [b.id, b] as const));

  const rows: AssetRow[] = [];
  const warnings: string[] = [];
  let bookOpening = 0;
  let bookDepreciation = 0;
  let bookDisposalEffect = 0;

  // ---- book side: per asset ------------------------------------------------
  for (const asset of input.assets) {
    const lifeClass = lives.get(asset.bookClass);
    if (!lifeClass) throw new AssetRegisterError(`Unknown book class "${asset.bookClass}" for asset ${asset.id}.`);
    const block = rates.get(asset.taxBlock);
    if (!block) throw new AssetRegisterError(`Unknown tax block "${asset.taxBlock}" for asset ${asset.id}.`);
    if (asset.cost < 0) throw new AssetRegisterError(`Asset ${asset.id} cost cannot be negative.`);

    // An asset sold before the FY started, or bought after it ended, is not part
    // of this year's register at all — carrying it here would post a full
    // year's depreciation or a fictitious disposal effect.
    if (asset.disposal && asset.disposal.date < from) {
      warnings.push(
        `Asset ${asset.id} was disposed on ${asset.disposal.date}, before FY ${input.fy} — excluded from this register.`,
      );
      continue;
    }
    if (asset.acquisitionDate > to) {
      warnings.push(
        `Asset ${asset.id} was acquired on ${asset.acquisitionDate}, after FY ${input.fy} — excluded from this register.`,
      );
      continue;
    }

    // The underlying daysBetween treats the end date as EXCLUSIVE, so a
    // full-FY charge runs to the day after the FY end (inclusive Mar 31), and
    // a disposal charges through the disposal date inclusive.
    const depFrom = asset.acquisitionDate > from ? asset.acquisitionDate : from;
    const depTo = asset.disposal ? nextDay(asset.disposal.date < to ? asset.disposal.date : to) : nextDay(to);
    if (depTo <= depFrom) {
      throw new AssetRegisterError(`Asset ${asset.id}: nothing to depreciate between ${depFrom} and ${depTo}.`);
    }

    const openingWdv = asset.cost - asset.openingBookDepreciation;
    if (openingWdv < 0) {
      throw new AssetRegisterError(
        `Asset ${asset.id}: accumulated book depreciation ${formatInr(asset.openingBookDepreciation)} exceeds cost ${formatInr(asset.cost)}.`,
      );
    }

    const dep = companiesActDepreciation({
      cost: asset.cost,
      usefulLifeYears: lifeClass.usefulLifeYears,
      method,
      residualValuePct: residualPct,
      // Under WDV the charge runs on the carrying amount, not on cost again.
      openingWdv,
      from: depFrom,
      to: depTo,
    });

    let closingWdv = openingWdv - dep.periodDepreciation;
    let disposalEffect = 0;
    if (asset.disposal) {
      disposalEffect = closingWdv - Math.max(0, Math.round(asset.disposal.saleProceeds));
      closingWdv = 0;
    }

    bookOpening += openingWdv;
    bookDepreciation += dep.periodDepreciation;
    bookDisposalEffect += disposalEffect;

    // Mirror incomeTaxDepreciation's convention exactly: days counted
    // INCLUSIVELY from put-to-use through 31 March, so 3 October is the last
    // full-rate day (exactly 180 days).
    const halfRate =
      asset.putToUseDate >= from && asset.putToUseDate <= to && daysBetween(asset.putToUseDate, to) + 1 < 180;
    rows.push({
      assetId: asset.id,
      name: asset.name,
      disposed: Boolean(asset.disposal),
      book: {
        openingWdv,
        depreciation: dep.periodDepreciation,
        disposalEffect,
        closingWdv,
        usefulLifeYears: lifeClass.usefulLifeYears,
        residual: dep.residualValue,
      },
      tax: {
        block: asset.taxBlock,
        blockRatePct: block.ratePct,
        addition: asset.cost,
        halfRate,
      },
      methodology: [
        `Book (Schedule II ${method.toUpperCase()}): cost ${formatInr(asset.cost)}, "${lifeClass.name}" (${lifeClass.usefulLifeYears}y), residual ${formatInr(dep.residualValue)} (${residualPct}% of cost, ceiling 5%).`,
        `Charged ${depFrom} → ${depTo} (${dep.days} days) on the opening carrying amount ${formatInr(openingWdv)}: ${formatInr(dep.periodDepreciation)}; closing WDV ${formatInr(closingWdv)}.`,
        asset.disposal
          ? `Disposal ${asset.disposal.date} for ${formatInr(asset.disposal.saleProceeds)}: book ${disposalEffect >= 0 ? "loss" : "gain"} ${formatInr(Math.abs(disposalEffect))}. Tax treatment follows the BLOCK, not this asset.`
          : `Tax block "${asset.taxBlock}" @ ${block.ratePct}%${halfRate ? " — half rate (put to use < 180 days, counted inclusively)" : ""}.`,
      ],
    });
  }

  // ---- tax side: block roll-forward ----------------------------------------
  const blockIds = [...new Set(input.assets.map((a) => a.taxBlock))];
  const taxBlocks = blockIds.map((blockId) => {
    const rate = rates.get(blockId)!;
    const callerOpening = input.taxOpeningWdv?.[blockId];
    // Everything in use BEFORE the FY start was in the block on day one —
    // including an asset sold during the year, whose proceeds then reduce the
    // block. Excluding it would turn a ₹6,00,000 sale out of a ₹10,00,000 block
    // into a ₹6,00,000 s.50 gain.
    const derivedOpening = input.assets
      .filter((a) => a.taxBlock === blockId && a.putToUseDate < from)
      .reduce((s, a) => s + Math.max(0, a.cost - a.openingBookDepreciation), 0);
    const openingWdvDerived = callerOpening === undefined;
    const openingWdv = Math.max(0, Math.round(callerOpening ?? derivedOpening));

    // An asset bought and sold inside the same year is not a block addition in
    // this model: only its proceeds reach the block. This is the conventional
    // treatment and is disclosed in the methodology.
    const additions = input.assets
      .filter(
        (a) =>
          a.taxBlock === blockId &&
          a.putToUseDate >= from &&
          a.putToUseDate <= to &&
          !(a.disposal && a.disposal.date <= to),
      )
      .map((a) => ({ amount: a.cost, putToUseDate: a.putToUseDate }));

    // Only disposals DURING the FY reduce the block; an earlier or later sale
    // belongs to another year's computation.
    const saleProceeds = input.assets
      .filter((a) => a.taxBlock === blockId && a.disposal && a.disposal.date >= from && a.disposal.date <= to)
      .reduce((s, a) => s + Math.max(0, Math.round(a.disposal!.saleProceeds)), 0);

    const roll = incomeTaxDepreciation({
      openingWdv,
      ratePct: rate.ratePct,
      fy: input.fy,
      additions,
      saleProceeds,
      additionalDepreciationPct: input.additionalDepreciationPct,
    });

    if (roll.shortTermCapitalGain > 0) {
      warnings.push(
        `Block "${blockId}": sale proceeds exceed the block by ${formatInr(roll.shortTermCapitalGain)} — short-term capital gain u/s 50; closing block WDV is nil.`,
      );
    }

    return {
      block: blockId,
      ratePct: rate.ratePct,
      openingWdv: roll.openingWdv,
      openingWdvDerived,
      fullRateAdditions: roll.fullRateAdditions,
      halfRateAdditions: roll.halfRateAdditions,
      saleProceeds: roll.saleProceeds,
      depreciation: roll.totalDepreciation,
      additionalDepreciation: roll.additionalDepreciation,
      closingWdv: roll.closingWdv,
      shortTermCapitalGain: roll.shortTermCapitalGain,
    };
  });

  for (const b of taxBlocks) {
    if (b.openingWdvDerived) {
      warnings.push(
        `Block "${b.block}": opening WDV was DERIVED from the asset rows (cost − accumulated book depreciation) because no taxOpeningWdv was supplied. Book WDV and tax WDV diverge by design — confirm against the block ledger before filing.`,
      );
    }
  }

  const bookClosing = rows.reduce((s, r) => s + r.book.closingWdv, 0);

  return {
    fy: input.fy,
    rows,
    book: {
      openingNetBlock: bookOpening,
      depreciation: bookDepreciation,
      disposalEffect: bookDisposalEffect,
      closingNetBlock: bookClosing,
    },
    taxBlocks,
    warnings,
    methodology: [
      `Register roll-forward FY ${input.fy} (${from} .. ${to}); ${input.assets.length} asset(s); book method ${method.toUpperCase()} with residual capped at 5%.`,
      `Book: opening net block ${formatInr(bookOpening)}, depreciation ${formatInr(bookDepreciation)}, closing ${formatInr(bookClosing)}.`,
      `Tax: block WDV — additions put to use ≥ 180 days (counted inclusively to 31 March) take the full rate, < 180 days half; disposals reduce the block, and proceeds over the block are STCG u/s 50.`,
    ],
  };
}
