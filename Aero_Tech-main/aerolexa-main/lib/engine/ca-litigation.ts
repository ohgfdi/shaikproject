/**
 * Litigation & appeals engine — direct-tax dispute workflow for a CA practice.
 *
 * What it actually does: given an order, the date it was served and the tax
 * effect at stake, it walks the appeal ladder (AO → CIT(A)/NFAC → ITAT → High
 * Court), computes the limitation expiry and whether the appeal can still be
 * filed in time, prices the filing fee against a slab table, and assembles the
 * filing checklist and grounds skeleton.
 *
 * SCOPE AND HONESTY: this is arithmetic over caller-supplied dates and tables.
 * Limitation periods and fee slabs differ by statute, by forum and by finance
 * year, so every table below is a DEFAULT the caller may override, and every
 * result reports the provision it applied so a reviewer can check the claim.
 * The engine does not certify that an appeal is competent in law, does not
 * fetch live law, and does not predict an outcome.
 *
 * All amounts are in MINOR UNITS (paise) as integers.
 */

export class LitigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LitigationError";
  }
}

export type LitigationForum = "ao" | "cit-appeals" | "itat" | "high-court";

export interface AppealRoute {
  from: LitigationForum;
  to: LitigationForum;
  /** Limitation in days, counted from the date the order was served. */
  limitationDays: number;
  /** The provision that fixes the limitation period. */
  statute: string;
  /** Whether that forum charges a filing fee. */
  feeApplies: boolean;
}

/**
 * The appeal ladder and the limitation period for each step. Days are counted
 * from the date of service of the order appealed against.
 */
export const APPEAL_ROUTES: readonly AppealRoute[] = [
  { from: "ao", to: "cit-appeals", limitationDays: 30, statute: "s.249(2) / s.246A(3)", feeApplies: false },
  { from: "cit-appeals", to: "itat", limitationDays: 60, statute: "s.253(3)", feeApplies: true },
  { from: "itat", to: "high-court", limitationDays: 120, statute: "s.260A(2)", feeApplies: true },
];

/** A fee slab: `uptoMinor` is the inclusive upper bound of the tax effect, null = no upper bound. */
export interface FeeSlab {
  uptoMinor: number | null;
  feeMinor: number;
}

/**
 * Default Tribunal fee slabs, keyed on the tax effect at stake. Finance Act
 * data — VERIFY against the current s.253(6) / Tribunal rules before filing;
 * pass your own `slabs` when the statute moves.
 */
export const DEFAULT_APPEAL_FEE_SLABS: readonly FeeSlab[] = [
  { uptoMinor: 1_00_000 * 100, feeMinor: 500 * 100 },
  { uptoMinor: 2_00_000 * 100, feeMinor: 1_500 * 100 },
  { uptoMinor: 5_00_000 * 100, feeMinor: 5_000 * 100 },
  { uptoMinor: null, feeMinor: 10_000 * 100 },
];

/** Price the filing fee for a tax effect against the slab table. */
export function appealFee(taxEffectMinor: number, slabs: readonly FeeSlab[] = DEFAULT_APPEAL_FEE_SLABS): number {
  if (taxEffectMinor < 0) throw new LitigationError("taxEffectMinor must not be negative.");
  for (const slab of slabs) {
    if (slab.uptoMinor === null || taxEffectMinor <= slab.uptoMinor) return slab.feeMinor;
  }
  return slabs.length ? slabs[slabs.length - 1]!.feeMinor : 0;
}

const DAY_MS = 86_400_000;

function parseDate(iso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new LitigationError(`Date must be yyyy-mm-dd, received "${iso}".`);
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) throw new LitigationError(`Unparseable date "${iso}".`);
  return t;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Calendar days from `fromIso` to `toIso` (positive when `to` is later). */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseDate(toIso) - parseDate(fromIso)) / DAY_MS);
}

export interface LimitationStatus {
  servedDate: string;
  limitationDays: number;
  /** Last date on which the appeal can be filed within limitation. */
  expiryDate: string;
  /** Date the appeal is filed / proposed to be filed. */
  filingDate: string;
  /** Days left against the expiry (negative = already past). */
  daysRemaining: number;
  withinLimitation: boolean;
  /** Days of delay needing a condonation application u/s 5 of the Limitation Act. */
  delayDays: number;
  requiresCondonation: boolean;
}

/** Work out where a filing sits against a limitation period. */
export function limitationStatus(input: {
  servedDate: string;
  limitationDays: number;
  filingDate: string;
}): LimitationStatus {
  const served = parseDate(input.servedDate);
  const filing = parseDate(input.filingDate);
  const expiry = served + input.limitationDays * DAY_MS;
  const daysRemaining = Math.round((expiry - filing) / DAY_MS);
  const withinLimitation = filing <= expiry;
  return {
    servedDate: input.servedDate,
    limitationDays: input.limitationDays,
    expiryDate: toIso(expiry),
    filingDate: input.filingDate,
    daysRemaining,
    withinLimitation,
    delayDays: withinLimitation ? 0 : -daysRemaining,
    requiresCondonation: !withinLimitation,
  };
}

export interface AppealMatterInput {
  /** Matter/client reference. */
  matterId: string;
  clientName: string;
  pan: string;
  assessmentYear: string;
  /** The forum whose order is being appealed. */
  orderBy: LitigationForum;
  orderReference: string;
  orderDate: string;
  servedDate: string;
  taxEffectMinor: number;
  /** Amount already deposited / disputed tax, minor units. */
  disputedTaxMinor?: number;
  grounds: string[];
  /** Caller overrides; the defaults are the routes above. */
  routes?: readonly AppealRoute[];
  feeSlabs?: readonly FeeSlab[];
  /** Target filing date, defaults to the limitation expiry. */
  filingDate?: string;
}

export interface AppealPlan {
  matterId: string;
  clientName: string;
  pan: string;
  assessmentYear: string;
  orderBy: LitigationForum;
  orderReference: string;
  /** The next step up the ladder, or null when the matter is at the top. */
  nextRoute: AppealRoute | null;
  /** Every remaining step from `orderBy` to the High Court. */
  ladder: { to: LitigationForum; limitationDays: number; statute: string; feeApplies: boolean }[];
  limitation: LimitationStatus;
  feeMinor: number;
  taxEffectMinor: number;
  /** Stay of demand: deposit threshold commonly insisted on (caller-owned). */
  stayDepositMinor: number;
  checklist: string[];
  /** One entry per ground, kept verbatim from the caller. */
  groundsSkeleton: { ground: string; toVerify: string }[];
  warnings: string[];
  methodology: string[];
}

/** Deposit the department commonly insists on for a stay (20% of the disputed demand). */
export const DEFAULT_STAY_DEPOSIT_PCT = 20;

/**
 * Build the appeal plan for one order: next step, limitation, fee, checklist.
 */
export function planAppeal(input: AppealMatterInput): AppealPlan {
  const routes = input.routes ?? APPEAL_ROUTES;
  if (input.taxEffectMinor < 0) throw new LitigationError("taxEffectMinor must not be negative.");
  if (!input.grounds.length) throw new LitigationError("At least one ground of appeal is required.");

  // Every step still open from the forum whose order is appealed, in order.
  const startIndex = routes.findIndex((r) => r.from === input.orderBy);
  const remaining = startIndex >= 0 ? routes.slice(startIndex) : [];
  const ladder = remaining.map((r) => ({
    to: r.to,
    limitationDays: r.limitationDays,
    statute: r.statute,
    feeApplies: r.feeApplies,
  }));
  const nextRoute = remaining[0] ?? null;

  const warningList: string[] = [];
  if (!nextRoute) {
    warningList.push(
      `No further appeal route is modelled from "${input.orderBy}" — review whether a writ is the only avenue.`,
    );
  }

  const limitation = nextRoute
    ? limitationStatus({
        servedDate: input.servedDate,
        limitationDays: nextRoute.limitationDays,
        filingDate: input.filingDate ?? toIso(parseDate(input.servedDate) + nextRoute.limitationDays * DAY_MS),
      })
    : limitationStatus({
        servedDate: input.servedDate,
        limitationDays: 0,
        filingDate: input.filingDate ?? input.servedDate,
      });

  if (limitation.requiresCondonation) {
    warningList.push(
      `Filing is ${limitation.delayDays} day(s) past the ${nextRoute?.limitationDays ?? 0}-day limitation; a condonation application is required.`,
    );
  }

  const feeMinor = nextRoute?.feeApplies ? appealFee(input.taxEffectMinor, input.feeSlabs) : 0;

  const stayDepositMinor = Math.round(
    (input.disputedTaxMinor ?? input.taxEffectMinor) * (DEFAULT_STAY_DEPOSIT_PCT / 100),
  );

  const checklist = [
    `Certified copy of the ${input.orderBy} order ${input.orderReference} dated ${input.orderDate}`,
    "Form of appeal (Form 35 for CIT(A), Form 36 for ITAT) in duplicate",
    "Statement of facts and grounds of appeal, signed",
    nextRoute?.feeApplies
      ? `Tribunal fee of ₹${feeMinor / 100} (receipt to be enclosed)`
      : "No filing fee at this forum",
    "Proof of service of the order (date of service drives the limitation clock)",
    "Stay application u/s 220(6) / 254(2A) with evidence of the prescribed deposit",
    "Proof of payment of admitted tax and interest",
    limitation.requiresCondonation
      ? "Affidavit supporting condonation of delay with reasons day by day"
      : "No condonation needed at this stage",
    "Authority-wise paper book index with page numbers",
  ];

  return {
    matterId: input.matterId,
    clientName: input.clientName,
    pan: input.pan,
    assessmentYear: input.assessmentYear,
    orderBy: input.orderBy,
    orderReference: input.orderReference,
    nextRoute,
    ladder,
    limitation,
    feeMinor,
    taxEffectMinor: input.taxEffectMinor,
    stayDepositMinor,
    checklist,
    groundsSkeleton: input.grounds.map((g) => ({
      ground: g,
      toVerify:
        "Cross-check the ground against the assessment order paragraph it answers, and confirm no new ground needs leave.",
    })),
    warnings: warningList,
    methodology: [
      `Limitation is counted from the date of SERVICE (${input.servedDate}), not the date of the order (${input.orderDate}).`,
      nextRoute
        ? `Next forum: ${nextRoute.to} — ${nextRoute.limitationDays} days under ${nextRoute.statute}; expiry ${limitation.expiryDate}.`
        : "No further route modelled.",
      `Tax effect ₹${input.taxEffectMinor / 100} prices the fee at ₹${feeMinor / 100} against the supplied slab table.`,
      `Stay deposit modelled at ${DEFAULT_STAY_DEPOSIT_PCT}% of the disputed demand = ₹${stayDepositMinor / 100} (caller-owned policy).`,
      "Dates and money are arithmetic on caller input; the statutory tables are defaults that the caller owns.",
    ],
  };
}

export interface LitigationPortfolioInput {
  matters: {
    matterId: string;
    clientName: string;
    forum: LitigationForum;
    taxEffectMinor: number;
    servedDate: string;
    limitationDays: number;
    filingDate: string;
    status: "not-filed" | "filed" | "heard" | "disposed";
  }[];
}

export interface LitigationPortfolio {
  totalMatters: number;
  byForum: Record<string, number>;
  totalTaxEffectMinor: number;
  atRisk: { matterId: string; clientName: string; expiryDate: string; daysRemaining: number; delayDays: number }[];
  dueSoon: { matterId: string; clientName: string; expiryDate: string; daysRemaining: number }[];
  filedCount: number;
  methodology: string[];
}

/** Roll a matter list up into a limitation-risk portfolio view. */
export function litigationPortfolio(input: LitigationPortfolioInput, dueSoonDays = 15): LitigationPortfolio {
  const byForum: Record<string, number> = {};
  const atRisk: LitigationPortfolio["atRisk"] = [];
  const dueSoon: LitigationPortfolio["dueSoon"] = [];
  let totalTaxEffectMinor = 0;
  let filedCount = 0;

  for (const m of input.matters) {
    byForum[m.forum] = (byForum[m.forum] ?? 0) + 1;
    totalTaxEffectMinor += m.taxEffectMinor;
    if (m.status !== "not-filed") filedCount += 1;
    const lim = limitationStatus({
      servedDate: m.servedDate,
      limitationDays: m.limitationDays,
      filingDate: m.filingDate,
    });
    if (m.status === "not-filed") {
      if (!lim.withinLimitation) {
        atRisk.push({
          matterId: m.matterId,
          clientName: m.clientName,
          expiryDate: lim.expiryDate,
          daysRemaining: lim.daysRemaining,
          delayDays: lim.delayDays,
        });
      } else if (lim.daysRemaining <= dueSoonDays) {
        dueSoon.push({
          matterId: m.matterId,
          clientName: m.clientName,
          expiryDate: lim.expiryDate,
          daysRemaining: lim.daysRemaining,
        });
      }
    }
  }

  atRisk.sort((a, b) => a.daysRemaining - b.daysRemaining);
  dueSoon.sort((a, b) => a.daysRemaining - b.daysRemaining);

  return {
    totalMatters: input.matters.length,
    byForum,
    totalTaxEffectMinor,
    atRisk,
    dueSoon,
    filedCount,
    methodology: [
      "Only matters whose status is not-filed are treated as at risk of a limitation bar.",
      `Matters expiring within ${dueSoonDays} days are listed as due soon.`,
      "Limitation runs from the date of service supplied for each matter.",
    ],
  };
}
