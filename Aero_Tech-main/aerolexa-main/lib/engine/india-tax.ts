/**
 * Advanced Indian direct-tax engine — income tax, surcharge, cess and the 87A
 * rebate; HRA exemption; advance tax with interest u/s 234B/234C; corporate tax
 * (normal / 115BAA / 115BAB) with MAT; and listed-equity capital gains.
 *
 * This is the computation layer a CA firm signs off on. It complements
 * `accounting.ts` (which decides what the books say) and `ca-india.ts` (GST,
 * TDS, audit sampling): this decides what the Income-tax Act requires you to
 * pay on those numbers.
 *
 * SCOPE AND HONESTY — the same rule that governs `ca-india.ts`:
 *
 *   Rates, slabs, surcharge bands, cess, rebate limits and the standard
 *   deduction are DATA supplied by the caller via per-FY configuration objects.
 *   A hardcoded table is how tax software produces confidently wrong returns
 *   the month a Finance Act lands; passing the regime and FY makes that
 *   staleness the caller's to own, which is where it belongs.
 *
 *   This engine COMPUTES liability. It does not file a return, does not read
 *   the ITR/JSON utility schema, and does not model every deeming provision of
 *   the Act. Every simplification is named in `methodology` on the result.
 *
 *   Money is in MINOR UNITS (paise) as integers, matching `accounting.ts`, so a
 *   total never drifts and the surcharge→cess chain stays exact.
 *
 *   Per-FY configs live as named exports. New configs are added when the
 *   Finance Act changes; old ones are kept for backward compatibility.
 */

/** Minor‑unit (paise) conversion. */
export const INR = (rupees: number): number => Math.round(rupees * 100);
/** Rupees → minor units, rounding once at the boundary. */
export const toRupees = (minor: number): number => minor / 100;

/** Format minor units with Indian digit grouping, e.g. 1234567.00 → 12,34,567.00. */
export function formatInr(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  const digits = String(rupees);
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    grouped = `${rest},${last3}`;
  }
  const s = paise === 0 ? grouped : `${grouped}.${String(paise).padStart(2, "0")}`;
  return negative ? `-${s}` : s;
}

/** GSTIN validation (unchanged). */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;
export function isValidGstin(gstin: string): boolean {
  return GSTIN_RE.test(gstin);
}
export function gstinStateCode(gstin: string): string | null {
  return GSTIN_RE.test(gstin) ? gstin.slice(0, 2) : null;
}

/** Tax error class. */
export class TaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxError";
  }
}

/* ====================================================================== */
/* Per‑FY tax regime configuration                                          */
/* Each config is labelled with the Finance Act that introduced it.       */
/* ====================================================================== */

/** A slab: `upTo` is the inclusive upper bound in minor units; null = no limit. */
export interface Slab {
  upTo: number | null;
  ratePct: number;
}

/** A surcharge band: applies when income is strictly ABOVE `above` (minor units). */
export interface SurchargeBand {
  above: number;
  ratePct: number;
}

/** Rebate config for section 87A. */
export interface RebateConfig {
  threshold: number; // taxable-income threshold in minor units
  maxRebate: number; // maximum rebate amount in minor units
  marginalRelief: boolean; // true = new-regime marginal relief (no ₹7L cliff)
}

/** Full tax‑regime description for one assessment year. */
export interface TaxRegime {
  id: string; // e.g. "new-2025-26"
  label: string; // display label
  ay: string; // assessment year, e.g. "2025-26"
  slabs: Slab[]; // slab table in minor units
  surcharge: SurchargeBand[]; // surcharge bands
  cessPct: number; // health & education cess %
  rebate?: RebateConfig; // 87A rebate config (undefined for old regime without it)
  standardDeduction: number; // standard deduction in minor units (0 = not applicable)
}

/* ------------------------------------------------------------------ */
/* FY 2025-26 — New regime (section 115BAC)                            */
/* Finance Act 2025 (assented 29 March 2025). These are the rates for  */
/* income of FY 2025-26, i.e. AY 2026-27; `ay` below carries the FY     */
/* label used throughout this engine.                                  */
/*   0–4L nil, 4–8L 5%, 8–12L 10%, 12–16L 15%, 16–20L 20%,            */
/*   20–24L 25%, above 24L 30%                                          */
/*   87A rebate: ₹60,000 where total income ≤ ₹12L (the rebate wipes    */
/*   out the slab tax at ₹12L: 20,000 + 40,000 = 60,000), with          */
/*   marginal relief so income just above ₹12L never pays more tax      */
/*   than the excess over ₹12L.                                         */
/* ------------------------------------------------------------------ */
export const NEW_REGIME_2025_26: TaxRegime = {
  id: "new-2025-26",
  label: "New regime (section 115BAC, default taxation)",
  ay: "2025-26",
  slabs: [
    { upTo: INR(400000), ratePct: 0 }, // 0–4L
    { upTo: INR(800000), ratePct: 5 }, // 4–8L
    { upTo: INR(1200000), ratePct: 10 }, // 8–12L
    { upTo: INR(1600000), ratePct: 15 }, // 12–16L
    { upTo: INR(2000000), ratePct: 20 }, // 16–20L
    { upTo: INR(2400000), ratePct: 25 }, // 20–24L
    { upTo: null, ratePct: 30 }, // ≥24L
  ],
  surcharge: [
    { above: INR(5000000), ratePct: 10 }, // >₹50L
    { above: INR(10000000), ratePct: 15 }, // >₹1Cr
    { above: INR(20000000), ratePct: 25 }, // >₹2Cr (new regime caps at 25%)
  ],
  cessPct: 4,
  rebate: {
    threshold: INR(1200000), // ₹12,00,000
    maxRebate: INR(60000), // ₹60,000
    marginalRelief: true, // no cliff just above ₹12L
  },
  standardDeduction: INR(75000), // ₹75,000 for salary/pension (new regime)
};

/* ------------------------------------------------------------------ */
/* FY 2025-26 (AY) — Old regime                                         */
/* Pre-existing regime with 80C/80D/80TTA caps. Rates unchanged from base law. */
/* ------------------------------------------------------------------ */
export const OLD_REGIME_2025_26: TaxRegime = {
  id: "old-2025-26",
  label: "Old / existing regime",
  ay: "2025-26",
  slabs: [
    { upTo: INR(250000), ratePct: 0 }, // 0–2.5L
    { upTo: INR(500000), ratePct: 5 }, // 2.5–5L
    { upTo: INR(1000000), ratePct: 20 }, // 5–10L
    { upTo: null, ratePct: 30 }, // ≥10L
  ],
  surcharge: [
    { above: INR(5000000), ratePct: 10 }, // >₹50L
    { above: INR(10000000), ratePct: 15 }, // >₹1Cr
    { above: INR(20000000), ratePct: 25 }, // >₹2Cr
    { above: INR(50000000), ratePct: 37 }, // >₹5Cr
  ],
  cessPct: 4,
  // 87A rebate: up to ₹12,500 for taxable income ≤₹5L, no marginal relief
  rebate: {
    threshold: INR(500000), // ₹5,00,000
    maxRebate: INR(12500), // ₹12,500
    marginalRelief: false, // old regime: cliff at the threshold
  },
  standardDeduction: INR(50000), // ₹50,000 for salary/pension (old regime)
};

/* ------------------------------------------------------------------ */
/* FY 2024-25 — retained so prior-year computations and rectifications  */
/* use the rates that actually applied to that year.                   */
/* New regime: 0–3L nil, 3–7L 5%, 7–10L 10%, 10–12L 15%, 12–15L 20%,  */
/* above 15L 30%; 87A rebate ₹25,000 up to ₹7L with marginal relief.    */
/* ------------------------------------------------------------------ */
export const NEW_REGIME_2024_25: TaxRegime = {
  id: "new-2024-25",
  label: "New regime (section 115BAC, FY 2024-25)",
  ay: "2024-25",
  slabs: [
    { upTo: INR(300000), ratePct: 0 },
    { upTo: INR(700000), ratePct: 5 },
    { upTo: INR(1000000), ratePct: 10 },
    { upTo: INR(1200000), ratePct: 15 },
    { upTo: INR(1500000), ratePct: 20 },
    { upTo: null, ratePct: 30 },
  ],
  surcharge: [
    { above: INR(5000000), ratePct: 10 },
    { above: INR(10000000), ratePct: 15 },
    { above: INR(20000000), ratePct: 25 },
  ],
  cessPct: 4,
  rebate: {
    threshold: INR(700000),
    maxRebate: INR(25000),
    marginalRelief: true,
  },
  standardDeduction: INR(75000),
};

export const OLD_REGIME_2024_25: TaxRegime = {
  ...OLD_REGIME_2025_26,
  id: "old-2024-25",
  label: "Old / existing regime (FY 2024-25)",
  ay: "2024-25",
};

/* ------------------------------------------------------------------ */
/* All individual regimes, keyed by "new" | "old" for the API surface. */
/* ------------------------------------------------------------------ */
export const INDIVIDUAL_REGIMES: Record<string, TaxRegime> = {
  new: NEW_REGIME_2025_26,
  old: OLD_REGIME_2025_26,
};

/** Regime tables by financial year, for prior-year and rectification work. */
export const INDIVIDUAL_REGIMES_BY_FY: Record<string, { new: TaxRegime; old: TaxRegime }> = {
  "2024-25": { new: NEW_REGIME_2024_25, old: OLD_REGIME_2024_25 },
  "2025-26": { new: NEW_REGIME_2025_26, old: OLD_REGIME_2025_26 },
};

/* ------------------------------------------------------------------ */
/* Core arithmetic (unchanged but now FY‑aware)                       */
/* ------------------------------------------------------------------ */

/** Slab tax before surcharge, cess or rebate. Rounds once, at the end. */
export function slabTax(income: number, slabs: Slab[]): number {
  if (income <= 0) return 0;
  let tax = 0;
  let lower = 0;
  for (const slab of slabs) {
    const upper = slab.upTo ?? Number.POSITIVE_INFINITY;
    if (income > lower) {
      const taxable = Math.min(income, upper) - lower;
      tax += (taxable * slab.ratePct) / 100;
    }
    lower = upper;
    if (income <= upper) break;
  }
  return Math.round(tax);
}

/** Highest surcharge band that applies to an income (bands are strictly-above). */
function highestBand(income: number, bands: SurchargeBand[]): SurchargeBand | null {
  let band: SurchargeBand | null = null;
  for (const b of [...bands].sort((a, b) => a.above - b.above)) {
    if (income > b.above) band = b;
  }
  return band;
}

/** Surcharge at a given income, BEFORE marginal relief. */
function rawSurcharge(
  income: number,
  baseTax: number,
  bands: SurchargeBand[],
): { band: SurchargeBand | null; amount: number } {
  const band = highestBand(income, bands);
  if (!band || baseTax <= 0) return { band: null, amount: 0 };
  return { band, amount: Math.round((baseTax * band.ratePct) / 100) };
}

/**
 * Surcharge with marginal relief, then cess on the surcharged tax.
 *
 * Marginal relief: the income-tax plus surcharge on an income just above a
 * band threshold may not exceed the income-tax plus surcharge at the threshold
 * (which itself carries the LOWER band's surcharge) plus the income above the
 * threshold. That is exactly what is compared here — the `taxAt` callback must
 * return the tax BEFORE surcharge at any income, so the threshold surcharge is
 * added back in rather than silently ignored.
 */
function surchargeAndCess(opts: {
  bandBase: number;
  baseTax: number;
  bands: SurchargeBand[];
  cessPct: number;
  /** Slab/rate tax (before surcharge) at an income level. */
  taxAt: (income: number) => number;
}): { surcharge: number; bandPct: number; marginalRelief: number; cess: number } {
  const { band, amount: raw } = rawSurcharge(opts.bandBase, opts.baseTax, opts.bands);
  let surcharge = 0;
  let bandPct = 0;
  let marginalRelief = 0;

  if (band) {
    bandPct = band.ratePct;
    const thresholdTax = opts.taxAt(band.above);
    const thresholdSurcharge = rawSurcharge(band.above, thresholdTax, opts.bands).amount;
    const cap = thresholdTax + thresholdSurcharge + (opts.bandBase - band.above);
    if (opts.baseTax + raw > cap) {
      surcharge = Math.max(0, cap - opts.baseTax);
      marginalRelief = raw - surcharge;
    } else {
      surcharge = raw;
    }
  }

  const cess = Math.round(((opts.baseTax + surcharge) * opts.cessPct) / 100);
  return { surcharge, bandPct, marginalRelief, cess };
}

/* ------------------------------------------------------------------ */
// Income tax (individual / HUF)
// ------------------------------------------------------------------ //

/** Chapter VI-A line items as claimed. All amounts in minor units. */
export interface ChapterVIAInput {
  /** 80C + 80CCC + 80CCD(1) — the three share one ₹1.5L cap. */
  section80C?: number;
  /** 80CCD(1B) — additional NPS, ₹50,000 cap over and above 80C. */
  section80CCD1B?: number;
  /** 80CCD(2) — employer NPS; allowed in BOTH regimes. */
  section80CCD2?: number;
  /** 80D — medical insurance + preventive health check-up. */
  section80D?: number;
  section80DD?: number;
  section80DDB?: number;
  section80E?: number;
  section80EE?: number;
  section80EEA?: number;
  section80G?: number;
  section80GG?: number;
  section80GGC?: number;
  section80TTA?: number;
  section80TTB?: number;
  section80U?: number;
  /** Anything else the firm has already validated (e.g. 80CCH, 80JJAA). */
  other?: number;
}

/** A deduction actually allowed, with the cap that produced it. */
export interface ChapterVIALine {
  section: string;
  claimed: number;
  allowed: number;
  note?: string;
}

export interface IncomeTaxResult {
  regimeId: string;
  ay: string;
  grossIncome: number;
  deductions: number;
  /** Claimed Chapter VI-A before caps. */
  deductionsClaimed: number;
  deductionLines: ChapterVIALine[];
  standardDeduction: number;
  taxableIncome: number;
  /** Income taxed at slab (normal) rates — taxable income less special-rate income. */
  normalIncome: number;
  /** Income taxed at special rates (111A/112A/112 etc.) included in taxableIncome. */
  specialRateIncome: number;
  specialRateTax: number;
  slabTax: number;
  rebate: number;
  /** Marginal relief granted at the 87A rebate threshold (new regime cliff). */
  rebateMarginalRelief: number;
  taxAfterRebate: number;
  surcharge: number;
  surchargeBandPct: number;
  surchargeMarginalRelief: number;
  cess: number;
  totalTax: number;
  /** totalTax ÷ grossIncome, as a percentage. */
  effectiveRatePct: number;
  methodology: string[];
}

/** FY 2025-26 Chapter VI-A caps (Finance Act 2025), minor units. */
export const CHAPTER_VIA_CAPS_2025_26 = {
  section80C: INR(150000),
  section80CCD1B: INR(50000),
  section80D: INR(25000),
  section80DD: INR(75000),
  section80DDB: INR(40000),
  section80EE: INR(50000),
  section80EEA: INR(150000),
  section80GG: INR(60000),
  section80TTA: INR(10000),
  section80TTB: INR(50000),
  section80U: INR(75000),
};

/** Apply the statutory caps to a Chapter VI-A claim (old regime). */
function chapterVIAAllowed(
  claimed: ChapterVIAInput,
  opts: { seniorCitizen?: boolean; cap80DOverride?: number } = {},
): { total: number; lines: ChapterVIALine[] } {
  const caps = { ...CHAPTER_VIA_CAPS_2025_26 };
  const senior = opts.seniorCitizen === true;
  if (opts.cap80DOverride != null) caps.section80D = Math.max(0, Math.round(opts.cap80DOverride));
  else if (senior) caps.section80D = INR(50000);
  if (senior) {
    caps.section80DD = INR(125000);
    caps.section80DDB = INR(100000);
    caps.section80U = INR(125000);
  }

  // 80TTA is for non-seniors; 80TTB replaces it for senior citizens.
  const ttaCap = senior ? 0 : caps.section80TTA;
  const ttbCap = senior ? caps.section80TTB : 0;

  const rows: Array<{ section: string; amount: number; cap: number; note?: string }> = [
    {
      section: "80C",
      amount: claimed.section80C ?? 0,
      cap: caps.section80C,
      note: "80C + 80CCC + 80CCD(1) share this cap",
    },
    { section: "80CCD(1B)", amount: claimed.section80CCD1B ?? 0, cap: caps.section80CCD1B },
    {
      section: "80CCD(2)",
      amount: claimed.section80CCD2 ?? 0,
      cap: Infinity,
      note: "employer contribution; 10%/14% of salary cap not modelled",
    },
    { section: "80D", amount: claimed.section80D ?? 0, cap: caps.section80D },
    { section: "80DD", amount: claimed.section80DD ?? 0, cap: caps.section80DD },
    { section: "80DDB", amount: claimed.section80DDB ?? 0, cap: caps.section80DDB },
    { section: "80E", amount: claimed.section80E ?? 0, cap: Infinity, note: "interest on education loan — no cap" },
    { section: "80EE", amount: claimed.section80EE ?? 0, cap: caps.section80EE },
    { section: "80EEA", amount: claimed.section80EEA ?? 0, cap: caps.section80EEA },
    {
      section: "80G",
      amount: claimed.section80G ?? 0,
      cap: Infinity,
      note: "qualifying amount and 50%/100% rate determined by the firm",
    },
    {
      section: "80GG",
      amount: claimed.section80GG ?? 0,
      cap: caps.section80GG,
      note: "also limited to 25% of ATI and rent less 10% of ATI",
    },
    { section: "80GGC", amount: claimed.section80GGC ?? 0, cap: Infinity },
    { section: "80TTA", amount: claimed.section80TTA ?? 0, cap: ttaCap },
    { section: "80TTB", amount: claimed.section80TTB ?? 0, cap: ttbCap },
    { section: "80U", amount: claimed.section80U ?? 0, cap: caps.section80U },
    { section: "other", amount: claimed.other ?? 0, cap: Infinity },
  ];

  const lines: ChapterVIALine[] = [];
  let total = 0;
  for (const row of rows) {
    const amount = Math.max(0, Math.round(row.amount));
    if (amount === 0) continue;
    const allowed = Math.min(amount, row.cap);
    total += allowed;
    lines.push({
      section: row.section,
      claimed: amount,
      allowed,
      ...(allowed < amount ? { note: `capped at ${formatInr(row.cap)}` } : row.note ? { note: row.note } : {}),
    });
  }
  return { total, lines };
}

/**
 * Compute individual/HUF income tax.
 *
 * Rules per regime (Finance Act 2025, FY 2025-26):
 *   - New regime (115BAC): 80C/80D/80E/80G/80TTA are NOT allowed; only
 *     80CCD(2) employer NPS (and 80CCH/80JJAA) survive. Standard deduction
 *     ₹75,000 for salary/pension.
 *   - Old regime: each Chapter VI-A section is capped by `chapterVIAAllowed`
 *     when a line-item breakup is supplied (80C ₹1.5L, 80D ₹25K/₹50K,
 *     80TTA ₹10K, 80TTB ₹50K…); 80E/80G are uncapped here because the
 *     qualifying amount is the firm's to determine. Standard deduction ₹50,000.
 *
 * Special-rate income (111A/112A/112…) is modelled explicitly: pass the
 * amount included in taxable income plus its tax, and the slab computation
 * runs only on the normal-rate slice. The 87A rebate is then granted only
 * against normal-rate tax, as the proviso to section 87A requires.
 *
 * Money is in MINOR UNITS (paise). All rounding happens at each statutory
 * amount (slab tax, surcharge, relief, cess), never on intermediate floats.
 */
export function computeIncomeTax(opts: {
  grossIncome: number;
  /** Chapter VI‑A aggregate (minor units). Used only when no breakup is given. */
  deductions?: number;
  /** Chapter VI‑A line items; caps are applied per section. Takes precedence. */
  deductionBreakup?: ChapterVIAInput;
  regime: TaxRegime;
  /** Apply the regime's standard deduction (default true — salary/pension). */
  applyStandardDeduction?: boolean;
  /** Set false to exclude surcharge (e.g. when splitting capital gains). */
  surchargeApplicable?: boolean;
  /** Senior citizen (60+): 80D ₹50K, 80DDB ₹1L, 80TTB instead of 80TTA. */
  seniorCitizen?: boolean;
  /** Override the 80D cap (e.g. self + parents' premium). */
  cap80DOverride?: number;
  /** Resident individuals get the 87A rebate; non-residents do not. */
  residentIndividual?: boolean;
  /** Portion of taxableIncome charged at special rates (111A/112A/112…). */
  specialRateIncome?: number;
  /** Tax on `specialRateIncome`, before rebate/surcharge/cess. */
  specialRateTax?: number;
  /** Agricultural income for partial integration u/s 2(1A)/10(1) (residents). */
  agriculturalIncome?: number;
}): IncomeTaxResult {
  const gross = Math.max(0, Math.round(opts.grossIncome));
  const deductionsInput = Math.max(0, Math.round(opts.deductions ?? 0));
  const specialRateIncome = Math.min(Math.max(0, Math.round(opts.specialRateIncome ?? 0)), gross);
  const specialRateTax = Math.max(0, Math.round(opts.specialRateTax ?? 0));

  // --- Regime‑specific Chapter VI-A filtering ---
  let deductions = 0;
  let deductionsClaimed = 0;
  let deductionLines: ChapterVIALine[] = [];

  if (opts.regime.id.startsWith("new")) {
    // --- NEW REGIME ---
    // Only 80CCD(2) survives; every other Chapter VI-A claim is disallowed.
    const npsEmployer = Math.max(0, Math.round(opts.deductionBreakup?.section80CCD2 ?? 0));
    const other = Math.max(0, Math.round(opts.deductionBreakup?.other ?? 0));
    deductionsClaimed = npsEmployer + other;
    if (npsEmployer > 0) {
      deductionLines.push({ section: "80CCD(2)", claimed: npsEmployer, allowed: npsEmployer });
    }
    if (other > 0) {
      deductionLines.push({
        section: "other",
        claimed: other,
        allowed: other,
        note: "e.g. 80CCH / 80JJAA allowed in the new regime",
      });
    }
    // A lump-sum `deductions` figure is old-regime data and is dropped: the new
    // regime does not permit it and attributing it to 80CCD(2) would invent a
    // deduction the assessee never claimed.
    deductions = npsEmployer + other;
  } else if (opts.deductionBreakup) {
    const allowed = chapterVIAAllowed(opts.deductionBreakup, {
      seniorCitizen: opts.seniorCitizen,
      cap80DOverride: opts.cap80DOverride,
    });
    deductions = allowed.total;
    deductionLines = allowed.lines;
    deductionsClaimed = allowed.lines.reduce((s, l) => s + l.claimed, 0);
  } else {
    // No breakup: the caller has already validated the aggregate against each
    // section. It is passed through unchanged (and labelled as such) rather
    // than having an arbitrary aggregate cap applied to it.
    deductions = deductionsInput;
    deductionsClaimed = deductionsInput;
    if (deductionsInput > 0) {
      deductionLines = [
        {
          section: "aggregate",
          claimed: deductionsInput,
          allowed: deductionsInput,
          note: "caller-vetted total; pass deductionBreakup for per-section caps",
        },
      ];
    }
  }

  // --- Standard deduction u/s 16(ia) ---
  // Default on (salary/pension is the usual basis); cannot exceed gross income.
  const standardDeduction =
    opts.applyStandardDeduction === false ? 0 : Math.min(Math.max(0, Math.round(opts.regime.standardDeduction)), gross);

  const taxableIncome = Math.max(0, gross - standardDeduction - deductions);

  // Slab tax runs on the normal-rate slice only; special-rate tax is added as
  // computed by the caller (it is not a slab rate).
  const normalIncome = Math.max(0, taxableIncome - Math.min(specialRateIncome, taxableIncome));
  const agriculturalIncome = Math.max(0, Math.round(opts.agriculturalIncome ?? 0));

  // Partial integration of agricultural income (resident individuals/HUF):
  // where agricultural income exceeds ₹5,000 and non-agricultural income exceeds
  // the basic exemption limit, the slab is run on (non-agri + agri) and the tax
  // on (exemption limit + agri) is subtracted. The result is the tax on the
  // non-agricultural income at the rates pushed up by the agricultural income.
  let slabOnNormal = slabTax(normalIncome, opts.regime.slabs);
  // Basic exemption limit = the top of the last nil-rate slab.
  const exemptionLimit =
    [...opts.regime.slabs]
      .filter((s) => s.ratePct === 0 && s.upTo != null)
      .map((s) => s.upTo as number)
      .pop() ?? 0;
  const agriIntegrated =
    opts.residentIndividual !== false && agriculturalIncome > INR(5000) && normalIncome > exemptionLimit;
  if (agriIntegrated) {
    const withAgri = slabTax(normalIncome + agriculturalIncome, opts.regime.slabs);
    const exemptionPlusAgri = slabTax(exemptionLimit + agriculturalIncome, opts.regime.slabs);
    slabOnNormal = Math.max(slabOnNormal, withAgri - exemptionPlusAgri);
  }
  const base = slabOnNormal + specialRateTax;

  const methodology: string[] = [
    `Gross income ${formatInr(gross)}; Chapter VI-A ${formatInr(deductions)}` +
      (standardDeduction ? `; standard deduction ${formatInr(standardDeduction)}` : "") +
      ` → taxable income ${formatInr(taxableIncome)}.`,
  ];
  if (specialRateIncome > 0) {
    methodology.push(
      `Special-rate income ${formatInr(specialRateIncome)} excluded from the slab computation; tax at special rates ${formatInr(specialRateTax)}.`,
    );
  }
  if (agriIntegrated) {
    methodology.push(
      `Agricultural income ${formatInr(agriculturalIncome)} partially integrated: slab tax on ${formatInr(normalIncome + agriculturalIncome)} less tax on ${formatInr(exemptionLimit + agriculturalIncome)} = ${formatInr(slabOnNormal)}.`,
    );
  }
  methodology.push(
    `Slab tax on ${formatInr(normalIncome)} = ${formatInr(slabOnNormal)}; total base tax ${formatInr(base)}.`,
  );

  // --- Section 87A rebate ---
  // The rebate is a deduction from the tax on NORMAL-rate income only; the
  // proviso denies it against 112A LTCG (and the slab-rate tax on 111A/112).
  const rebateCfg = opts.regime.rebate;
  const resident = opts.residentIndividual !== false;
  let rebate = 0;
  let rebateMarginalRelief = 0;

  if (rebateCfg && resident && taxableIncome <= rebateCfg.threshold) {
    rebate = Math.min(slabOnNormal, rebateCfg.maxRebate);
  }
  let taxAfterRebate = base - rebate;

  // --- Marginal relief just above the 87A threshold ---
  // Tax payable may not exceed the income above the threshold. Applies only to
  // the new regime (config flag) and only when no special-rate income is in
  // play, since the special-rate tax is not part of the relief comparison.
  if (rebateCfg?.marginalRelief && resident && taxableIncome > rebateCfg.threshold && specialRateIncome === 0) {
    const excess = taxableIncome - rebateCfg.threshold;
    if (taxAfterRebate > excess) {
      rebateMarginalRelief = taxAfterRebate - excess;
      taxAfterRebate = excess;
      methodology.push(
        `Marginal relief at the ${formatInr(rebateCfg.threshold)} rebate threshold: tax capped at income above the threshold (${formatInr(excess)}); relief ${formatInr(rebateMarginalRelief)}.`,
      );
    }
  }

  // --- Surcharge and cess ---
  const taxAt = (t: number) =>
    slabTax(Math.max(0, t - Math.min(specialRateIncome, t)), opts.regime.slabs) + specialRateTax;
  const sc =
    opts.surchargeApplicable === false
      ? {
          surcharge: 0,
          bandPct: 0,
          marginalRelief: 0,
          cess: Math.round((taxAfterRebate * opts.regime.cessPct) / 100),
        }
      : surchargeAndCess({
          bandBase: taxableIncome,
          baseTax: taxAfterRebate,
          bands: opts.regime.surcharge,
          cessPct: opts.regime.cessPct,
          taxAt,
        });

  const totalTax = taxAfterRebate + sc.surcharge + sc.cess;
  if (sc.surcharge > 0) {
    methodology.push(
      `Surcharge at ${sc.bandPct}% = ${formatInr(sc.surcharge)}${sc.marginalRelief > 0 ? ` (marginal relief ${formatInr(sc.marginalRelief)})` : ""}.`,
    );
  }
  methodology.push(`Health & education cess at ${opts.regime.cessPct}% = ${formatInr(sc.cess)}.`);
  methodology.push(`Total tax liability ${formatInr(totalTax)}.`);

  return {
    regimeId: opts.regime.id,
    ay: opts.regime.ay,
    grossIncome: gross,
    deductions,
    deductionsClaimed,
    deductionLines,
    standardDeduction,
    taxableIncome,
    normalIncome,
    specialRateIncome,
    specialRateTax,
    slabTax: base,
    rebate,
    rebateMarginalRelief,
    taxAfterRebate,
    surcharge: sc.surcharge,
    surchargeBandPct: sc.bandPct,
    surchargeMarginalRelief: sc.marginalRelief,
    cess: sc.cess,
    totalTax,
    effectiveRatePct: gross > 0 ? (totalTax / gross) * 100 : 0,
    methodology,
  };
}

/* ------------------------------------------------------------------ */
// HRA exemption u/s 10(13A) — unchanged
/* ------------------------------------------------------------------ */

export interface HraResult {
  exempt: number;
  taxableHra: number;
  components: { hraReceived: number; rentLessTenPctBasic: number; basicShare: number };
  methodology: string[];
}

export function computeHraExemption(opts: {
  salary: number;
  hraReceived: number;
  rentPaid: number;
  metro: boolean;
}): HraResult {
  const salary = Math.max(0, Math.round(opts.salary));
  const hraReceived = Math.max(0, Math.round(opts.hraReceived));
  const rentPaid = Math.max(0, Math.round(opts.rentPaid));
  const rentLessTenPctBasic = Math.max(0, rentPaid - Math.round(salary * 0.1));
  const basicShare = Math.round(salary * (opts.metro ? 0.5 : 0.4));
  const exempt = Math.max(0, Math.min(hraReceived, rentLessTenPctBasic, basicShare));
  return {
    exempt,
    taxableHra: Math.max(0, hraReceived - exempt),
    components: { hraReceived, rentLessTenPctBasic, basicShare },
    methodology: [
      `HRA received ${formatInr(hraReceived)}.`,
      `Rent paid less 10% of salary = ${formatInr(rentLessTenPctBasic)}.`,
      `${opts.metro ? "50%" : "40%"} of salary (${opts.metro ? "metro" : "non-metro"}) = ${formatInr(basicShare)}.`,
      `Exempt = least of the three = ${formatInr(exempt)}; taxable HRA ${formatInr(Math.max(0, hraReceived - exempt))}.`,
    ],
  };
}

/* ------------------------------------------------------------------ */
// Advance tax and interest u/s 234B / 234C
/* ------------------------------------------------------------------ */

export interface AdvanceInstallment {
  label: string;
  dueDate: string;
  cumulativePct: number;
  /** Months the 234C interest runs for a shortfall at this installment. */
  interestMonths: number;
}

/**
 * Standard advance-tax schedule.
 *
 * Due dates are derived from the financial year:
 *   Q1: 15 June of the start year
 *   Q2: 15 September of the start year
 *   Q3: 15 December of the start year
 *   Q4: 15 March of the end year (startYear + 1)
 *
 * For FY 2025-26: 15 Jun 2025, 15 Sep 2025, 15 Dec 2025, 15 Mar 2026.
 */
export function advanceTaxInstallments(fy: string): AdvanceInstallment[] {
  const startYear = Number(fy.slice(0, 4));
  if (!Number.isFinite(startYear)) {
    throw new TaxError(`Financial year must look like "2025-26"; got "${fy}".`);
  }
  return [
    { label: "Q1", dueDate: `${startYear}-06-15`, cumulativePct: 15, interestMonths: 3 },
    { label: "Q2", dueDate: `${startYear}-09-15`, cumulativePct: 45, interestMonths: 3 },
    { label: "Q3", dueDate: `${startYear}-12-15`, cumulativePct: 75, interestMonths: 3 },
    { label: "Q4", dueDate: `${startYear + 1}-03-15`, cumulativePct: 100, interestMonths: 1 },
  ];
}

export interface Interest234CResult {
  perInstallment: {
    label: string;
    dueDate: string;
    required: number;
    paid: number;
    shortfall: number;
    interestMonths: number;
    interest: number;
    /** True when the 12%/36% proviso relieves this installment's shortfall. */
    provisoRelief: boolean;
  }[];
  totalInterest: number;
  /** True when assessed tax is below ₹10,000, so 234C cannot apply. */
  belowThreshold: boolean;
  methodology: string[];
}

/** Cumulative percentage that, once paid, relieves that installment under the 234C proviso. */
const INTEREST_234C_PROVISO_PCT: Record<string, number> = { Q1: 12, Q2: 36, Q3: 75, Q4: 100 };

/**
 * Interest u/s 234C.
 *
 * 1% per month (part month counts as a month) for three months on the shortfall
 * in the first three instalments and for one month on the last, computed on the
 * CUMULATIVE shortfall at each due date. Two statutory brakes apply:
 *   - no interest at all where the assessed tax is below ₹10,000; and
 *   - the proviso: a shortfall in Q1/Q2/Q3/Q4 attracts nothing if at least
 *     12% / 36% / 75% / 100% of the assessed tax had already been paid by that
 *     date (the “12%/36%” relief every practitioner relies on).
 */
export function computeInterest234C(opts: {
  assessedTax: number;
  payments: { date: string; amount: number }[];
  fy: string;
  installments?: AdvanceInstallment[];
}): Interest234CResult {
  const assessedTax = Math.max(0, Math.round(opts.assessedTax));
  const installments = opts.installments ?? advanceTaxInstallments(opts.fy);
  const payments = [...opts.payments].sort((a, b) => a.date.localeCompare(b.date));
  const perInstallment: Interest234CResult["perInstallment"] = [];
  const belowThreshold = assessedTax < INR(10000);
  let totalInterest = 0;

  for (const inst of installments) {
    const required = Math.round((assessedTax * inst.cumulativePct) / 100);
    const paid = payments.filter((p) => p.date <= inst.dueDate).reduce((s, p) => s + p.amount, 0);
    const shortfall = Math.max(0, required - paid);
    const provisoPct = INTEREST_234C_PROVISO_PCT[inst.label] ?? inst.cumulativePct;
    const provisoRelief = shortfall > 0 && paid >= Math.round((assessedTax * provisoPct) / 100);
    const interest = belowThreshold || provisoRelief ? 0 : Math.round((shortfall * inst.interestMonths) / 100);
    totalInterest += interest;
    perInstallment.push({
      label: inst.label,
      dueDate: inst.dueDate,
      required,
      paid,
      shortfall,
      interestMonths: inst.interestMonths,
      interest,
      provisoRelief,
    });
  }

  const methodology: string[] = [
    `Assessed tax ${formatInr(assessedTax)} against the ${installments.map((i) => `${i.cumulativePct}% by ${i.dueDate}`).join(", ")} schedule.`,
  ];
  if (belowThreshold) {
    methodology.push("Assessed tax below ₹10,000 — advance tax is not payable and 234C interest cannot arise.");
  }
  for (const row of perInstallment) {
    if (row.shortfall > 0) {
      methodology.push(
        row.provisoRelief
          ? `${row.label}: shortfall ${formatInr(row.shortfall)} relieved by the 12%/36% proviso (paid ${formatInr(row.paid)} by ${row.dueDate}).`
          : `${row.label}: shortfall ${formatInr(row.shortfall)} × 1% × ${row.interestMonths} month(s) = ${formatInr(row.interest)}.`,
      );
    }
  }
  methodology.push(`Total 234C interest ${formatInr(totalInterest)}.`);

  return { perInstallment, totalInterest, belowThreshold, methodology };
}

/** Whole or part months from `from` (day 1) to `to` — part months count as full. */
function monthsFromFirst(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  if (b <= a) return 0;
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() > 1) months += 1;
  return months;
}

export interface Interest234BResult {
  assessedTax: number;
  advanceTaxPaid: number;
  ninetyPct: number;
  thresholdMet: boolean;
  shortfall: number;
  months: number;
  interest: number;
  methodology: string[];
}

/** Interest u/s 234B: if advance tax paid is less than 90% of assessed tax,
 * 1% per month (or part) runs from 1 April of the assessment year on the
 * shortfall.
 */
export function computeInterest234B(opts: {
  assessedTax: number;
  advanceTaxPaid: number;
  fy: string;
  determinationDate: string;
}): Interest234BResult {
  const assessedTax = Math.max(0, Math.round(opts.assessedTax));
  const advanceTaxPaid = Math.max(0, Math.round(opts.advanceTaxPaid));
  const ninetyPct = Math.round(assessedTax * 0.9);
  const belowThreshold = assessedTax < INR(10000);
  const thresholdMet = belowThreshold || advanceTaxPaid >= ninetyPct;
  const shortfall = thresholdMet ? 0 : Math.max(0, assessedTax - advanceTaxPaid);
  const ayStart = `${Number(opts.fy.slice(0, 4)) + 1}-04-01`;
  const months = thresholdMet ? 0 : monthsFromFirst(ayStart, opts.determinationDate);
  const interest = Math.round((shortfall * months) / 100);
  return {
    assessedTax,
    advanceTaxPaid,
    ninetyPct,
    thresholdMet,
    shortfall,
    months,
    interest,
    methodology: [
      belowThreshold
        ? `Assessed tax ${formatInr(assessedTax)} is below ₹10,000 — 234B interest cannot arise.`
        : thresholdMet
          ? `Advance tax paid ${formatInr(advanceTaxPaid)} ≥ 90% of assessed tax (${formatInr(ninetyPct)}) — no 234B interest.`
          : `Advance tax paid ${formatInr(advanceTaxPaid)} < 90% (${formatInr(ninetyPct)}); shortfall ${formatInr(shortfall)} from ${ayStart} to ${opts.determinationDate} = ${months} month(s).`,
      `1% per month (part month = full month) → interest ${formatInr(interest)}.`,
    ],
  };
}

/* ------------------------------------------------------------------ */
// Corporate tax (domestic company) — unchanged
/* ------------------------------------------------------------------ */

export interface CorporateRegime {
  id: string;
  label: string;
  ay: string;
  ratePct: number;
  surcharge: SurchargeBand[];
  cessPct: number;
  /** MAT rate u/s 115JB, when the regime is subject to it. */
  minimumTaxPct?: number;
}

export const CORPORATE_REGIMES: Record<string, CorporateRegime> = {
  normal: {
    id: "normal",
    label: "Normal domestic company",
    ay: "2025-26",
    ratePct: 30,
    surcharge: [
      { above: INR(10000000), ratePct: 7 },
      { above: INR(100000000), ratePct: 12 },
    ],
    cessPct: 4,
    minimumTaxPct: 15,
  },
  "115BAA": {
    id: "115BAA",
    label: "Domestic company — section 115BAA",
    ay: "2025-26",
    ratePct: 22,
    surcharge: [{ above: 0, ratePct: 10 }],
    cessPct: 4,
  },
  "115BAB": {
    id: "115BAB",
    label: "New manufacturing company — section 115BAB",
    ay: "2025-26",
    ratePct: 15,
    surcharge: [{ above: 0, ratePct: 10 }],
    cessPct: 4,
  },
};

export interface CorporateTaxResult {
  regimeId: string;
  ay: string;
  totalIncome: number;
  /** Base rate actually applied (25% vs 30% turnover test resolved). */
  appliedRatePct: number;
  normalTax: number;
  matTax: number | null;
  bookProfit: number | null;
  applicable: "normal" | "mat";
  baseTax: number;
  surcharge: number;
  surchargeBandPct: number;
  marginalRelief: number;
  cess: number;
  totalTax: number;
  effectiveRatePct: number;
  methodology: string[];
}

interface CorporateTaxAt {
  baseTax: number;
  surcharge: number;
  bandPct: number;
  marginalRelief: number;
  cess: number;
  total: number;
}

function corporateAt(opts: {
  income: number;
  bandBase: number;
  ratePct: number;
  bands: SurchargeBand[];
  cessPct: number;
}): CorporateTaxAt {
  const baseTax = Math.round((opts.income * opts.ratePct) / 100);
  const sc = surchargeAndCess({
    bandBase: opts.bandBase,
    baseTax,
    bands: opts.bands,
    cessPct: opts.cessPct,
    taxAt: (t) => Math.round((t * opts.ratePct) / 100),
  });
  return {
    baseTax,
    surcharge: sc.surcharge,
    bandPct: sc.bandPct,
    marginalRelief: sc.marginalRelief,
    cess: sc.cess,
    total: baseTax + sc.surcharge + sc.cess,
  };
}

/** Turnover ceiling for the 25% domestic-company rate (₹400 crore). */
export const DOMESTIC_25PCT_TURNOVER_LIMIT = INR(4000000000);

/**
 * Compute domestic-company tax under the normal provisions, 115BAA or 115BAB,
 * with MAT u/s 115JB when a book profit is supplied.
 *
 * The normal-provision rate is 30%, reduced to 25% where the relevant previous
 * year's turnover/gross receipts do not exceed ₹400 crore; pass `turnover`
 * (minor units) to have that test resolved here, or override the rate outright.
 * Surcharge is 7% above ₹1 crore and 12% above ₹10 crore with marginal relief;
 * 115BAA/115BAB carry a flat 10% surcharge. Cess is 4% throughout.
 *
 * MAT (15% of book profit) is compared with the normal liability and the higher
 * is returned. MAT does not apply to 115BAA/115BAB companies, which is why only
 * the `normal` regime config carries `minimumTaxPct`.
 */
export function computeCorporateTax(opts: {
  totalIncome: number;
  bookProfit?: number;
  regime: CorporateRegime;
  /** Turnover/gross receipts of the relevant PY (minor units) — 25% rate test. */
  turnover?: number;
  /** Explicit base-rate override (e.g. a caller-validated 25%). */
  ratePctOverride?: number;
}): CorporateTaxResult {
  const totalIncome = Math.max(0, Math.round(opts.totalIncome));

  let ratePct = opts.ratePctOverride ?? opts.regime.ratePct;
  if (opts.ratePctOverride == null && opts.regime.id === "normal" && opts.turnover != null) {
    ratePct = opts.turnover <= DOMESTIC_25PCT_TURNOVER_LIMIT ? 25 : 30;
  }

  const normal = corporateAt({
    income: totalIncome,
    bandBase: totalIncome,
    ratePct,
    bands: opts.regime.surcharge,
    cessPct: opts.regime.cessPct,
  });

  const methodology: string[] = [
    `${opts.regime.label}: ${ratePct}% on ${formatInr(totalIncome)} = ${formatInr(normal.baseTax)}.`,
  ];
  if (opts.ratePctOverride == null && opts.regime.id === "normal" && opts.turnover != null) {
    methodology.push(
      opts.turnover <= DOMESTIC_25PCT_TURNOVER_LIMIT
        ? `Turnover ${formatInr(opts.turnover)} ≤ ₹400 crore — 25% rate applied.`
        : `Turnover ${formatInr(opts.turnover)} > ₹400 crore — 30% rate applied.`,
    );
  }

  let matResult: CorporateTaxAt | null = null;
  let bookProfit: number | null = null;
  if (opts.bookProfit !== undefined && opts.regime.minimumTaxPct) {
    bookProfit = Math.max(0, Math.round(opts.bookProfit));
    // MAT surcharge follows the domestic-company bands (7%/12%).
    matResult = corporateAt({
      income: bookProfit,
      bandBase: bookProfit,
      ratePct: opts.regime.minimumTaxPct,
      bands: opts.regime.surcharge,
      cessPct: opts.regime.cessPct,
    });
    methodology.push(
      `MAT u/s 115JB: ${opts.regime.minimumTaxPct}% on book profit ${formatInr(bookProfit)} = ${formatInr(matResult.total)}.`,
    );
  }

  const useMat = matResult !== null && matResult.total > normal.total;
  const chosen = useMat && matResult ? matResult : normal;
  methodology.push(useMat ? `MAT is higher — payable u/s 115JB.` : `Normal provisions are higher — payable.`);
  methodology.push(
    `Base ${formatInr(chosen.baseTax)} + surcharge ${formatInr(chosen.surcharge)}${chosen.marginalRelief > 0 ? ` (after marginal relief ${formatInr(chosen.marginalRelief)})` : ""} + cess ${formatInr(chosen.cess)} = ${formatInr(chosen.total)}.`,
  );

  return {
    regimeId: opts.regime.id,
    ay: opts.regime.ay,
    totalIncome,
    appliedRatePct: ratePct,
    normalTax: normal.total,
    matTax: matResult ? matResult.total : null,
    bookProfit,
    applicable: useMat ? "mat" : "normal",
    baseTax: chosen.baseTax,
    surcharge: chosen.surcharge,
    surchargeBandPct: chosen.bandPct,
    marginalRelief: chosen.marginalRelief,
    cess: chosen.cess,
    totalTax: chosen.total,
    effectiveRatePct: totalIncome > 0 ? (chosen.total / totalIncome) * 100 : 0,
    methodology,
  };
}

/* ------------------------------------------------------------------ */
// Listed‑equity capital gains (111A / 112A) — unchanged
/* ------------------------------------------------------------------ */

/** Post‑23‑July‑2024 rates: STCG u/s 111A 20%, LTCG u/s 112A 12.5% with a
 * ₹1.25L annual exemption. Pre‑change values (15% / 10% / ₹1L) are supplied
 * by the caller when computing an earlier period.
 */
export const EQUITY_CG_DEFAULTS_2024 = {
  stcgRatePct: 20,
  ltcgRatePct: 12.5,
  ltcgExemption: INR(125000),
};

export interface CapitalGainsResult {
  stcg: number;
  ltcg: number;
  ltcgExemptionApplied: number;
  ltcgTaxable: number;
  stcgTax: number;
  ltcgTax: number;
  surcharge: number;
  cess: number;
  totalTax: number;
  methodology: string[];
}

export function computeEquityCapitalGains(opts: {
  stcg?: number;
  ltcg?: number;
  ltcgExemption?: number;
  stcgRatePct?: number;
  ltcgRatePct?: number;
  /** Surcharge on capital‑gains tax (capped at 15% in law); caller supplies. */
  surchargePct?: number;
  cessPct?: number;
}): CapitalGainsResult {
  const stcg = Math.max(0, Math.round(opts.stcg ?? 0));
  const ltcg = Math.max(0, Math.round(opts.ltcg ?? 0));
  const stcgRatePct = opts.stcgRatePct ?? EQUITY_CG_DEFAULTS_2024.stcgRatePct;
  const ltcgRatePct = opts.ltcgRatePct ?? EQUITY_CG_DEFAULTS_2024.ltcgRatePct;
  const exemption = opts.ltcgExemption ?? EQUITY_CG_DEFAULTS_2024.ltcgExemption;
  const cessPct = opts.cessPct ?? 4;
  const surchargePct = opts.surchargePct ?? 0;

  const ltcgExemptionApplied = Math.min(ltcg, exemption);
  const ltcgTaxable = Math.max(0, ltcg - ltcgExemptionApplied);
  const stcgTax = Math.round((stcg * stcgRatePct) / 100);
  const ltcgTax = Math.round((ltcgTaxable * ltcgRatePct) / 100);
  const beforeCess = stcgTax + ltcgTax;
  // Surcharge on 111A/112A tax is capped at 15% by the Finance Act.
  const cappedSurchargePct = Math.min(Math.max(0, surchargePct), 15);
  const surcharge = Math.round((beforeCess * cappedSurchargePct) / 100);
  const cess = Math.round(((beforeCess + surcharge) * cessPct) / 100);

  return {
    stcg,
    ltcg,
    ltcgExemptionApplied,
    ltcgTaxable,
    stcgTax,
    ltcgTax,
    surcharge,
    cess,
    totalTax: beforeCess + surcharge + cess,
    methodology: [
      `STCG u/s 111A ${formatInr(stcg)} at ${stcgRatePct}% = ${formatInr(stcgTax)}.`,
      `LTCG u/s 112A ${formatInr(ltcg)}; exemption ${formatInr(ltcgExemptionApplied)}; taxable ${formatInr(ltcgTaxable)} at ${ltcgRatePct}% = ${formatInr(ltcgTax)}.`,
      surcharge > 0
        ? `Surcharge at ${cappedSurchargePct}% (capped at 15% for 111A/112A) = ${formatInr(surcharge)}.`
        : `No surcharge supplied (capital-gains surcharge is capped at 15% in law).`,
      `Cess at ${cessPct}% = ${formatInr(cess)}; total ${formatInr(beforeCess + surcharge + cess)}.`,
    ],
  };
}

/* ------------------------------------------------------------------ */
// Export a convenience: get the regime by name + FY               */
/* ------------------------------------------------------------------ */

/** Return the TaxRegime for an individual regime kind and assessment year.
 *  Valid regime kinds: "new" | "old"
 */
export function getIndividualRegime(kind: "new" | "old", ay: string = "2025-26"): TaxRegime {
  const byFy = INDIVIDUAL_REGIMES_BY_FY[ay];
  if (byFy) return byFy[kind];
  // Unknown FY: fall back to the latest registered table and say so loudly,
  // rather than silently computing the year on the wrong rates.
  // tslint:disable-next-line: no-console
  const fallback = INDIVIDUAL_REGIMES[kind]!;
  console.warn(`No regime table registered for FY ${ay}; using ${fallback.ay}.`);
  return fallback;
}

/* ------------------------------------------------------------------ */
// End of file
