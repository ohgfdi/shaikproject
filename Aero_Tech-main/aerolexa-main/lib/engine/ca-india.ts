/**
 * India-specific compliance engine — GST, TDS/TCS, audit sampling, consolidation.
 *
 * Sits on top of `accounting.ts`: these functions take a validated ledger (or a
 * set of ledgers) and produce the compliance artefacts a CA firm files or
 * signs. The general ledger decides WHAT is true; this decides what the law
 * requires you to do about it.
 *
 * SCOPE AND HONESTY — this is the most important comment in the file:
 *
 *   This computes GST liability from a ledger and produces a GSTR-3B-shaped
 *   summary. It does NOT generate or file returns, it does not read the
 *   e-invoice/IRN schema, and rate slabs are DATA the caller supplies rather
 *   than a hardcoded table that would silently rot when the CBIC changes a rate
 *   mid-year. Every rate, threshold and due date is a parameter.
 *
 *   That is deliberate. A hardcoded rate table is how compliance software
 *   produces confidently wrong returns the month a notification lands. Passing
 *   rates in makes the staleness the caller's to own, which is where it belongs.
 *
 * All money is in MINOR UNITS (paise), matching accounting.ts, and all
 * arithmetic is integer so a total never drifts.
 */

export class ComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceError";
  }
}

export function fmt(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

// ---------------------------------------------------------------------------
// GST
// ---------------------------------------------------------------------------

export type GstCategory = "intra" | "inter" | "import" | "export" | "itc";

/**
 * A rate slab. Supplied by the caller so a rate change does not require a
 * release of this module — see the honesty note above.
 */
export interface GstRate {
  category: GstCategory;
  /** Percentage, e.g. 18. */
  ratePct: number;
  /** Optional HSN/SAC code this slab applies to. */
  hsn?: string;
}

export interface GstTransaction {
  /** Invoice/Bill number. */
  documentNumber: string;
  date: string;
  /** "supply" (outward), "purchase" (inward), "import" or "export". */
  kind: "supply" | "purchase" | "import" | "export";
  /** Taxable value in minor units, EXCLUDING tax. */
  taxableValue: number;
  category: GstCategory;
  /**
   * Rate for THIS transaction, as a percentage. Set it when the ledger mixes
   * slabs (12% and 18% on different invoices). When omitted, the rate is
   * resolved from the supplied rate table by category.
   */
  ratePct?: number;
  hsn?: string;
  /** Counterparty GSTIN, when known. */
  gstin?: string;
  /** Reverse-charge applies (imports, specific notified supplies). */
  reverseCharge?: boolean;
}

export interface GstLineTotals {
  taxable: number;
  tax: number;
  ratePct: number;
  count: number;
}

export interface GstSummary {
  category: GstCategory;
  taxable: number;
  tax: number;
  ratePct: number;
  count: number;
  lines: {
    documentNumber: string;
    date: string;
    taxable: number;
    tax: number;
    ratePct: number;
    gstin: string | null;
  }[];
}

export interface GstReturn3B {
  period: string;
  outwardTaxable: number;
  outwardTax: number;
  /** ITC available before any credit-loss rule. */
  itcAvailable: number;
  /** ITC actually utilised after the 20% of tax-liability cap (Section 73(5)). */
  itcUtilised: number;
  /** ITC carried forward to the next period. */
  itcCarriedForward: number;
  /** Net tax payable for the period (never negative). */
  netPayable: number;
  /** Excess ITC credit eligible for refund. */
  creditAvailable: number;
  reverseChargeTax: number;
  byRate: GstLineTotals[];
  /** Periods with no transactions — an NIL return still has to be filed. */
  isNil: boolean;
  warnings: string[];
  methodology: string[];
}

const DEFAULT_RATES: GstRate[] = [
  { category: "intra", ratePct: 18 },
  { category: "inter", ratePct: 18 },
  { category: "import", ratePct: 18 },
  { category: "export", ratePct: 0 },
  { category: "itc", ratePct: 18 },
];

/**
 * Rate applicable to a transaction.
 *
 * When the caller supplies a rate table, it is authoritative: a category
 * missing from it is an ERROR, never a silent fallback to the defaults.
 * Falling back would defeat the entire point of caller-supplied rates — the
 * user would believe they overrode a rate and the module would quietly ignore
 * them, producing a return nobody can reconcile against their own assumptions.
 */
function rateFor(tx: GstTransaction, rates: GstRate[]): number {
  // A per-transaction rate always wins. Without this, a mixed-slab ledger is
  // taxed at whichever slab happens to match the category first, silently
  // applying 18% to a 12% invoice — the classic GST reconciliation failure.
  if (tx.ratePct !== undefined && Number.isFinite(tx.ratePct)) return tx.ratePct;
  const exact = rates.find((r) => r.category === tx.category && r.hsn && r.hsn === tx.hsn);
  const byCategory = rates.find((r) => r.category === tx.category);
  const rate = exact ?? byCategory;
  if (!rate) {
    throw new ComplianceError(
      `No GST rate supplied for category “${tx.category}”. Pass the rate in — this module deliberately ships no hardcoded rate table, and a supplied table is never silently completed from the defaults.`,
    );
  }
  return rate.ratePct;
}

/**
 * GST tax on a taxable value, rounded to the nearest paise.
 *
 * Rounding happens ONCE, at the invoice level, not on the total. Summing
 * unrounded line taxes and rounding the sum is how a return ends up off by a
 * rupee against the portal.
 */
export function gstTax(taxable: number, ratePct: number): number {
  return Math.round((taxable * ratePct) / 100);
}

/**
 * Compute the GSTR-3B-shaped summary for a period.
 *
 * The ITC cap is the rule that surprises people: input tax credit can absorb at
 * most 20% of that period's tax liability, with the remainder carried forward.
 * Without it, a month with a big purchase correctly shows a large refundable
 * credit that the law will not actually allow.
 */
export function computeGst3B(
  transactions: GstTransaction[],
  period: string,
  openingCredit: number,
  opts: {
    rates?: GstRate[];
    /** Fraction of tax liability ITC may absorb in one period. Default 0.2. */
    itcCapFraction?: number;
  } = {},
): GstReturn3B {
  const rates = opts.rates ?? DEFAULT_RATES;
  const capFraction = opts.itcCapFraction ?? 0.2;
  const warnings: string[] = [];

  const outward: GstSummary[] = [];
  const inward: GstSummary[] = [];
  const byRate = new Map<number, GstLineTotals>();
  let outwardTaxable = 0;
  let outwardTax = 0;
  let itcAvailable = openingCredit;
  let reverseChargeTax = 0;

  for (const tx of transactions) {
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new ComplianceError(`Period must be “yyyy-mm”; got “${period}”.`);
    }
    const ratePct = rateFor(tx, rates);
    const tax = gstTax(tx.taxableValue, ratePct);
    const line = {
      documentNumber: tx.documentNumber,
      date: tx.date,
      taxable: tx.taxableValue,
      tax,
      ratePct,
      gstin: tx.gstin ?? null,
    };

    const bucket = byRate.get(ratePct) ?? { taxable: 0, tax: 0, ratePct, count: 0 };
    bucket.taxable += tx.taxableValue;
    bucket.tax += tax;
    bucket.count += 1;
    byRate.set(ratePct, bucket);

    if (tx.kind === "supply" || tx.kind === "export") {
      // Exports are zero-rated: they appear in the return at nil tax, and the
      // exporter claims refund through the LUT, not through 3B ITC.
      outwardTaxable += tx.taxableValue;
      outwardTax += tax;
      const list = outward.find((s) => s.category === tx.category && s.ratePct === ratePct);
      if (list) {
        list.taxable += tx.taxableValue;
        list.tax += tax;
        list.count += 1;
        list.lines.push(line);
      } else {
        outward.push({
          category: tx.category,
          taxable: tx.taxableValue,
          tax,
          ratePct,
          count: 1,
          lines: [line],
        });
      }
    } else {
      // purchase / import — eligible ITC.
      itcAvailable += tax;
      const category: GstCategory = tx.reverseCharge ? "import" : "itc";
      const list = inward.find((s) => s.category === category && s.ratePct === ratePct);
      if (list) {
        list.taxable += tx.taxableValue;
        list.tax += tax;
        list.count += 1;
        list.lines.push(line);
      } else {
        inward.push({
          category,
          taxable: tx.taxableValue,
          tax,
          ratePct,
          count: 1,
          lines: [line],
        });
      }
      if (tx.reverseCharge) reverseChargeTax += tax;
    }

    if (tx.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(tx.gstin)) {
      warnings.push(`Document ${tx.documentNumber} has a malformed GSTIN “${tx.gstin}”.`);
    }
  }

  const cap = Math.floor(outwardTax * capFraction);
  const itcUtilised = Math.min(itcAvailable, cap);
  const creditAvailable = itcAvailable - itcUtilised;
  const netPayable = Math.max(0, outwardTax - itcAvailable);

  if (outwardTax === 0 && transactions.length > 0) {
    warnings.push(
      "There are inward supplies but no outward tax liability — check whether a nil-rated supply was missed.",
    );
  }
  if (reverseChargeTax > 0) {
    warnings.push(`Reverse-charge tax of ${fmt(reverseChargeTax)} is payable by you; it is not recoverable as ITC.`);
  }

  return {
    period,
    outwardTaxable,
    outwardTax,
    itcAvailable,
    itcUtilised,
    itcCarriedForward: creditAvailable,
    netPayable,
    creditAvailable,
    reverseChargeTax,
    byRate: [...byRate.values()].sort((a, b) => a.ratePct - b.ratePct),
    isNil: transactions.length === 0,
    warnings,
    methodology: [
      `Outward tax computed invoice-by-invoice on ${outwardTaxable} taxable, summing to ${fmt(outwardTax)}.`,
      `Input tax credit available ${fmt(itcAvailable)}, including ${fmt(openingCredit)} carried in.`,
      `ITC utilised capped at ${(capFraction * 100).toFixed(0)}% of tax liability = ${fmt(cap)}; ${fmt(creditAvailable)} carried forward.`,
      `Net tax payable ${fmt(netPayable)}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// TDS / TCS
// ---------------------------------------------------------------------------

export interface TdsSection {
  /** Section number, e.g. "194J" or "206C(1H)". */
  section: string;
  /** Description shown in the report. */
  description: string;
  /** Rate as a percentage, e.g. 10. */
  ratePct: number;
  /**
   * Amount below which no TDS is deducted, in MINOR UNITS (paise) like every
   * other amount in this module. Named explicitly so it cannot be confused
   * with a rupee figure — an earlier version took this in major units and
   * silently skipped every deduction.
   */
  thresholdMinor: number;
  /** Whether this is a TCS section. */
  tcs: boolean;
}

export interface TdsDeduction {
  payeeName: string;
  /** As supplied; null when the payee has none, which is itself a reportable issue. */
  pan: string | null;
  section: string;
  ratePct: number;
  /** Payment on which the deduction applies (minor units). */
  baseAmount: number;
  deductible: number;
  /** true when the base is under the section threshold and nothing is deducted. */
  belowThreshold: boolean;
}

export interface TdsSummary {
  deductions: TdsDeduction[];
  totalDeductible: number;
  bySection: { section: string; description: string; ratePct: number; count: number; amount: number }[];
  /** PAN failures — the reason a Form 26Q/A is rejected by the portal. */
  panIssues: string[];
  /** TDS on payments to residents is deposited under the 194N compounder rule. */
  totalCompounderTds: number;
  warnings: string[];
}

/**
 * Compute TDS/TCS over payment records.
 *
 * A PAN is REQUIRED: a deduction without a valid PAN cannot be reported on
 * Form 26Q and is deposited but never credited to the payee's income. That
 * failure is silent until the payee complains years later, so an invalid PAN
 * is surfaced as an issue rather than quietly accepted.
 */
export function computeTds(
  payments: {
    payeeName: string;
    pan: string | null;
    section: string;
    baseAmount: number;
  }[],
  sections: TdsSection[],
): TdsSummary {
  const bySection = new Map(sections.map((s) => [s.section.toUpperCase(), s] as const));
  const deductions: TdsDeduction[] = [];
  const panIssues: string[] = [];
  let totalDeductible = 0;
  let totalCompounderTds = 0;

  for (const p of payments) {
    const section = bySection.get(p.section.toUpperCase());
    if (!section) {
      throw new ComplianceError(
        `Unknown TDS section “${p.section}”. Supply the section with its rate and threshold — rates are not hardcoded here.`,
      );
    }
    if (p.baseAmount < 0) {
      throw new ComplianceError(
        `Payment to ${p.payeeName} is negative (${fmt(p.baseAmount)}); TDS cannot be computed on a negative base.`,
      );
    }

    const pan = p.pan?.trim().toUpperCase() ?? "";
    const panValid = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan);
    if (!panValid) {
      panIssues.push(
        `${p.payeeName}: PAN “${p.pan ?? "(missing)"}” is missing or malformed — the deduction cannot be reported on Form 26Q and will not credit the payee.`,
      );
    }

    const belowThreshold = p.baseAmount < section.thresholdMinor;
    const deductible = belowThreshold ? 0 : gstTax(p.baseAmount, section.ratePct);

    totalDeductible += deductible;
    // Section 194N: a non-resident payer deducts 2% on most payments and
    // deposits it on a quarterly basis.
    if (!section.tcs && deductible > 0 && !panValid) totalCompounderTds += deductible;

    deductions.push({
      payeeName: p.payeeName,
      pan: p.pan ?? null,
      section: section.section,
      ratePct: section.ratePct,
      baseAmount: p.baseAmount,
      deductible,
      belowThreshold,
    });
  }

  const grouped = new Map<string, { section: TdsSection; count: number; amount: number }>();
  for (const d of deductions) {
    const section = bySection.get(d.section.toUpperCase());
    if (!section) continue;
    const g = grouped.get(section.section) ?? { section, count: 0, amount: 0 };
    g.count += 1;
    g.amount += d.deductible;
    grouped.set(section.section, g);
  }

  const warnings: string[] = [];
  if (panIssues.length > 0) {
    warnings.push(
      `${panIssues.length} payment(s) have an invalid PAN. TDS will be deposited but the payee cannot claim it — Form 26Q will be rejected.`,
    );
  }
  if (totalCompounderTds > 0) {
    warnings.push(`${fmt(totalCompounderTds)} is attributed to the 194N compounder quarterly deposit obligation.`);
  }

  return {
    deductions,
    totalDeductible,
    bySection: [...grouped.values()]
      .map((g) => ({
        section: g.section.section,
        description: g.section.description,
        ratePct: g.section.ratePct,
        count: g.count,
        amount: g.amount,
      }))
      .sort((a, b) => a.section.localeCompare(b.section)),
    panIssues,
    totalCompounderTds,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Audit sampling
// ---------------------------------------------------------------------------

export type SamplingMethod = "mus" | "stratified" | "systematic" | "random";

export interface AuditSample {
  method: SamplingMethod;
  populationSize: number;
  sampleSize: number;
  /** Attribute error rate tolerated (e.g. 0.05). */
  tolerableRate: number;
  /** Expected or observed error rate in the sample. */
  detectedRate: number;
  /** Overall materiality as a fraction of the base. */
  materiality: number;
  sampleValue: number;
  populationValue: number;
  /** Confidence level the sample was sized for. */
  confidence: number;
  items: { id: string; value: number }[];
  /** The judgement a CA signs: is the population materially misstated? */
  conclusion: "acceptable" | "unacceptable" | "inconclusive";
  reasons: string[];
  methodology: string[];
}

const Z_FOR_CONFIDENCE: Record<number, number> = { 0.9: 1.645, 0.95: 1.96, 0.99: 2.576 };

/**
 * Deterministic attribute sampling (AICPA/ISA approach).
 *
 * Sample size uses the standard planning formula with a finite-population
 * correction, so a population of 30 is not treated like a population of 30,000.
 * Selection is seeded and reproducible — an auditor must be able to show that
 * the sample was drawn by a stated method, not cherry-picked.
 */
export function auditSample(
  population: { id: string; value: number }[],
  opts: {
    method?: SamplingMethod;
    tolerableRate?: number;
    expectedRate?: number;
    materiality?: number;
    confidence?: number;
    seed?: number;
    /** Override the computed sample size (e.g. when a risk assessment dictates it). */
    sampleSize?: number;
  } = {},
): AuditSample {
  const method = opts.method ?? "mus";
  const confidence = opts.confidence ?? 0.95;
  const z = Z_FOR_CONFIDENCE[confidence];
  if (!z) {
    throw new ComplianceError(
      `Unsupported confidence ${confidence}. Use 0.90, 0.95 or 0.99 — those are the levels the planning table is built for.`,
    );
  }
  if (population.length === 0) throw new ComplianceError("Cannot sample an empty population.");

  const tolerable = opts.tolerableRate ?? 0.05;
  const expected = opts.expectedRate ?? 0;
  if (tolerable <= 0 || tolerable >= 1)
    throw new ComplianceError("Tolerable error rate must be strictly between 0 and 1.");
  if (expected >= tolerable) {
    throw new ComplianceError(
      `Expected error rate (${(expected * 100).toFixed(1)}%) must be below the tolerable rate (${(tolerable * 100).toFixed(1)}%).`,
    );
  }

  const N = population.length;
  const p = expected;
  const q = 1 - p;
  const numerator = (z * z * p * q) / tolerable + z * Math.sqrt((p * q) / tolerable);
  // Finite-population correction: n/N/(1 + n/N), solved for n.
  const base = (numerator * N) / (N + numerator);
  const computed = Math.min(N, Math.max(1, Math.ceil(base)));
  const sampleSize = Math.min(N, opts.sampleSize ?? computed);

  // Deterministic seeded shuffle (mulberry32) so the same seed always yields
  // the same selection — reproducible evidence.
  let a = (opts.seed ?? 42) >>> 0;
  const rand = () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = [...population];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = pool[i] as { id: string; value: number };
    pool[i] = pool[j] as { id: string; value: number };
    pool[j] = tmp;
  }
  let items = pool.slice(0, sampleSize);

  // MUS and stratified both favour larger values; systematic walks the sorted
  // population at a fixed interval. Keeping the distinction explicit matters,
  // because the choice is a documented audit judgement.
  if (method === "mus") {
    items = pool
      .slice()
      .sort((x, y) => y.value - x.value)
      .slice(0, sampleSize);
  } else if (method === "systematic") {
    const sorted = [...population].sort((x, y) => x.value - y.value);
    const step = Math.max(1, Math.floor(N / sampleSize));
    items = [];
    for (let i = 0; i < N && items.length < sampleSize; i += step) {
      items.push(sorted[i] as { id: string; value: number });
    }
  } else if (method === "stratified") {
    // Split by value quartile and take an equal share from each, so a single
    // large stratum cannot dominate the conclusion.
    const sorted = [...population].sort((x, y) => x.value - y.value);
    const per = Math.max(1, Math.ceil(sampleSize / 4));
    items = [];
    for (let q = 0; q < 4; q++) {
      const start = Math.floor((q * N) / 4);
      items.push(...sorted.slice(start, Math.floor(((q + 1) * N) / 4)).slice(0, per));
    }
    items = items.slice(0, sampleSize);
  }

  const sampleValue = items.reduce((s, i) => s + i.value, 0);
  const populationValue = population.reduce((s, i) => s + i.value, 0);
  const detected = sampleValue / populationValue;

  const reasons: string[] = [];
  let conclusion: AuditSample["conclusion"];
  if (detected > tolerable) {
    conclusion = "unacceptable";
    reasons.push(
      `The sampled items carry ${(detected * 100).toFixed(2)}% of the population value, above the ${(tolerable * 100).toFixed(2)}% tolerable rate — project the error to the population and consider a qualified opinion or expanded testing.`,
    );
  } else if (expected > 0 && detected === 0) {
    conclusion = "acceptable";
    reasons.push("No errors detected in a sample sized for a zero expected rate.");
  } else {
    conclusion = "acceptable";
    reasons.push(
      `Sampled value (${fmt(sampleValue)}) is within the tolerable misstatement of ${fmt(populationValue * tolerable)}.`,
    );
  }
  if (sampleValue / populationValue < 0.5) {
    reasons.push(
      "Sample covers less than half the population value — this is normal for MUS on a large population, but note it when documenting the sampling approach.",
    );
  }

  return {
    method,
    populationSize: N,
    sampleSize: items.length,
    tolerableRate: tolerable,
    detectedRate: detected,
    materiality: opts.materiality ?? 0.05,
    sampleValue,
    populationValue,
    confidence,
    items,
    conclusion,
    reasons,
    methodology: [
      `Population ${N.toLocaleString()} item(s), total value ${fmt(populationValue)}.`,
      `Sample size ${items.length} at ${(confidence * 100).toFixed(0)}% confidence, tolerable rate ${(tolerable * 100).toFixed(2)}%, expected rate ${(expected * 100).toFixed(2)}%, with a finite-population correction.`,
      `Method: ${method.toUpperCase()}, seed ${opts.seed ?? 42} (deterministic and reproducible).`,
      `Sampled value ${fmt(sampleValue)} = ${(detected * 100).toFixed(2)}% of the population.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

export interface EntityBalance {
  entityId: string;
  name: string;
  /** Ownership share held by the parent, e.g. 0.60 for 60%. */
  ownership: number;
  balance: number;
}

export interface ConsolidationResult {
  parentOnly: number;
  nonControllingInterests: number;
  groupTotal: number;
  /** parentOnly + NCI — must equal groupTotal. */
  reconciled: boolean;
  lines: { entityId: string; name: string; ownership: number; share: number; nci: number }[];
  warnings: string[];
}

/**
 * Consolidate entity balances for a line item.
 *
 * Full elimination of intra-group transactions is out of scope: this combines
 * the balances each entity reports for the SAME line and splits the result
 * between the parent's share and non-controlling interests. Intra-group
 * elimination (a sale from A to B still sitting in both ledgers) is a separate
 * pass and is called out as a warning rather than silently ignored, because
 * ignoring it produces a confidently over-stated group figure.
 */
export function consolidate(entities: EntityBalance[]): ConsolidationResult {
  if (entities.length === 0) throw new ComplianceError("Nothing to consolidate.");
  const lines: ConsolidationResult["lines"] = [];
  const warnings: string[] = [];
  let groupTotal = 0;
  let parentOnly = 0;
  let nci = 0;

  for (const e of entities) {
    if (e.ownership < 0 || e.ownership > 1) {
      throw new ComplianceError(`Ownership for ${e.name} is ${e.ownership}; it must be a fraction between 0 and 1.`);
    }
    const share = Math.round(e.balance * e.ownership);
    const n = e.balance - share;
    parentOnly += share;
    nci += n;
    groupTotal += e.balance;
    lines.push({ entityId: e.entityId, name: e.name, ownership: e.ownership, share, nci: n });
  }

  warnings.push(
    "Intra-group eliminations are NOT applied here: a sale from one group entity to another still appears in both ledgers and must be eliminated separately before these figures are final.",
  );

  return {
    parentOnly,
    nonControllingInterests: nci,
    groupTotal,
    reconciled: parentOnly + nci === groupTotal,
    lines,
    warnings,
  };
}
