/**
 * Advance tax and self-assessment — instalment schedule by FY, projection of the
 * year's liability under the correct slab/rebate/surcharge tables, shortfall
 * interest u/s 234A/234B/234C, and self-assessment tax u/s 140A.
 *
 * SCOPE AND HONESTY: the instalment dates/percentages are statutory; the rate
 * tables come from `india-tax.ts` and are registered per FY. This engine is
 * arithmetic on caller-supplied projections — it does not fetch live law and
 * does not issue a legal opinion. Interest months are counted as “part month =
 * full month”, which is how the Act charges them.
 *
 * Money is in RUPEES (the API contract for this engine) and converted once to
 * integer paise for the tax core.
 */

import {
  INDIVIDUAL_REGIMES_BY_FY,
  INR,
  computeCorporateTax,
  computeHraExemption,
  computeIncomeTax,
  formatInr,
  CORPORATE_REGIMES,
  type ChapterVIAInput,
  type TaxRegime,
} from "./india-tax";

export interface InstalmentRow {
  instalment: number;
  dueDate: string;
  percentage: number;
  amountDue: number;
  alreadyPaid: number;
  shortfall: number;
  interest234C?: number;
}

export interface AdvanceTaxResult {
  fy: string;
  assesseeType: string;
  regime: "old" | "new";
  method: "slab-snapshot" | "yearly-projection";
  estimatedTotalIncome: number;
  grossTotalIncome: number;
  totalIncomeAfterDeductions: number;
  agriculturalIncomeSetOff: number;
  basicIncome: number;
  deductions: {
    section80C: number;
    section80CCC: number;
    section80CCD1: number;
    section80CCD2: number;
    section80D: number;
    section80E: number;
    section80G: number;
    section80GG: number;
    section80TTA: number;
    section80TTB: number;
    otherDeductions: number;
    totalDeductions: number;
  };
  hra: {
    hraReceived: number;
    hraExempt: number;
    hraTaxable: number;
  } | null;
  taxBeforeSurcharge: number;
  surchargeGross: number;
  surchargeAfterMarginalRelief: number;
  surcharge: number;
  taxAfterSurcharge: number;
  rebate87A: number;
  taxAfterRebate: number;
  cess: number;
  totalTaxLiability: number;
  regimeComparison: {
    oldRegimeTax: number;
    newRegimeTax: number;
    recommendedRegime: "old" | "new";
    savings: number;
  } | null;
  instalments: InstalmentRow[];
  prepaidTax: { advanceTaxPaid: number; tds: number; tcs: number };
  totalShortfall: number;
  interest234A: number;
  interest234B: number;
  interest234C: number;
  totalInterest: number;
  selfAssessmentTax: number;
  delayedFilingDays: number;
  delayedFilingPenalty: number;
  warnings: string[];
  methodology: string[];
}

export interface ComputeAdvanceTaxInput {
  fy: string;
  assesseeType: "individual" | "company" | "firm" | "llp" | "hindu-undivided-family" | "aop" | "boi" | "trust";
  residentialStatus: "resident" | "non-resident" | "not-ordinarily-resident";
  regime: "old" | "new";
  estimatedTotalIncome: number;
  grossTotalIncome: number;
  incomeHeads: {
    salary: number;
    houseProperty: number;
    businessProfession: number;
    capitalGains: number;
    otherSources: number;
    agricultural: number;
  };
  deductions: {
    section80C: number;
    section80CCC: number;
    section80CCD1: number;
    section80CCD2: number;
    section80D: number;
    section80E: number;
    section80G: number;
    section80GG: number;
    section80TTA: number;
    section80TTB: number;
    otherDeductions: number;
  };
  hra: {
    received: number;
    paidRent: number;
    city: boolean;
    basicSalary: number;
  } | null;
  losses: {
    bhplBroughtFwd: number;
    bhplSetOff: number;
    cglBroughtFwd: number;
    cglSetOff: number;
  };
  method: "slab-snapshot" | "yearly-projection";
  incomeByInstalment?: { dueDate: string; incomeUpToDate: number }[];
  prepaidTax: { advanceTaxPaid: number; tds: number; tcs: number };
  delayedFilingDays: number;
  liabilityExceedsThreshold: boolean;
  computeRegimeComparison: boolean;
  /** Apply the salary standard deduction u/s 16(ia). Default true. */
  applyStandardDeduction?: boolean;
}

const isIndividualLike = (t: string) =>
  t === "individual" || t === "hindu-undivided-family" || t === "aop" || t === "boi";

function resolveRegime(fy: string, kind: "old" | "new"): { regime: TaxRegime; exact: boolean } {
  const table = INDIVIDUAL_REGIMES_BY_FY[fy];
  if (table) return { regime: table[kind], exact: true };
  return { regime: INDIVIDUAL_REGIMES_BY_FY["2025-26"]![kind], exact: false };
}

/** Firm/LLP/trust tax: base rate + surcharge with marginal relief + cess. */
function entityTax(opts: {
  income: number;
  baseRatePct: number;
  bands: { above: number; ratePct: number }[];
  cessPct: number;
}) {
  const baseTax = Math.round((opts.income * opts.baseRatePct) / 100);
  const taxAt = (t: number) => Math.round((t * opts.baseRatePct) / 100);
  let band: { above: number; ratePct: number } | null = null;
  for (const b of [...opts.bands].sort((a, b) => a.above - b.above)) if (opts.income > b.above) band = b;
  let surcharge = 0;
  let relief = 0;
  if (band && baseTax > 0) {
    const raw = Math.round((baseTax * band.ratePct) / 100);
    const cap = taxAt(band.above) + (opts.income - band.above);
    if (baseTax + raw > cap) {
      surcharge = Math.max(0, cap - baseTax);
      relief = raw - surcharge;
    } else {
      surcharge = raw;
    }
  }
  const cess = Math.round(((baseTax + surcharge) * opts.cessPct) / 100);
  return { baseTax, surcharge, relief, cess, total: baseTax + surcharge + cess };
}

/** Whole liability for a set of facts, under one regime. All in rupees. */
function liabilityFor(opts: ComputeAdvanceTaxInput, kind: "old" | "new") {
  const { regime } = resolveRegime(opts.fy, kind);
  const h = opts.incomeHeads;

  // HRA u/s 10(13A): old regime only; it reduces salary, it is not added back.
  let hraExempt = 0;
  if (kind === "old" && opts.hra && opts.hra.received > 0) {
    const r = computeHraExemption({
      salary: INR(Math.max(0, opts.hra.basicSalary)),
      hraReceived: INR(Math.max(0, opts.hra.received)),
      rentPaid: INR(Math.max(0, opts.hra.paidRent)),
      metro: opts.hra.city,
    });
    hraExempt = Math.min(Math.max(0, h.salary), r.exempt / 100);
  }

  const gti =
    Math.max(0, h.salary - hraExempt) + h.houseProperty + h.businessProfession + h.capitalGains + h.otherSources;
  // Set-off cannot exceed either the loss available (brought forward) or the
  // income of the same head for the year.
  const bhplSetOff = Math.min(
    Math.max(0, opts.losses.bhplSetOff),
    Math.max(0, opts.losses.bhplBroughtFwd),
    Math.max(0, h.businessProfession),
  );
  const cglSetOff = Math.min(
    Math.max(0, opts.losses.cglSetOff),
    Math.max(0, opts.losses.cglBroughtFwd),
    Math.max(0, h.capitalGains),
  );
  const afterLoss = Math.max(0, gti - bhplSetOff - cglSetOff);

  // Inputs are in rupees; the tax core takes paise.
  const via: ChapterVIAInput = {
    section80C: INR(
      Math.max(0, opts.deductions.section80C + opts.deductions.section80CCC + opts.deductions.section80CCD1),
    ),
    section80CCD1B: 0,
    section80CCD2: INR(Math.max(0, opts.deductions.section80CCD2)),
    section80D: INR(Math.max(0, opts.deductions.section80D)),
    section80E: INR(Math.max(0, opts.deductions.section80E)),
    section80G: INR(Math.max(0, opts.deductions.section80G)),
    section80GG: INR(Math.max(0, opts.deductions.section80GG)),
    section80TTA: INR(Math.max(0, opts.deductions.section80TTA)),
    section80TTB: INR(Math.max(0, opts.deductions.section80TTB)),
    other: INR(Math.max(0, opts.deductions.otherDeductions)),
  };

  if (isIndividualLike(opts.assesseeType)) {
    const res = computeIncomeTax({
      grossIncome: INR(afterLoss),
      deductionBreakup: via,
      regime,
      applyStandardDeduction: opts.applyStandardDeduction !== false,
      residentIndividual: opts.residentialStatus === "resident",
      agriculturalIncome: INR(Math.max(0, h.agricultural)),
    });
    const allowed: Record<string, number> = {};
    for (const line of res.deductionLines) allowed[line.section] = line.allowed / 100;
    return {
      regime,
      hraExempt,
      gti,
      afterLoss,
      allowed,
      basicIncome: res.taxableIncome / 100,
      chapterVIA: res.deductions / 100,
      taxBeforeSurcharge: res.slabTax / 100,
      surchargeGross: res.surcharge + res.surchargeMarginalRelief,
      surcharge: res.surcharge,
      taxAfterSurcharge: res.taxAfterRebate / 100 + res.surcharge / 100,
      rebate87A: res.rebate / 100,
      taxAfterRebate: res.taxAfterRebate / 100,
      cess: res.cess / 100,
      totalTax: res.totalTax / 100,
    };
  }

  if (opts.assesseeType === "company") {
    const c = computeCorporateTax({ totalIncome: INR(afterLoss), regime: CORPORATE_REGIMES.normal! });
    return {
      regime,
      hraExempt: 0,
      gti,
      afterLoss,
      allowed: {} as Record<string, number>,
      basicIncome: afterLoss,
      chapterVIA: 0,
      taxBeforeSurcharge: c.baseTax / 100,
      surchargeGross: c.surcharge / 100 + c.marginalRelief / 100,
      surcharge: c.surcharge / 100,
      taxAfterSurcharge: (c.baseTax + c.surcharge) / 100,
      rebate87A: 0,
      taxAfterRebate: (c.baseTax + c.surcharge) / 100,
      cess: c.cess / 100,
      totalTax: c.totalTax / 100,
    };
  }

  // Firm / LLP / trust
  const bands =
    opts.assesseeType === "trust"
      ? [
          { above: INR(5000000), ratePct: 10 },
          { above: INR(10000000), ratePct: 15 },
        ]
      : [{ above: INR(10000000), ratePct: 12 }];
  const e = entityTax({ income: INR(afterLoss), baseRatePct: 30, bands, cessPct: 4 });
  return {
    regime,
    hraExempt: 0,
    gti,
    afterLoss,
    basicIncome: afterLoss,
    chapterVIA: 0,
    taxBeforeSurcharge: e.baseTax / 100,
    surchargeGross: (e.surcharge + e.relief) / 100,
    surcharge: e.surcharge / 100,
    taxAfterSurcharge: (e.baseTax + e.surcharge) / 100,
    rebate87A: 0,
    taxAfterRebate: (e.baseTax + e.surcharge) / 100,
    cess: e.cess / 100,
    totalTax: e.total / 100,
  };
}

export function computeAdvanceTax(input: ComputeAdvanceTaxInput): AdvanceTaxResult {
  const warnings: string[] = [];
  const { fy, assesseeType, regime, method, prepaidTax, delayedFilingDays } = input;
  if (!Number.isFinite(input.estimatedTotalIncome) || input.estimatedTotalIncome < 0) {
    warnings.push("Estimated total income was negative or invalid; clamped to zero.");
  }

  const main = liabilityFor(input, regime);
  const allowedSections: Record<string, number> = main.allowed ?? {};

  // Regime comparison on the same facts.
  let regimeComparisonResult: AdvanceTaxResult["regimeComparison"] = null;
  if (input.computeRegimeComparison && isIndividualLike(assesseeType)) {
    const oldRegime = liabilityFor(input, "old");
    const newRegime = liabilityFor(input, "new");
    const better = oldRegime.totalTax <= newRegime.totalTax ? "old" : "new";
    regimeComparisonResult = {
      oldRegimeTax: oldRegime.totalTax,
      newRegimeTax: newRegime.totalTax,
      recommendedRegime: better,
      savings: Math.abs(oldRegime.totalTax - newRegime.totalTax),
    };
  }

  // ---- Instalment schedule -------------------------------------------------
  const startYear = Number(fy.slice(0, 4));
  if (!Number.isFinite(startYear)) {
    throw new Error(`Financial year must look like "2025-26"; got "${fy}".`);
  }
  const schedule = [
    { instalment: 1, dueDate: `${startYear}-06-15`, percentage: 0.15, months: 3, proviso: 0.12 },
    { instalment: 2, dueDate: `${startYear}-09-15`, percentage: 0.45, months: 3, proviso: 0.36 },
    { instalment: 3, dueDate: `${startYear}-12-15`, percentage: 0.75, months: 3, proviso: 0.75 },
    { instalment: 4, dueDate: `${startYear + 1}-03-15`, percentage: 1.0, months: 1, proviso: 1 },
  ];

  const advancePaid = Math.max(0, prepaidTax.advanceTaxPaid);
  const belowAdvanceThreshold = main.totalTax < 10_000;

  // Tax on the income earned up to a date — the yearly-projection method runs the
  // same statutory table on the year-to-date figure rather than scaling the
  // annual liability, so a lumpy year does not front-load the wrong instalment.
  const taxOnYtdIncome = (ytd: number): number => {
    const income = Math.max(0, ytd);
    if (!isIndividualLike(assesseeType)) {
      return main.basicIncome > 0 ? (main.totalTax * income) / main.basicIncome : 0;
    }
    // The 87A rebate is an ANNUAL determination, so it is deliberately not
    // applied to a part-year figure here; slab, surcharge and cess are.
    const res = computeIncomeTax({
      grossIncome: INR(income),
      regime: { ...main.regime, rebate: undefined },
      applyStandardDeduction: input.applyStandardDeduction !== false,
      residentIndividual: input.residentialStatus === "resident",
      agriculturalIncome: INR(Math.max(0, input.incomeHeads.agricultural)),
    });
    return res.totalTax / 100;
  };

  const instalments: InstalmentRow[] = schedule.map((s) => {
    const base =
      method === "yearly-projection" && input.incomeByInstalment && input.incomeByInstalment.length > 0
        ? (() => {
            const row = input.incomeByInstalment.find((i) => i.dueDate >= s.dueDate);
            const ytd = row ? row.incomeUpToDate : input.estimatedTotalIncome;
            return taxOnYtdIncome(ytd) * s.percentage;
          })()
        : main.totalTax * s.percentage;
    const target = Math.round(base);
    const paid = Math.min(advancePaid, target);
    const shortfall = Math.max(0, target - paid);
    // 234C: 1% per month; the 12%/36% proviso relieves Q1/Q2 where paid ≥ that
    // percentage of the assessed tax.
    const provisoMet = advancePaid >= Math.round(main.totalTax * s.proviso);
    const interest = belowAdvanceThreshold || provisoMet ? 0 : Math.round((shortfall * s.months) / 100);
    return {
      instalment: s.instalment,
      dueDate: s.dueDate,
      percentage: s.percentage * 100,
      amountDue: target,
      alreadyPaid: paid,
      shortfall,
      interest234C: interest,
    };
  });

  const totalShortfall = instalments.reduce((s, r) => s + r.shortfall, 0);
  const interest234CTotal = instalments.reduce((s, r) => s + (r.interest234C ?? 0), 0);

  // 234B: 1% per month from 1 April of the AY on the shortfall against 90% of
  // the assessed tax. The caller's delayed-filing days proxy the period to the
  // determination date.
  const assessedTax = main.totalTax;
  const ninetyPct = Math.round(assessedTax * 0.9);
  const shortfall234B = belowAdvanceThreshold || advancePaid >= ninetyPct ? 0 : assessedTax - advancePaid;
  const months234B = shortfall234B > 0 ? Math.max(1, Math.ceil(Math.max(0, delayedFilingDays) / 30)) : 0;
  const interest234BVal = Math.round((shortfall234B * months234B) / 100);

  // 234A: 1% per month on the tax still unpaid at the return due date, for the
  // period of delay in filing.
  const unpaidAtDueDate = Math.max(
    0,
    assessedTax - advancePaid - Math.max(0, prepaidTax.tds) - Math.max(0, prepaidTax.tcs),
  );
  const months234A = delayedFilingDays > 0 ? Math.ceil(delayedFilingDays / 30) : 0;
  const interest234A = Math.round((unpaidAtDueDate * months234A) / 100);

  const totalInterest = interest234A + interest234BVal + interest234CTotal;
  const selfAssessmentTax = Math.max(
    0,
    assessedTax - advancePaid - Math.max(0, prepaidTax.tds) - Math.max(0, prepaidTax.tcs) + totalInterest,
  );

  if (assessedTax < 10_000) {
    warnings.push("Total tax liability is below ₹10,000; advance tax is not payable and 234B/234C cannot arise.");
  }
  if (!input.liabilityExceedsThreshold) {
    warnings.push(
      "Advance tax may not be payable if the total tax liability does not exceed the threshold; confirm with the engagement team.",
    );
  }
  if (totalShortfall > 0) {
    warnings.push(
      "Shortfall in advance-tax instalments attracts 234B/234C interest at 1% per month on the cumulative shortfall.",
    );
  }
  if (delayedFilingDays > 0) {
    warnings.push(
      `Late filing of ${delayedFilingDays} day(s) attracts 234A interest at 1% per month on the unpaid tax.`,
    );
  }
  if (regimeComparisonResult) {
    warnings.push(
      `Regime comparison: old ${formatInr(INR(regimeComparisonResult.oldRegimeTax))} vs new ${formatInr(INR(regimeComparisonResult.newRegimeTax))}; recommended ${regimeComparisonResult.recommendedRegime}.`,
    );
  }

  const methodology: string[] = [
    `FY ${fy}; assessee ${assesseeType}; status ${input.residentialStatus}; regime ${regime} (${main.regime.label}).`,
    `Gross total income ${formatInr(INR(main.gti))} = salary ${input.incomeHeads.salary}` +
      (main.hraExempt > 0 ? ` less HRA exemption ${formatInr(INR(main.hraExempt))}` : "") +
      ` + house property ${input.incomeHeads.houseProperty} + business ${input.incomeHeads.businessProfession} + capital gains ${input.incomeHeads.capitalGains} + other sources ${input.incomeHeads.otherSources}.`,
    `Loss set-off ${input.losses.bhplSetOff + input.losses.cglSetOff}; income after set-off ${formatInr(INR(main.afterLoss))}.`,
    `Chapter VI-A allowed ${formatInr(INR(main.chapterVIA))}; taxable income ${formatInr(INR(main.basicIncome))}.`,
    `Tax before surcharge ${formatInr(INR(main.taxBeforeSurcharge))}; surcharge ${formatInr(INR(main.surcharge))}; rebate u/s 87A ${formatInr(INR(main.rebate87A))}.`,
    `Cess ${formatInr(INR(main.cess))}; total tax liability ${formatInr(INR(main.totalTax))}.`,
    `Prepaid ${formatInr(INR(advancePaid + prepaidTax.tds + prepaidTax.tcs))} (advance ${advancePaid}, TDS ${prepaidTax.tds}, TCS ${prepaidTax.tcs}).`,
    `Interest 234A ${formatInr(INR(interest234A))} (${months234A} month(s)); 234B ${formatInr(INR(interest234BVal))} (${months234B} month(s)); 234C ${formatInr(INR(interest234CTotal))}.`,
    `Self-assessment tax u/s 140A ${formatInr(INR(selfAssessmentTax))}.`,
    ...instalments.map(
      (i) =>
        `${i.instalment}) ${i.percentage}% due ${i.dueDate}: required ${formatInr(INR(i.amountDue))}; paid ${formatInr(INR(i.alreadyPaid))}; shortfall ${formatInr(INR(i.shortfall))}; 234C interest ${formatInr(INR(i.interest234C ?? 0))}.`,
    ),
    `Instalments are 15% / 45% / 75% / 100% of the year's tax; the 12%/36%/75% proviso and the ₹10,000 threshold are applied before any 234C interest.`,
    `Advance tax is payable only where the year's liability is ₹10,000 or more; the 234B comparison is against 90% of the assessed tax.`,
    `234A interest runs at 1% per month (part month = full month) on the tax still unpaid at the return due date for the period of delay.`,
  ];

  return {
    fy,
    assesseeType,
    regime,
    method,
    estimatedTotalIncome: Math.max(0, input.estimatedTotalIncome),
    grossTotalIncome: main.gti,
    totalIncomeAfterDeductions: main.afterLoss,
    agriculturalIncomeSetOff: Math.max(0, input.incomeHeads.agricultural),
    basicIncome: main.basicIncome,
    // Per-section figures are the amounts ALLOWED after the statutory caps.
    deductions: {
      section80C: allowedSections["80C"] ?? 0,
      section80CCC: 0,
      section80CCD1: 0,
      section80CCD2: allowedSections["80CCD(2)"] ?? 0,
      section80D: allowedSections["80D"] ?? 0,
      section80E: allowedSections["80E"] ?? 0,
      section80G: allowedSections["80G"] ?? 0,
      section80GG: allowedSections["80GG"] ?? 0,
      section80TTA: allowedSections["80TTA"] ?? 0,
      section80TTB: allowedSections["80TTB"] ?? 0,
      otherDeductions:
        (allowedSections["other"] ?? 0) +
        (allowedSections["80CCD(1B)"] ?? 0) +
        (allowedSections["80DD"] ?? 0) +
        (allowedSections["80DDB"] ?? 0) +
        (allowedSections["80EE"] ?? 0) +
        (allowedSections["80EEA"] ?? 0) +
        (allowedSections["80GGC"] ?? 0) +
        (allowedSections["80U"] ?? 0),
      totalDeductions: main.chapterVIA,
    },
    // HRA exemption is not available in the new regime.
    hra:
      input.hra && regime === "old"
        ? {
            hraReceived: input.hra.received,
            hraExempt: main.hraExempt,
            hraTaxable: Math.max(0, input.hra.received - main.hraExempt),
          }
        : null,
    taxBeforeSurcharge: main.taxBeforeSurcharge,
    surchargeGross: main.surchargeGross,
    surchargeAfterMarginalRelief: main.surcharge,
    surcharge: main.surcharge,
    taxAfterSurcharge: main.taxAfterSurcharge,
    rebate87A: main.rebate87A,
    taxAfterRebate: main.taxAfterRebate,
    cess: main.cess,
    totalTaxLiability: main.totalTax,
    regimeComparison: regimeComparisonResult,
    instalments,
    prepaidTax,
    totalShortfall,
    interest234A,
    interest234B: interest234BVal,
    interest234C: interest234CTotal,
    totalInterest,
    selfAssessmentTax,
    delayedFilingDays,
    delayedFilingPenalty: interest234A,
    warnings,
    methodology,
  };
}
