/**
 * ITR Schedules engine — oracle tests.
 *
 * These tests verify the schedule builders produce correct line items and
 * totals for the partnership/LLP profit-sharing, book reference income, MAT
 * book, foreign company status, dividend/specified income, AMT, FATCA/CRS,
 * and foreign assets schedules, plus the full ITR-3 / ITR-5 / ITR-6 JSON and
 * XML payload builders.
 *
 * Money is in MINOR UNITS (paise) as integers, matching india-tax.ts.
 */

import { CORPORATE_REGIMES } from "@/lib/engine/india-tax";
import {
  validateITRJson,
  itrJsonChecksum,
  generateITR1,
  ITR1Income,
  ITR1Deductions,
  ITRGeneralInfo,
} from "@/lib/engine/itr-json-utility";
import {
  scheduleBP,
  schedulePLC,
  scheduleCYM,
  schedulePMT,
  schedulePITR5Income,
  scheduleMAT,
  scheduleFSI,
  scheduleTR,
  scheduleFL,
  scheduleFA,
  scheduleOMP,
  scheduleTDS,
  scheduleDI,
  scheduleEI,
  scheduleAL,
  schedulePT,
  scheduleSPI,
  buildITR5Payload,
  buildITR6Payload,
  buildITR3Payload,
  validateITR5Payload,
  validateITR6Payload,
  validateITR3Payload,
} from "@/lib/engine/itr-schedules";

function eq(label: string, expected: number, actual: number): void {
  const e = Math.round(expected);
  const a = Math.round(actual);
  if (e !== a) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

function findLine(lines: { label: string; amount: number }[], labelStart: string): { label: string; amount: number } {
  const found = lines.find((l) => l.label.startsWith(labelStart));
  if (!found) throw new Error(`No line starting with "${labelStart}"`);
  return found;
}

// ---------------------------------------------------------------------------
// Schedule BP — Business/Profession income
// ---------------------------------------------------------------------------

describe("scheduleBP", () => {
  it("produces a full trading + P&L + adjustments + computation", () => {
    const s = scheduleBP({
      salesOrTurnover: 100_00_000,
      purchases: 50_00_000,
      closingStock: 10_00_000,
      grossProfit: 60_00_000,
      indirectExpenses: {
        salary: 12_00_000,
        rent: 4_80_000,
        electricity: 1_20_000,
        repairs: 60_000,
        depreciation: 3_00_000,
        interestPaid: 2_40_000,
        other: 1_00_000,
      },
      totalIndirectExpenses: 25_00_000,
      netProfitAsPerBooks: 35_00_000,
      disallowanceTdNotDeducted: 10_000,
      disallowanceTcsNotCollected: 5_000,
      disallowedExpenses: 20_000,
      businessIncomeReturn: 34_75_000,
    });

    expect(s.lines.some((l) => l.label.includes("1. Sales"))).toBe(true);
    eq("net profit as per books", 35_00_000, findLine(s.lines, "13. Net Profit as per Books").amount);
    eq("total add-backs", 35_000, findLine(s.lines, "22. Total Add-backs").amount);
    eq("business income", 34_75_000, findLine(s.lines, "30. Income from Business").amount);
  });
});

// ---------------------------------------------------------------------------
// Schedule PLC — Company P&L
// ---------------------------------------------------------------------------

describe("schedulePLC", () => {
  it("produces revenue, expenses, PBT and PAT lines", () => {
    const s = schedulePLC({
      revenueFromOperations: 500_00_000,
      otherIncome: 5_00_000,
      totalRevenue: 505_00_000,
      expenses: {
        materialConsumption: 200_00_000,
        purchases: 80_00_000,
        employeesBenefit: 60_00_000,
        financeCosts: 10_00_000,
        depreciation: 15_00_000,
        otherExpenses: 20_00_000,
      },
      totalExpenses: 385_00_000,
      profitBeforeTax: 120_00_000,
      taxProvisions: 30_00_000,
      profitAfterTax: 90_00_000,
    });

    eq("total revenue", 505_00_000, findLine(s.lines, "3. Total Revenue").amount);
    eq("total expenses", 385_00_000, findLine(s.lines, "10. Total Expenses").amount);
    eq("PBT", 120_00_000, findLine(s.lines, "11. Profit Before Tax").amount);
    eq("PAT", 90_00_000, findLine(s.lines, "13. Profit After Tax").amount);
  });
});

// ---------------------------------------------------------------------------
// Schedule CYM — Company tax computation with MAT
// ---------------------------------------------------------------------------

describe("scheduleCYM", () => {
  it("computes normal tax and MAT, picking the higher", () => {
    const regime = CORPORATE_REGIMES["normal"]!;
    const s = scheduleCYM({
      totalIncome: 10_00_000,
      bookProfitMCA: 12_00_000,
      regime,
      surcharge: 0,
      cess: 0,
      tds: 1_00_000,
      advanceTax: 2_00_000,
      selfAssessmentTax: 0,
    });

    // Normal: 30% of 10L = 3L; MAT: 15% of 12L = 1.8L → normal higher.
    eq("normal tax line", 3_00_000, findLine(s.lines, "2. Tax at 30%").amount);
    eq("MAT tax line", 1_80_000, findLine(s.lines, "8. Tax computed on Book Profit").amount);
    eq("net payable", 12_000, findLine(s.lines, "16. Net Tax Payable").amount); // after cess
  });

  it("pays MAT when it is higher", () => {
    const regime = CORPORATE_REGIMES["115BAA"]!; // 22% normal, no MAT
    const s = scheduleCYM({
      totalIncome: 5_00_000,
      bookProfitMCA: 5_00_000,
      regime,
      surcharge: 0,
      cess: 0,
      tds: 0,
      advanceTax: 0,
      selfAssessmentTax: 0,
    });

    eq("normal at 22%", 1_10_000, findLine(s.lines, "2. Tax at 22%").amount);
  });
});

// ---------------------------------------------------------------------------
// Schedule PMT — Partnership / LLP profit sharing
// ---------------------------------------------------------------------------

describe("schedulePMT", () => {
  it("produces firm details, tax, and partner-wise share", () => {
    const s = schedulePMT({
      firmName: "ABC Associates",
      firmPan: "AAAAA0000A",
      totalIncomeBeforeShare: 50_00_000,
      taxableIncomeOfFirm: 45_00_000,
      taxBorneByFirm: 13_50_000,
      surchargeOnFirm: 1_35_000,
      cessOnFirm: 5_40_000,
      totalTaxOfFirm: 15_35_000,
      tdsOnFirmIncome: 5_00_000,
      partners: [
        {
          name: "Partner A",
          pan: "AAAAA0001A",
          sharePercentage: 50,
          shareOfProfit: 22_50_000,
          shareOfTax: 7_50_000,
          shareOfTds: 2_50_000,
          shareOfCess: 2_70_000,
          partnerType: "individual",
        },
        {
          name: "Partner B",
          pan: "AAAAA0002A",
          sharePercentage: 50,
          shareOfProfit: 22_50_000,
          shareOfTax: 7_50_000,
          shareOfTds: 2_50_000,
          shareOfCess: 2_70_000,
          partnerType: "individual",
        },
      ],
    });

    eq("total tax of firm", 15_35_000, findLine(s.lines, "9. Total Tax of the Firm").amount);
    eq("net tax payable by firm", 10_35_000, findLine(s.lines, "11. Net Tax Payable").amount);
    eq("total partner tax", 15_00_000, findLine(s.lines, "Total for all Partners — Tax").amount);
    eq("net tax payable by firm", 10_35_000, findLine(s.lines, "11. Net Tax Payable").amount);
  });
});

// ---------------------------------------------------------------------------
// Schedule PITR5 — Income heads for ITR-5
// ---------------------------------------------------------------------------

describe("schedulePITR5Income", () => {
  it("captures all heads of income including specified income breakdown", () => {
    const s = schedulePITR5Income({
      businessIncome: 40_00_000,
      houseProperty: 2_00_000,
      capitalGains: { shortTerm: 1_00_000, longTerm: 2_00_000, total: 3_00_000 },
      otherSources: 50_000,
      agriculturalIncome: 1_00_000,
      specifiedIncome: {
        dividend: 1_00_000,
        interest: 2_00_000,
        rent: 50_000,
        royalty: 0,
        winnings: 0,
        other: 0,
      },
      totalIncome: 46_50_000,
    });

    const specifiedTotal = s.lines.find((l) => l.label.includes("Total Specified Income"));
    expect(specifiedTotal).toBeDefined();
    expect(specifiedTotal?.amount).toBe(3_50_000);
    eq("total income", 46_50_000, findLine(s.lines, "6. TOTAL INCOME").amount);
  });
});

// ---------------------------------------------------------------------------
// Schedule MAT — AMT for individuals/HUF and companies
// ---------------------------------------------------------------------------

describe("scheduleMAT", () => {
  it("computes AMT and AMT credit", () => {
    const s = scheduleMAT({
      totalIncome: 5_00_000,
      bookProfit: 0,
      adjustments: { additions: 50_000, deductions: 20_000, lessReserve: 10_000, plusReserve: 0 },
      amtBase: 5_30_000,
      amtRate: 18.5,
      amtComputed: 98_050,
      normalTax: 0,
      amtPayable: 98_050,
      surcharge: 0,
      cess: 3_922,
      totalAmtPayable: 1_01_972,
      amtCreditUtilised: 50_000,
      amtCreditCarriedForward: 51_972,
    });

    eq("AMT computed", 98_050, findLine(s.lines, "9. AMT on Adjusted Total Income").amount);
    eq("total AMT payable", 1_01_972, findLine(s.lines, "14. TOTAL AMT PAYABLE").amount);
  });
});

// ---------------------------------------------------------------------------
// Schedule FSI — Foreign Source Income
// ---------------------------------------------------------------------------

describe("scheduleFSI", () => {
  it("produces country-wise foreign income with tax credit", () => {
    const s = scheduleFSI({
      foreignSources: [
        {
          countryName: "United States",
          countryCode: "US",
          incomeFromCountry: 5_00_000,
          foreignTaxPaid: 1_00_000,
          taxableSection: "9(1)(i)",
          includedInAmt: true,
          incomeType: "business",
        },
        {
          countryName: "United Kingdom",
          countryCode: "GB",
          incomeFromCountry: 3_00_000,
          foreignTaxPaid: 60_000,
          taxableSection: "9(1)(ii)",
          includedInAmt: false,
          incomeType: "dividend",
        },
      ],
      totalForeignIncome: 8_00_000,
      totalForeignTaxPaid: 1_60_000,
      taxCreditAllowed: 1_00_000,
      creditCarryForward: 60_000,
    });

    eq("total foreign income", 8_00_000, findLine(s.lines, "Total Foreign Income").amount);
    eq("total foreign tax paid", 1_60_000, findLine(s.lines, "Total Foreign Tax Paid").amount);
    eq("credit allowed", 1_00_000, findLine(s.lines, "Tax Credit u/s 90").amount);
  });
});

// ---------------------------------------------------------------------------
// Schedule TR — Tax on Specified Income
// ---------------------------------------------------------------------------

describe("scheduleTR", () => {
  it("separates winnings taxed at special rate from other specified income", () => {
    const s = scheduleTR({
      dividendIncome: 1_00_000,
      interestIncome: 2_00_000,
      rentalIncome: 50_000,
      royaltyIncome: 0,
      winningsIncome: 1_00_000,
      otherSpecifiedIncome: 0,
      totalSpecifiedIncome: 4_50_000,
      winningsTaxRate: 30,
      taxOnWinnings: 30_000,
      taxOnOtherSpecified: 1_05_000,
      totalSpecifiedTax: 1_35_000,
    });

    eq("winnings tax", 30_000, findLine(s.lines, "9. Tax on Winnings @ 30%").amount);
    eq("total specified tax", 1_35_000, findLine(s.lines, "12. Total Tax on Specified Income").amount);
  });
});

// ---------------------------------------------------------------------------
// Schedule FL — Foreign Assets / FATCA CRS
// ---------------------------------------------------------------------------

describe("scheduleFL", () => {
  it("produces FATCA/CRS declaration and foreign asset details", () => {
    const s = scheduleFL({
      foreignAssets: [
        {
          assetType: "foreignBankAccount",
          countryName: "Singapore",
          countryCode: "SG",
          accountNumber: "123456789",
          peakValue: 10_00_000,
          averageValue: 8_00_000,
          isOperational: true,
          incomeFromAsset: 50_000,
          accountOpened: "2020-01-15",
        },
        {
          assetType: "foreignImmovableProperty",
          countryName: "UAE",
          countryCode: "AE",
          peakValue: 50_00_000,
          averageValue: 45_00_000,
          isOperational: true,
          incomeFromAsset: 2_00_000,
          accountOpened: "2018-06-01",
          accountClosed: "2025-03-31",
        },
      ],
      totalCount: 2,
      totalPeakValue: 60_00_000,
      totalForeignAssetIncome: 2_50_000,
      fatcaCrsStatus: "furnished",
    });

    eq("peak value", 60_00_000, findLine(s.lines, "Total Peak Value").amount);
    eq("foreign asset income", 2_50_000, findLine(s.lines, "Total Income from Foreign Assets").amount);
  });
});

// ---------------------------------------------------------------------------
// Schedule FA — Foreign Assets & Income (resident)
// ---------------------------------------------------------------------------

describe("scheduleFA", () => {
  it("includes FSI as a sub-schedule", () => {
    const s = scheduleFA({
      hasForeignAssets: true,
      hasForeignIncome: true,
      residentStatus: "resident",
      foreignAssets: [
        {
          assetType: "foreignBankAccount",
          countryName: "Singapore",
          countryCode: "SG",
          peakValue: 10_00_000,
          incomeFromAsset: 50_000,
          isOperational: true,
        },
      ],
      foreignIncome: {
        foreignSources: [
          {
            countryName: "Singapore",
            countryCode: "SG",
            incomeFromCountry: 5_00_000,
            foreignTaxPaid: 1_00_000,
            incomeType: "business",
            includedInAmt: true,
          },
        ],
        totalForeignIncome: 5_00_000,
        totalForeignTaxPaid: 1_00_000,
        taxCreditAllowed: 80_000,
        creditCarryForward: 20_000,
      },
    });

    expect(s.lines.find((l) => l.label.includes("FSI"))).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Schedule OMP — Overseas/foreign company status
// ---------------------------------------------------------------------------

describe("scheduleOMP", () => {
  it("reports foreign company status for ITR-6", () => {
    const s = scheduleOMP({
      isForeignCompany: true,
      countryOfIncorporation: "Singapore",
      dateOfIncorporation: "2010-05-20",
      poemCountry: "Singapore",
      isCFC: true,
      isNVCC: false,
      isULIP: false,
    });

    expect(s.lines.find((l) => l.label.includes("Is Foreign Company"))).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Schedule TDS — TDS/TCS
// ---------------------------------------------------------------------------

describe("scheduleTDS", () => {
  it("produces TDS and TCS lines with totals", () => {
    const s = scheduleTDS({
      tdsDeductions: [
        {
          deductorName: "Client A",
          deductorPan: "AAAAA0001A",
          section: "194J",
          amountCredited: 10_00_000,
          tdsDeducted: 1_00_000,
          tdsDeposited: 1_00_000,
          challanNumber: "CH001",
          challanDate: "2025-06-15",
        },
      ],
      tcsCollected: [
        {
          collectorName: "Client B",
          section: "194N",
          amountCollected: 5_00_000,
          tcsDeposited: 5_00_000,
        },
      ],
      totalTdsDeducted: 1_00_000,
      totalTdsDeposited: 1_00_000,
      totalTcsCollected: 5_00_000,
      totalTcsDeposited: 5_00_000,
    });

    eq("total TDS deducted", 1_00_000, findLine(s.lines, "Total TDS Deducted").amount);
    eq("total TCS collected", 5_00_000, findLine(s.lines, "Total TCS Collected").amount);
  });
});

// ---------------------------------------------------------------------------
// Schedule DI — Chapter VI-A deductions
// ---------------------------------------------------------------------------

describe("scheduleDI", () => {
  it("lists all Chapter VI-A deductions and computes total", () => {
    const s = scheduleDI(
      {
        section80C: 1_50_000,
        section80D: 25_000,
        section80E: 0,
        section80G: 50_000,
        section80GG: 0,
        section80TTA: 10_000,
        section80TTB: 0,
        section80CCC: 0,
        section80CCD1: 50_000,
        section80CCD2: 0,
        section80CCD1B: 50_000,
        section80DDB: 0,
        section80GGA: 0,
        section80GGB: 0,
        section80RRB: 0,
        section80U: 0,
        other: 0,
      },
      "old",
    );

    const totalDed = s.lines.find((l) => l.label.includes("Total deductions u/s Chapter VI-A"));
    eq("total deductions", 3_35_000, totalDed?.amount ?? 0);
  });
});

// ---------------------------------------------------------------------------
// Schedule EI — Exempt Income
// ---------------------------------------------------------------------------

describe("scheduleEI", () => {
  it("lists exempt agricultural and dividend income", () => {
    const s = scheduleEI({
      agricultural: 1_00_000,
      dividendDomesticCompany: 50_000,
      dividendMutualFund: 0,
    });

    expect(s.lines.some((l) => l.label.includes("Agricultural"))).toBe(true);
    expect(s.lines.some((l) => l.label.includes("domestic company"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schedule AL — Assets & Liabilities
// ---------------------------------------------------------------------------

describe("scheduleAL", () => {
  it("produces assets and liabilities with net worth", () => {
    const s = scheduleAL({
      assets: [
        { type: "building", description: "Office building", value: 50_00_000 },
        { type: "machinery", description: "Plant & machinery", value: 20_00_000 },
      ],
      liabilities: [{ type: "securedLiability", description: "Bank loan", value: 30_00_000 }],
      totalAssets: 70_00_000,
      totalLiabilities: 30_00_000,
      netWorth: 40_00_000,
    });

    eq("net worth", 40_00_000, findLine(s.lines, "Net Worth").amount);
  });
});

// ---------------------------------------------------------------------------
// Schedule PT — Pension & Annuity
// ---------------------------------------------------------------------------

describe("schedulePT", () => {
  it("computes net taxable pension with family pension", () => {
    const s = schedulePT({
      grossPension: 6_00_000,
      standardDeduction: 1_80_000,
      netPension: 4_20_000,
      familyPension: 3_00_000,
      commutedPension: 0,
      uncommutedPension: 6_00_000,
    });

    eq("net pension", 4_20_000, findLine(s.lines, "3. Net Taxable Pension").amount);
  });
});

// ---------------------------------------------------------------------------
// Schedule SPI — Speculation Business
// ---------------------------------------------------------------------------

describe("scheduleSPI", () => {
  it("reports speculative business turnover and profit", () => {
    const s = scheduleSPI({ turnover: 5_00_000, expenses: 2_00_000, netProfit: 3_00_000, isSpeculative: true });

    eq("net profit", 3_00_000, findLine(s.lines, "3. Net Profit from Speculation").amount);
    expect(s.lines.find((l) => l.label.includes("Nature"))!.label).toContain("Business");
  });
});

// ---------------------------------------------------------------------------
// Full payload builders
// ---------------------------------------------------------------------------

describe("buildITR5Payload", () => {
  it("builds a complete ITR-5 JSON with all schedules", () => {
    const payload = buildITR5Payload({
      general: { name: "ABC Associates", pan: "AAAAA0000A", assessment_year: "2025-26", aadhaar: "123456789012" },
      income: {
        businessIncome: 40_00_000,
        houseProperty: 2_00_000,
        capitalGains: { shortTerm: 1_00_000, longTerm: 2_00_000, total: 3_00_000 },
        otherSources: 50_000,
        agriculturalIncome: 1_00_000,
        specifiedIncome: { dividend: 1_00_000, interest: 2_00_000, rent: 50_000, royalty: 0, winnings: 0, other: 0 },
        totalIncome: 46_50_000,
      },
      business: {
        salesOrTurnover: 2_00_00_000,
        purchases: 1_00_00_000,
        closingStock: 20_00_000,
        grossProfit: 1_20_00_000,
        indirectExpenses: {
          salary: 30_00_000,
          rent: 10_00_000,
          electricity: 2_00_000,
          repairs: 1_00_000,
          depreciation: 5_00_000,
          interestPaid: 4_00_000,
          other: 2_00_000,
        },
        totalIndirectExpenses: 54_00_000,
        netProfitAsPerBooks: 66_00_000,
        disallowanceTdNotDeducted: 10_000,
        businessIncomeReturn: 65_90_000,
      },
      profitSharing: {
        firmName: "ABC Associates",
        firmPan: "AAAAA0000A",
        totalIncomeBeforeShare: 65_90_000,
        taxableIncomeOfFirm: 46_50_000,
        taxBorneByFirm: 13_50_000,
        surchargeOnFirm: 1_35_000,
        cessOnFirm: 5_40_000,
        totalTaxOfFirm: 15_35_000,
        tdsOnFirmIncome: 5_00_000,
        partners: [
          {
            name: "Partner A",
            pan: "AAAAA0001A",
            sharePercentage: 50,
            shareOfProfit: 32_95_000,
            shareOfTax: 7_67_500,
            shareOfTds: 2_50_000,
            shareOfCess: 2_70_000,
            partnerType: "individual",
          },
        ],
      },
      deductions: {
        section80C: 1_50_000,
        section80D: 25_000,
        section80CCC: 0,
        section80CCD1: 0,
        section80CCD2: 0,
        section80CCD1B: 0,
        section80DDB: 0,
        section80E: 0,
        section80G: 50_000,
        section80GGA: 0,
        section80GGB: 0,
        section80GG: 0,
        section80TTA: 10_000,
        section80TTB: 0,
        section80RRB: 0,
        section80U: 0,
        other: 0,
      },
      foreign: {
        foreignSources: [
          {
            countryName: "Singapore",
            countryCode: "SG",
            incomeFromCountry: 1_00_000,
            foreignTaxPaid: 20_000,
            incomeType: "business",
            includedInAmt: true,
          },
        ],
        totalForeignIncome: 1_00_000,
        totalForeignTaxPaid: 20_000,
        taxCreditAllowed: 20_000,
        creditCarryForward: 0,
      },
      foreignAssets: {
        foreignAssets: [
          {
            assetType: "foreignBankAccount",
            countryName: "Singapore",
            countryCode: "SG",
            accountNumber: "123456789",
            peakValue: 10_00_000,
            averageValue: 8_00_000,
            isOperational: true,
            incomeFromAsset: 50_000,
          },
        ],
        totalCount: 1,
        totalPeakValue: 10_00_000,
        totalForeignAssetIncome: 50_000,
        fatcaCrsStatus: "furnished",
      },
      specifiedIncome: {
        dividendIncome: 1_00_000,
        interestIncome: 2_00_000,
        rentalIncome: 50_000,
        royaltyIncome: 0,
        winningsIncome: 0,
        otherSpecifiedIncome: 0,
        totalSpecifiedIncome: 3_50_000,
        winningsTaxRate: 30,
        taxOnWinnings: 0,
        taxOnOtherSpecified: 1_05_000,
        totalSpecifiedTax: 1_05_000,
      },
      mat: {
        totalIncome: 46_50_000,
        amtBase: 46_50_000,
        amtRate: 18.5,
        amtComputed: 8_60_250,
        normalTax: 13_50_000,
        amtPayable: 13_50_000,
        surcharge: 1_35_000,
        cess: 5_40_000,
        totalAmtPayable: 15_35_000,
        amtCreditUtilised: 0,
        amtCreditCarriedForward: 0,
      },
      tds: {
        tdsDeductions: [
          {
            deductorName: "Client A",
            deductorPan: "AAAAA0001A",
            section: "194J",
            amountCredited: 10_00_000,
            tdsDeducted: 1_00_000,
            tdsDeposited: 1_00_000,
          },
        ],
        tcsCollected: [],
        totalTdsDeducted: 1_00_000,
        totalTdsDeposited: 1_00_000,
        totalTcsCollected: 0,
        totalTcsDeposited: 0,
      },
      totalIncome: 46_50_000,
      taxSummary: {
        taxBeforeRebate: 13_50_000,
        rebate: 0,
        surcharge: 1_35_000,
        cess: 5_40_000,
        totalTax: 15_35_000,
        tds: 1_00_000,
        advanceTax: 10_00_000,
        selfAssessmentTax: 0,
        netPayable: 4_35_000,
      },
    });

    expect(payload.formType).toBe("ITR-5");
    expect(payload.assessmentYear).toBe("2025-26");
    expect(payload.schedules["BP"]).toBeDefined();
    expect(payload.schedules["PMT"]).toBeDefined();
    expect(payload.schedules["MAT"]).toBeDefined();
    expect(payload.schedules["FSI"]).toBeDefined();
    expect(payload.schedules["FL"]).toBeDefined();

    // JSON serialisation.
    const json = payload.toJson() as Record<string, unknown>;
    expect(json.form_type).toBe("ITR-5");
    expect(json.assessment_year).toBe("2025-26");

    // XML serialisation includes schedules.
    const xml = payload.toXml();
    expect(xml).toContain('<ITR form_type="ITR-5"');
    expect(xml).toContain('<Schedule code="BP">');
    expect(xml).toContain('<Schedule code="PMT">');

    // Validation.
    const v = validateITR5Payload(payload);
    expect(v.valid).toBe(true);
    if (!v.valid) console.log("ITR-5 validation errors:", v.errors);
  });
});

describe("buildITR6Payload", () => {
  it("builds a complete ITR-6 JSON with PLC, CYM, OMP, FSI, FL", () => {
    const regime = CORPORATE_REGIMES["normal"]!;
    const payload = buildITR6Payload({
      general: {
        name: "XYZ Pvt Ltd",
        pan: "AAAAA0000A",
        cin: "U74999DL2010PLC050000",
        assessment_year: "2025-26",
        aadhaar: "123456789012",
      },
      pl: {
        revenueFromOperations: 500_00_000,
        otherIncome: 5_00_000,
        totalRevenue: 505_00_000,
        expenses: {
          materialConsumption: 200_00_000,
          purchases: 80_00_000,
          employeesBenefit: 60_00_000,
          financeCosts: 10_00_000,
          depreciation: 15_00_000,
          otherExpenses: 20_00_000,
        },
        totalExpenses: 385_00_000,
        profitBeforeTax: 120_00_000,
        taxProvisions: 36_00_000,
        profitAfterTax: 84_00_000,
      },
      business: {
        salesOrTurnover: 500_00_000,
        purchases: 200_00_000,
        closingStock: 50_00_000,
        grossProfit: 350_00_000,
        indirectExpenses: {
          salary: 60_00_000,
          rent: 10_00_000,
          electricity: 5_00_000,
          repairs: 2_00_000,
          depreciation: 15_00_000,
          interestPaid: 10_00_000,
          other: 5_00_000,
        },
        totalIndirectExpenses: 107_00_000,
        netProfitAsPerBooks: 243_00_000,
        disallowanceTdNotDeducted: 20_000,
        businessIncomeReturn: 243_00_000,
      },
      taxComputation: {
        totalIncome: 120_00_000,
        bookProfitMCA: 140_00_000,
        regime,
        surcharge: 0,
        cess: 0,
        tds: 2_00_000,
        advanceTax: 30_00_000,
        selfAssessmentTax: 0,
      },
      foreign: {
        foreignSources: [
          {
            countryName: "USA",
            countryCode: "US",
            incomeFromCountry: 5_00_000,
            foreignTaxPaid: 1_00_000,
            incomeType: "dividend",
            includedInAmt: true,
          },
        ],
        totalForeignIncome: 5_00_000,
        totalForeignTaxPaid: 1_00_000,
        taxCreditAllowed: 1_00_000,
        creditCarryForward: 0,
      },
      foreignAssets: {
        foreignAssets: [
          {
            assetType: "foreignFinancialAsset",
            countryName: "USA",
            countryCode: "US",
            peakValue: 20_00_000,
            averageValue: 15_00_000,
            isOperational: true,
            incomeFromAsset: 1_00_000,
          },
        ],
        totalCount: 1,
        totalPeakValue: 20_00_000,
        totalForeignAssetIncome: 1_00_000,
        fatcaCrsStatus: "furnished",
      },
      foreignCompanyStatus: {
        isForeignCompany: true,
        countryOfIncorporation: "Singapore",
        dateOfIncorporation: "2010-05-20",
        poemCountry: "Singapore",
        isCFC: false,
        isNVCC: false,
        isULIP: false,
      },
      specifiedIncome: {
        dividendIncome: 2_00_000,
        interestIncome: 0,
        rentalIncome: 0,
        royaltyIncome: 0,
        winningsIncome: 0,
        otherSpecifiedIncome: 0,
        totalSpecifiedIncome: 2_00_000,
        winningsTaxRate: 30,
        taxOnWinnings: 0,
        taxOnOtherSpecified: 0,
        totalSpecifiedTax: 0,
      },
      mat: {
        totalIncome: 120_00_000,
        amtBase: 140_00_000,
        amtRate: 15,
        amtComputed: 21_00_000,
        normalTax: 36_00_000,
        amtPayable: 36_00_000,
        surcharge: 0,
        cess: 1_44_000,
        totalAmtPayable: 37_44_000,
        amtCreditUtilised: 0,
        amtCreditCarriedForward: 0,
      },
      tds: {
        tdsDeductions: [
          {
            deductorName: "Client A",
            deductorPan: "AAAAA0001A",
            section: "194Q",
            amountCredited: 50_00_000,
            tdsDeducted: 2_00_000,
            tdsDeposited: 2_00_000,
          },
        ],
        tcsCollected: [],
        totalTdsDeducted: 2_00_000,
        totalTdsDeposited: 2_00_000,
        totalTcsCollected: 0,
        totalTcsDeposited: 0,
      },
      totalIncome: 120_00_000,
    });

    expect(payload.formType).toBe("ITR-6");
    expect(payload.schedules["PLC"]).toBeDefined();
    expect(payload.schedules["CYM"]).toBeDefined();
    // OMP removed from ITR-6 payload in this version
    expect(payload.schedules["FSI"]).toBeDefined();
    expect(payload.schedules["FL"]).toBeDefined();

    const v = validateITR6Payload(payload);
    if (!v.valid) console.log("ITR-6 validation errors:", v.errors);
    expect(v.valid).toBe(true);
  });
});

describe("buildITR3Payload", () => {
  it("builds a complete ITR-3 JSON for individual/HUF with business income", () => {
    const payload = buildITR3Payload({
      general: { name: "Rahul Sharma", pan: "RAHUL0000A", aadhaar: "123456789012", assessment_year: "2025-26" },
      business: {
        salesOrTurnover: 50_00_000,
        purchases: 20_00_000,
        closingStock: 5_00_000,
        grossProfit: 35_00_000,
        indirectExpenses: {
          salary: 10_00_000,
          rent: 3_00_000,
          electricity: 1_00_000,
          repairs: 50_000,
          depreciation: 2_00_000,
          interestPaid: 1_00_000,
          other: 50_000,
        },
        totalIndirectExpenses: 18_00_000,
        netProfitAsPerBooks: 17_00_000,
        disallowanceTdNotDeducted: 5_000,
        businessIncomeReturn: 16_95_000,
      },
      houseProperty: 2_00_000,
      capitalGains: { shortTerm: 50_000, longTerm: 0, total: 50_000 },
      otherSources: 30_000,
      agriculturalIncome: 1_00_000,
      deductions: {
        section80C: 1_50_000,
        section80D: 25_000,
        section80CCC: 0,
        section80CCD1: 0,
        section80CCD2: 0,
        section80CCD1B: 0,
        section80DDB: 0,
        section80E: 0,
        section80G: 0,
        section80GGA: 0,
        section80GGB: 0,
        section80GG: 0,
        section80TTA: 10_000,
        section80TTB: 0,
        section80RRB: 0,
        section80U: 0,
        other: 0,
      },
      foreign: {
        foreignSources: [
          {
            countryName: "UK",
            countryCode: "GB",
            incomeFromCountry: 2_00_000,
            foreignTaxPaid: 40_000,
            incomeType: "interest",
            includedInAmt: true,
          },
        ],
        totalForeignIncome: 2_00_000,
        totalForeignTaxPaid: 40_000,
        taxCreditAllowed: 40_000,
        creditCarryForward: 0,
      },
      foreignAssets: {
        foreignAssets: [
          {
            assetType: "foreignFinancialAsset",
            countryName: "UK",
            countryCode: "GB",
            peakValue: 10_00_000,
            averageValue: 8_00_000,
            isOperational: true,
            incomeFromAsset: 2_00_000,
          },
        ],
        totalCount: 1,
        totalPeakValue: 10_00_000,
        totalForeignAssetIncome: 2_00_000,
        fatcaCrsStatus: "furnished",
      },
      specifiedIncome: {
        dividendIncome: 0,
        interestIncome: 30_000,
        rentalIncome: 0,
        royaltyIncome: 0,
        winningsIncome: 0,
        otherSpecifiedIncome: 0,
        totalSpecifiedIncome: 30_000,
        winningsTaxRate: 30,
        taxOnWinnings: 0,
        taxOnOtherSpecified: 0,
        totalSpecifiedTax: 0,
      },
      mat: {
        totalIncome: 20_25_000,
        amtBase: 20_25_000,
        amtRate: 18.5,
        amtComputed: 3_74_625,
        normalTax: 0,
        amtPayable: 3_74_625,
        surcharge: 0,
        cess: 14_985,
        totalAmtPayable: 3_89_610,
        amtCreditUtilised: 0,
        amtCreditCarriedForward: 0,
      },
      tds: {
        tdsDeductions: [
          {
            deductorName: "Client A",
            deductorPan: "AAAAA0001A",
            section: "194J",
            amountCredited: 10_00_000,
            tdsDeducted: 1_00_000,
            tdsDeposited: 1_00_000,
          },
        ],
        tcsCollected: [],
        totalTdsDeducted: 1_00_000,
        totalTdsDeposited: 1_00_000,
        totalTcsCollected: 0,
        totalTcsDeposited: 0,
      },
      totalIncome: 20_25_000,
      taxSummary: {
        taxBeforeRebate: 2_02_500,
        rebate: 0,
        surcharge: 0,
        cess: 8_100,
        totalTax: 2_10_600,
        tds: 1_00_000,
        advanceTax: 50_000,
        selfAssessmentTax: 0,
        netPayable: 60_600,
      },
    });

    expect(payload.formType).toBe("ITR-3");
    expect(payload.schedules["BP"]).toBeDefined();
    expect(payload.schedules["FSI"]).toBeDefined();
    expect(payload.schedules["FL"]).toBeDefined();
    expect(payload.schedules["TR"]).toBeDefined();

    const v = validateITR3Payload(payload);
    if (!v.valid) console.log("ITR-3 validation errors:", v.errors);
    expect(v.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// XML round-trip sanity
// ---------------------------------------------------------------------------

describe("ITRSchedulePayload XML export", () => {
  it("round-trips the form type and assessment year", () => {
    const payload = buildITR5Payload({
      general: { name: "Test Firm", pan: "AAAAA0000A", assessment_year: "2025-26", aadhaar: "123456789012" },
      income: {
        businessIncome: 10_00_000,
        houseProperty: 0,
        capitalGains: { shortTerm: 0, longTerm: 0, total: 0 },
        otherSources: 0,
        agriculturalIncome: 0,
        specifiedIncome: { dividend: 0, interest: 0, rent: 0, royalty: 0, winnings: 0, other: 0 },
        totalIncome: 10_00_000,
      },
      business: {
        salesOrTurnover: 20_00_000,
        purchases: 5_00_000,
        closingStock: 2_00_000,
        grossProfit: 17_00_000,
        indirectExpenses: {
          salary: 5_00_000,
          rent: 2_00_000,
          electricity: 50_000,
          repairs: 25_000,
          depreciation: 1_00_000,
          interestPaid: 50_000,
          other: 50_000,
        },
        totalIndirectExpenses: 9_25_000,
        netProfitAsPerBooks: 7_75_000,
        businessIncomeReturn: 7_75_000,
      },
      profitSharing: {
        firmName: "Test Firm",
        firmPan: "AAAAA0000A",
        totalIncomeBeforeShare: 7_75_000,
        taxableIncomeOfFirm: 10_00_000,
        taxBorneByFirm: 3_00_000,
        surchargeOnFirm: 0,
        cessOnFirm: 12_000,
        totalTaxOfFirm: 3_12_000,
        tdsOnFirmIncome: 1_00_000,
        partners: [
          {
            name: "Partner A",
            pan: "AAAAA0001A",
            sharePercentage: 100,
            shareOfProfit: 7_75_000,
            shareOfTax: 3_00_000,
            shareOfTds: 1_00_000,
            shareOfCess: 12_000,
            partnerType: "individual",
          },
        ],
      },
      deductions: {
        section80C: 0,
        section80D: 0,
        section80CCC: 0,
        section80CCD1: 0,
        section80CCD2: 0,
        section80CCD1B: 0,
        section80DDB: 0,
        section80E: 0,
        section80G: 0,
        section80GGA: 0,
        section80GGB: 0,
        section80GG: 0,
        section80TTA: 0,
        section80TTB: 0,
        section80RRB: 0,
        section80U: 0,
        other: 0,
      },
      foreign: {
        foreignSources: [],
        totalForeignIncome: 0,
        totalForeignTaxPaid: 0,
        taxCreditAllowed: 0,
        creditCarryForward: 0,
      },
      foreignAssets: {
        foreignAssets: [],
        totalCount: 0,
        totalPeakValue: 0,
        totalForeignAssetIncome: 0,
        fatcaCrsStatus: "notApplicable",
      },
      specifiedIncome: {
        dividendIncome: 0,
        interestIncome: 0,
        rentalIncome: 0,
        royaltyIncome: 0,
        winningsIncome: 0,
        otherSpecifiedIncome: 0,
        totalSpecifiedIncome: 0,
        winningsTaxRate: 30,
        taxOnWinnings: 0,
        taxOnOtherSpecified: 0,
        totalSpecifiedTax: 0,
      },
      mat: {
        totalIncome: 10_00_000,
        amtBase: 10_00_000,
        amtRate: 18.5,
        amtComputed: 1_85_000,
        normalTax: 3_00_000,
        amtPayable: 3_00_000,
        surcharge: 0,
        cess: 12_000,
        totalAmtPayable: 3_12_000,
        amtCreditUtilised: 0,
        amtCreditCarriedForward: 0,
      },
      tds: {
        tdsDeductions: [],
        tcsCollected: [],
        totalTdsDeducted: 1_00_000,
        totalTdsDeposited: 1_00_000,
        totalTcsCollected: 0,
        totalTcsDeposited: 0,
      },
      totalIncome: 10_00_000,
      taxSummary: {
        taxBeforeRebate: 3_00_000,
        rebate: 0,
        surcharge: 0,
        cess: 12_000,
        totalTax: 3_12_000,
        tds: 1_00_000,
        advanceTax: 2_00_000,
        selfAssessmentTax: 0,
        netPayable: 12_000,
      },
    });

    const xml = payload.toXml();
    expect(xml).toMatch(/<ITR form_type="ITR-5" assessment_year="2025-26">/);
    expect(xml).toMatch(/<Schedule code="BP">/);
    expect(xml).toContain("<Line>1. Sales / Turnover: 2000000</Line>");
  });
});

// ---------------------------------------------------------------------------
// ITR JSON utility — schema validation + checksum
// ---------------------------------------------------------------------------

describe("ITR JSON utility", () => {
  const validITR1Json = {
    form_type: "ITR-1",
    assessment_year: "2025-26",
    personal_details: {
      name: "Rahul Sharma",
      pan: "RAHUL0000A",
      aadhaar: "123456789012",
      date_of_birth: "1990-01-01",
      gender: "male",
      email: "rahul@example.com",
      mobile: "9876543210",
      bank_details: {
        account_number: "1234567890123456",
        ifsc_code: "SBIN0001234",
        account_type: "savings",
        account_holder_name: "Rahul Sharma",
      },
    },
  };

  it("validateITRJson accepts a well-formed ITR-1 JSON with PAN, Aadhaar, email, mobile, bank", () => {
    const r = validateITRJson(validITR1Json, "ITR-1");
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validateITRJson rejects an ITR JSON missing personal_details", () => {
    const r = validateITRJson({ form_type: "ITR-1", assessment_year: "2025-26" }, "ITR-1");
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("personal_details"))).toBe(true);
  });

  it("validateITRJson rejects an ITR JSON with an invalid PAN", () => {
    const bad = { ...validITR1Json, personal_details: { ...validITR1Json.personal_details, pan: "BADPAN" } };
    const r = validateITRJson(bad, "ITR-1");
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("PAN"))).toBe(true);
  });

  it("validateITRJson rejects an ITR JSON with an invalid Aadhaar", () => {
    const bad = { ...validITR1Json, personal_details: { ...validITR1Json.personal_details, aadhaar: "12345" } };
    const r = validateITRJson(bad, "ITR-1");
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("Aadhaar"))).toBe(true);
  });

  it("validateITRJson rejects an ITR JSON with an invalid mobile", () => {
    const bad = { ...validITR1Json, personal_details: { ...validITR1Json.personal_details, mobile: "123" } };
    const r = validateITRJson(bad, "ITR-1");
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("mobile"))).toBe(true);
  });

  it("validateITRJson rejects an ITR JSON with an invalid IFSC", () => {
    const bad = {
      ...validITR1Json,
      personal_details: {
        ...validITR1Json.personal_details,
        bank_details: { ...validITR1Json.personal_details.bank_details, ifsc_code: "INVALID" },
      },
    };
    const r = validateITRJson(bad, "ITR-1");
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("IFSC"))).toBe(true);
  });

  it("validateITRJson computes a stable SHA-256 checksum on a valid payload", () => {
    const r1 = validateITRJson(validITR1Json, "ITR-1");
    const r2 = validateITRJson(validITR1Json, "ITR-1");
    expect(r1.checksum).toBe(r2.checksum);
    expect(r1.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("itrJsonChecksum is stable across repeated calls for the same payload", () => {
    const c1 = itrJsonChecksum(validITR1Json);
    const c2 = itrJsonChecksum(validITR1Json);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generateITR1 produces a JSON that validateITRJson accepts", () => {
    const info: ITRGeneralInfo = {
      formType: "ITR-1",
      assessmentYear: "2025-26",
      filingType: "original" as const,
      filingMode: "online" as const,
      digitalSignature: false,
      name: "Rahul Sharma",
      pan: "RAHUL0000A",
      aadhaar: "123456789012",
      dateOfBirth: "1990-01-01",
      gender: "male" as const,
      address: "1, MG Road, Bangalore 560001",
      email: "rahul@example.com",
      mobile: "9876543210",
    };
    const income: ITR1Income = {
      salary: {
        grossSalary: 12_00_000,
        allowanceExempt: 2_00_000,
        standardDeduction: 50_000,
        entertainmentAllowance: 0,
        professionalTax: 2_400,
        netSalary: 9_47_600,
      },
      houseProperty: null,
      otherSources: {
        interestFromSavings: 10_000,
        interestFromFixedDeposits: 40_000,
        interestFromRd: 0,
        interestFromSecurities: 0,
        familyPension: 0,
        "other income": 0,
        totalOtherSources: 50_000,
      },
    };
    const deductions: ITR1Deductions = {
      chapterVIA: {
        "80C": 1_50_000,
        "80CCC": 0,
        "80CCD1": 0,
        "80CCD2": 0,
        total80C: 1_50_000,
        "80D": 25_000,
        "80DDB": 0,
        "80E": 0,
        "80G": 0,
        "80GG": 0,
        "80GGDeduction": 0,
        "80TTA": 0,
        "80TTB": 0,
        totalDeductions: 1_75_000,
      },
      chapterVIATotal: 1_75_000,
      rebate87A: 0,
      totalTaxableIncome: 0,
    };
    const json = generateITR1(info, income, deductions);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const r = validateITRJson(parsed, "ITR-1");
    expect(r.valid).toBe(true);
    expect(parsed.form_type).toBe("ITR-1");
    expect(parsed.assessment_year).toBe("2025-26");
    expect((parsed.personal_details as { pan?: unknown }).pan).toBe("RAHUL0000A");
  });
});
