/**
 * Income-tax return computation — the arithmetic a CA firm signs off on before
 * a return is filed: head aggregation, house-property/HRA relief, loss set-off,
 * Chapter VI-A deductions with their statutory caps, slab tax, the s.87A rebate
 * (with marginal relief), surcharge (with marginal relief), cess, agricultural
 * income partial integration, special-rate capital gains and prepaid-tax netting.
 *
 * SCOPE AND HONESTY: rates and caps come from `india-tax.ts`, which carries a
 * labelled table per financial year. This engine uses the table for the FY in
 * the input — FY 2025-26 and FY 2024-25 are both registered — and says which one
 * it applied. It is arithmetic on caller-supplied income and deduction inputs;
 * it does not fetch live law and does not generate the filed JSON/PDF.
 *
 * Money is in RUPEES here (the API contract for this engine), converted once to
 * integer paise for the tax core so no intermediate figure drifts.
 */

import {
  INDIVIDUAL_REGIMES_BY_FY,
  INR,
  computeCorporateTax,
  computeEquityCapitalGains,
  computeHraExemption,
  computeIncomeTax,
  formatInr,
  slabTax,
  CORPORATE_REGIMES,
  type ChapterVIAInput,
  type TaxRegime,
} from "./india-tax";

export interface ItrComputation {
  fy: string;
  assesseeType: string;
  residentialStatus: string;
  regime: "old" | "new";
  grossTotalIncome: number;
  /** Gross total income less loss set-off (before Chapter VI-A). */
  totalIncomeAfterDeductions: number;
  /** Chapter VI-A actually allowed after caps. */
  chapterVIADeductions: number;
  hraExemption: number;
  agriculturalIncomeSetOff: number;
  /** Taxable income (basic income on which the slab runs). */
  basicIncome: number;
  taxBeforeRebate: number;
  rebate87A: number;
  /** Marginal relief at the 87A threshold. */
  rebateMarginalRelief: number;
  taxAfterRebate: number;
  surcharge: number;
  surchargeMarginalRelief: number;
  cess: number;
  totalTaxLiability: number;
  prepaidTax: number;
  netTaxPayableOrRefundable: number;
  formType: string;
  computationSteps: string[];
}

export interface ItrResult {
  computation: ItrComputation;
  warnings: string[];
  methodology: string[];
}

type AssesseeType = "individual" | "hir india" | "company" | "firm" | "llp" | "aop" | "boi" | "trust";

function resolveRegime(fy: string, kind: "old" | "new"): { regime: TaxRegime; exact: boolean } {
  const table = INDIVIDUAL_REGIMES_BY_FY[fy];
  if (table) return { regime: table[kind], exact: true };
  // No registered table for this FY: use the latest and shout about it.
  const latest = INDIVIDUAL_REGIMES_BY_FY["2025-26"]!;
  return { regime: latest[kind], exact: false };
}

/** Surcharge and cess for a non-individual base tax, with marginal relief at the
 * ₹1 crore / ₹10 crore thresholds for firms and companies. */
function nonIndividualTax(opts: {
  income: number;
  baseRatePct: number;
  bands: { above: number; ratePct: number }[];
  cessPct: number;
}): { baseTax: number; surcharge: number; marginalRelief: number; cess: number; total: number } {
  const baseTax = Math.round((opts.income * opts.baseRatePct) / 100);
  const baseTaxAt = (t: number) => Math.round((t * opts.baseRatePct) / 100);
  let band: { above: number; ratePct: number } | null = null;
  for (const b of [...opts.bands].sort((a, b) => a.above - b.above)) if (opts.income > b.above) band = b;

  let surcharge = 0;
  let marginalRelief = 0;
  if (band && baseTax > 0) {
    const raw = Math.round((baseTax * band.ratePct) / 100);
    const thresholdTax = baseTaxAt(band.above);
    const cap = thresholdTax + (opts.income - band.above);
    if (baseTax + raw > cap) {
      surcharge = Math.max(0, cap - baseTax);
      marginalRelief = raw - surcharge;
    } else {
      surcharge = raw;
    }
  }
  const cess = Math.round(((baseTax + surcharge) * opts.cessPct) / 100);
  return { baseTax, surcharge, marginalRelief, cess, total: baseTax + surcharge + cess };
}

export function computeItr(input: {
  fy: string;
  assesseeType: AssesseeType;
  residentialStatus: "resident" | "non-resident" | "not ordinarily resident";
  /** Regime to compute. Default "new" (the default regime u/s 115BAC). */
  regime?: "old" | "new";
  /** Apply the salary standard deduction here. Default false: the salary head
   * (computeSalaryHead) has normally applied it already. */
  applyStandardDeduction?: boolean;
  incomeHeads: {
    salary: number;
    houseProperty: number;
    businessProfession: number;
    capitalGains: number;
    otherSources: number;
    agricultural: number;
  };
  /**
   * Capital gains taxed at special rates. These amounts must be INCLUDED in
   * `incomeHeads.capitalGains`; they are carved out of the slab computation and
   * taxed at the 111A/112A rates.
   */
  capitalGainsSpecialRate?: { stcg?: number; ltcg?: number };
  deductions: {
    section80C: number;
    section80D: number;
    section80E: number;
    section80G: number;
    section80GG: number;
    section80TTA: number;
    section80TTB: number;
    /** 80CCD(1B) / 80CCD(2) etc. routed through `otherDeductions` by the caller. */
    nopNorm: number;
    otherDeductions: number;
    section80CCD2?: number;
  };
  hra: {
    received: number;
    paidRent: number;
    city: boolean;
    metro: boolean;
    actualRent: number;
    /** Basic + DA (the correct HRA salary basis). Defaults to the salary head. */
    basicAndDaSalary?: number;
  };
  losses: { bhplBroughtFwd: number; bhplSetOff: number; cglBroughtFwd: number; cglSetOff: number };
  scheduleAi: { interestPaid: number; interestReceived: number };
  prepaidTax: { tds: number; tcs: number; advanceTax: number; selfAssessment: number; demands: number };
  formType: "ITR-1" | "ITR-2" | "ITR-3" | "ITR-4" | "ITR-5" | "ITR-6" | "ITR-7";
  surcharges: { hvilag: boolean; healthcare: boolean };
}): ItrResult {
  const { fy, assesseeType, residentialStatus, incomeHeads, deductions, losses, scheduleAi, prepaidTax, formType } =
    input;
  const regimeKind = input.regime ?? "new";
  const { regime, exact: regimeExact } = resolveRegime(fy, regimeKind);
  const isIndividualLike =
    assesseeType === "individual" || assesseeType === "hir india" || assesseeType === "aop" || assesseeType === "boi";
  const warnings: string[] = [];
  const steps: string[] = [];

  const round = (n: number) => Math.round(n);
  const num = (n: number) => Math.max(0, round(n));

  // ---------------------------------------------------------------------
  // 1. Special-rate capital gains (carved out of the slab)
  // ---------------------------------------------------------------------
  const specialStcg = num(input.capitalGainsSpecialRate?.stcg ?? 0);
  const specialLtcg = num(input.capitalGainsSpecialRate?.ltcg ?? 0);
  const specialIncome = specialStcg + specialLtcg;
  if (specialIncome > 0 && !isIndividualLike) {
    warnings.push(
      "Special-rate capital-gain routing is only modelled for individuals/HUF/AOP/BOI; the entire gain is in the slab base.",
    );
  }
  const specialApplicable = specialIncome > 0 && isIndividualLike;
  const specialCg = specialApplicable
    ? computeEquityCapitalGains({ stcg: INR(specialStcg), ltcg: INR(specialLtcg) })
    : null;
  // Pre-cess, pre-surcharge special-rate tax (the main engine layers those).
  const specialTaxPreCess = specialCg ? (specialCg.stcgTax + specialCg.ltcgTax) / 100 : 0;
  const carvedOut = specialApplicable ? Math.min(specialIncome, Math.max(0, incomeHeads.capitalGains)) : 0;

  // ---------------------------------------------------------------------
  // 2. HRA exemption (old regime only) reduces salary
  // ---------------------------------------------------------------------
  let hraExemption = 0;
  if (regimeKind === "old" && isIndividualLike && input.hra.received > 0) {
    const basis = input.hra.basicAndDaSalary ?? incomeHeads.salary;
    const hra = computeHraExemption({
      salary: INR(Math.max(0, basis)),
      hraReceived: INR(Math.max(0, input.hra.received)),
      rentPaid: INR(Math.max(0, input.hra.actualRent || input.hra.paidRent)),
      metro: input.hra.metro,
    });
    hraExemption = Math.min(num(incomeHeads.salary), hra.exempt / 100);
    steps.push(
      `HRA exemption u/s 10(13A) ${formatInr(hra.exempt)} (least of HRA received, rent less 10% of salary, and ${input.hra.metro ? "50%" : "40%"} of salary).`,
    );
  } else if (input.hra.received > 0 && regimeKind === "new") {
    warnings.push("HRA exemption u/s 10(13A) is not available in the new regime; the claim was ignored.");
  }

  // ---------------------------------------------------------------------
  // 3. Head aggregation and loss set-off
  // ---------------------------------------------------------------------
  const salaryNet = Math.max(0, incomeHeads.salary - hraExemption);
  // Gross total income includes the special-rate gains; they are carved out
  // later, inside the tax core, not out of the head total.
  const grossTotalIncome =
    salaryNet +
    incomeHeads.houseProperty +
    incomeHeads.businessProfession +
    incomeHeads.capitalGains +
    incomeHeads.otherSources;

  if (losses.bhplSetOff > Math.max(0, incomeHeads.businessProfession)) {
    warnings.push(
      `Business loss set-off of ${input.losses.bhplSetOff} exceeds business income; it is limited to the business income for the year (unabsorbed loss must be carried forward).`,
    );
  }
  if (losses.cglSetOff > Math.max(0, incomeHeads.capitalGains)) {
    warnings.push("Capital-loss set-off exceeds the capital gains for the year; it is limited to those gains.");
  }
  const bhplSetOff = Math.min(num(losses.bhplSetOff), Math.max(0, incomeHeads.businessProfession));
  const cglSetOff = Math.min(num(losses.cglSetOff), Math.max(0, incomeHeads.capitalGains));
  const lossSetOff = bhplSetOff + cglSetOff;
  const totalIncomeAfterLoss = Math.max(0, grossTotalIncome - lossSetOff);
  const agriculturalIncome = num(incomeHeads.agricultural);

  // ---------------------------------------------------------------------
  // 4. Chapter VI-A (capped inside the tax core)
  // ---------------------------------------------------------------------
  // The tax core works in paise; these inputs arrive in rupees.
  const chapterVIA: ChapterVIAInput = {
    section80C: INR(num(deductions.section80C)),
    section80D: INR(num(deductions.section80D)),
    section80E: INR(num(deductions.section80E)),
    section80G: INR(num(deductions.section80G)),
    section80GG: INR(num(deductions.section80GG)),
    section80TTA: INR(num(deductions.section80TTA)),
    section80TTB: INR(num(deductions.section80TTB)),
    section80CCD2: INR(num(deductions.section80CCD2 ?? 0)),
    other: INR(num(deductions.nopNorm) + num(deductions.otherDeductions)),
  };
  const claimedTotal = Object.values(chapterVIA).reduce<number>((s, v) => s + (v ?? 0), 0) / 100;

  steps.push(
    `FY ${fy}; assessee ${assesseeType}; status ${residentialStatus}; regime ${regimeKind}; form ${formType}.`,
    `Gross total income ${formatInr(INR(grossTotalIncome))} = salary ${formatInr(INR(salaryNet))}` +
      (hraExemption > 0 ? ` (after HRA exemption ${formatInr(INR(hraExemption))})` : "") +
      ` + house property ${formatInr(INR(incomeHeads.houseProperty))} + business ${formatInr(INR(incomeHeads.businessProfession))} + capital gains ${formatInr(INR(incomeHeads.capitalGains))} + other sources ${formatInr(INR(incomeHeads.otherSources))}.`,
    `Loss set-off ${formatInr(INR(lossSetOff))} (business ${formatInr(INR(bhplSetOff))}, capital ${formatInr(INR(cglSetOff))}); brought forward business ${formatInr(INR(losses.bhplBroughtFwd))}, capital ${formatInr(INR(losses.cglBroughtFwd))}.`,
    `Income after loss set-off ${formatInr(INR(totalIncomeAfterLoss))}.`,
    `Chapter VI-A claimed ${formatInr(INR(claimedTotal))}.`,
  );

  // ---------------------------------------------------------------------
  // 5. Tax
  // ---------------------------------------------------------------------
  let basicIncome = 0;
  let taxBeforeRebate = 0;
  let rebate87A = 0;
  let rebateMarginalRelief = 0;
  let taxAfterRebate = 0;
  let surcharge = 0;
  let surchargeMarginalRelief = 0;
  let cess = 0;
  let totalTaxLiability = 0;
  let chapterVIADeductions = 0;

  if (isIndividualLike) {
    const res = computeIncomeTax({
      grossIncome: INR(totalIncomeAfterLoss),
      deductionBreakup: chapterVIA,
      regime,
      applyStandardDeduction: input.applyStandardDeduction === true,
      residentIndividual: residentialStatus === "resident",
      specialRateIncome: INR(specialApplicable ? carvedOut : 0),
      specialRateTax: INR(specialTaxPreCess),
      agriculturalIncome: INR(agriculturalIncome),
    });
    chapterVIADeductions = res.deductions / 100;
    basicIncome = res.taxableIncome / 100;
    taxBeforeRebate = res.slabTax / 100;
    rebate87A = res.rebate / 100;
    rebateMarginalRelief = res.rebateMarginalRelief / 100;
    taxAfterRebate = res.taxAfterRebate / 100;
    surcharge = res.surcharge / 100;
    surchargeMarginalRelief = res.surchargeMarginalRelief / 100;
    cess = res.cess / 100;
    totalTaxLiability = res.totalTax / 100;
  } else {
    // Non-individual: no Chapter VI-A; company / firm / trust rates.
    chapterVIADeductions = 0;
    basicIncome = totalIncomeAfterLoss;
    if (assesseeType === "company") {
      const corp = computeCorporateTax({
        totalIncome: INR(totalIncomeAfterLoss),
        regime: CORPORATE_REGIMES.normal!,
      });
      taxBeforeRebate = corp.baseTax / 100;
      surcharge = corp.surcharge / 100;
      surchargeMarginalRelief = corp.marginalRelief / 100;
      cess = corp.cess / 100;
      totalTaxLiability = corp.totalTax / 100;
      taxAfterRebate = taxBeforeRebate;
    } else {
      const rate = assesseeType === "trust" ? 30 : 30; // firm/LLP/trust base rate
      const bands =
        assesseeType === "trust"
          ? [
              { above: INR(5000000), ratePct: 10 },
              { above: INR(10000000), ratePct: 15 },
            ]
          : [{ above: INR(10000000), ratePct: 12 }];
      const r = nonIndividualTax({
        income: INR(totalIncomeAfterLoss),
        baseRatePct: rate,
        bands,
        cessPct: regime.cessPct,
      });
      taxBeforeRebate = r.baseTax / 100;
      taxAfterRebate = taxBeforeRebate;
      surcharge = r.surcharge / 100;
      surchargeMarginalRelief = r.marginalRelief / 100;
      cess = r.cess / 100;
      totalTaxLiability = r.total / 100;
      if (assesseeType === "trust") {
        warnings.push(
          "Trust taxation is computed at 30% with surcharge; the maximum-marginal-rate regime for charitable trusts is not modelled here.",
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // 6. Prepaid tax and net position
  // ---------------------------------------------------------------------
  const prepaid =
    num(prepaidTax.tds) +
    num(prepaidTax.tcs) +
    num(prepaidTax.advanceTax) +
    num(prepaidTax.selfAssessment) +
    num(prepaidTax.demands);
  const netTaxPayableOrRefundable = totalTaxLiability - prepaid;

  steps.push(
    `Taxable income ${formatInr(INR(basicIncome))} (Chapter VI-A allowed ${formatInr(INR(chapterVIADeductions))}).`,
    `Slab/special-rate tax before rebate ${formatInr(INR(taxBeforeRebate))}.`,
    `Rebate u/s 87A ${formatInr(INR(rebate87A))}${rebateMarginalRelief > 0 ? ` (marginal relief ${formatInr(INR(rebateMarginalRelief))})` : ""}.`,
    `Tax after rebate ${formatInr(INR(taxAfterRebate))}; surcharge ${formatInr(INR(surcharge))}${surchargeMarginalRelief > 0 ? ` (marginal relief ${formatInr(INR(surchargeMarginalRelief))})` : ""}.`,
    `Health & education cess ${formatInr(INR(cess))}; total liability ${formatInr(INR(totalTaxLiability))}.`,
    `Prepaid tax ${formatInr(INR(prepaid))} (TDS ${formatInr(INR(prepaidTax.tds))}, TCS ${formatInr(INR(prepaidTax.tcs))}, advance ${formatInr(INR(prepaidTax.advanceTax))}, self-assessment ${formatInr(INR(prepaidTax.selfAssessment))}); net ${formatInr(INR(netTaxPayableOrRefundable))}.`,
  );

  if (!regimeExact) {
    warnings.push(
      `No rate table is registered for FY ${fy}; the FY 2025-26 table was applied. Register the correct table before relying on this computation.`,
    );
  }
  if (input.applyStandardDeduction !== true) {
    warnings.push(
      "No standard deduction u/s 16(ia) was applied here; pass applyStandardDeduction: true only when incomeHeads.salary is gross salary.",
    );
  }
  if (specialApplicable) {
    warnings.push(
      "Special-rate capital gains were taxed under 111A/112A and excluded from the slab; the basic-exemption adjustment against those gains is the caller's to determine.",
    );
  }
  if (agriculturalIncome > 5000) {
    warnings.push(
      "Agricultural income was partially integrated for rate purposes u/s 2(1A); it does not form part of gross total income.",
    );
  }
  void scheduleAi;

  const computation: ItrComputation = {
    fy,
    assesseeType,
    residentialStatus,
    regime: regimeKind,
    grossTotalIncome,
    totalIncomeAfterDeductions: totalIncomeAfterLoss,
    chapterVIADeductions,
    hraExemption,
    agriculturalIncomeSetOff: agriculturalIncome,
    basicIncome,
    taxBeforeRebate,
    rebate87A,
    rebateMarginalRelief,
    taxAfterRebate,
    surcharge,
    surchargeMarginalRelief,
    cess,
    totalTaxLiability,
    prepaidTax: prepaid,
    netTaxPayableOrRefundable,
    formType,
    computationSteps: steps,
  };

  return {
    computation,
    warnings,
    methodology: [
      `Rates: ${regime.label} (${regime.ay}); slabs applied marginally, rounding each statutory amount to the rupee.`,
      "Chapter VI-A is capped per section (80C ₹1.5L; 80D ₹25K/₹50K; 80TTA ₹10K; 80TTB ₹50K; 80GG ₹60K) and disallowed in the new regime except 80CCD(2).",
      "The s.87A rebate is applied against normal-rate tax only, with marginal relief; surcharge carries its own marginal relief at each threshold.",
      "This is a reproducible computation summary; it does not generate the filed return JSON/PDF or value perquisites.",
    ],
  };
}

export { formatInr, slabTax };
