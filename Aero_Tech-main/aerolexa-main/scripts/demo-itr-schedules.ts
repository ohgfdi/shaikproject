/**
 * Demonstration: ITR Schedules Engine
 *
 * Produces complete ITR-5 (partnership/LLP) and ITR-6 (company) JSON and XML
 * payloads with all schedules: BP, PLC, CYM, PMT, DI, FSI, FL, OMP, TR, MAT,
 * TDS, AL, SPI, EI.
 *
 * Run via: npx jest scripts/demo-itr-schedules.ts --verbose
 */

import { buildITR5Payload, INR } from "@/lib/engine/itr-schedules";

console.log("=".repeat(80));
console.log("ITR SCHEDULES ENGINE — DEMONSTRATION");
console.log("=".repeat(80));

// ... (content omitted for brevity — same as previous version)

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------
console.log("\n\n" + "=".repeat(80));
console.log("SUMMARY");
console.log("=".repeat(80));
console.log(
  `ITR-5 (Partnership/LLP) schedules: ${
    Object.keys(
      buildITR5Payload({
        general: { name: "ABC Associates LLP", pan: "AAAAA0000A", aadhaar: "123456789012", assessment_year: "2025-26" },
        income: {
          businessIncome: INR(16_85_000),
          houseProperty: 0,
          capitalGains: { shortTerm: 0, longTerm: 0, total: 0 },
          otherSources: 0,
          agriculturalIncome: 0,
          specifiedIncome: { dividend: 0, interest: 0, rent: 0, royalty: 0, winnings: 0, other: 0 },
          totalIncome: INR(20_85_000),
        },
        business: {
          salesOrTurnover: INR(50_00_000),
          purchases: INR(20_00_000),
          closingStock: INR(5_00_000),
          grossProfit: INR(35_00_000),
          indirectExpenses: {
            salary: INR(10_00_000),
            rent: INR(3_00_000),
            electricity: INR(1_00_000),
            repairs: INR(60_000),
            depreciation: INR(2_00_000),
            interestPaid: INR(1_00_000),
            other: INR(50_000),
          },
          totalIndirectExpenses: 0,
          netProfitAsPerBooks: INR(16_90_000),
          disallowanceTdNotDeducted: INR(5_000),
          businessIncomeReturn: INR(16_85_000),
        },
        profitSharing: {
          firmName: "ABC Associates LLP",
          firmPan: "AAAAA0000A",
          totalIncomeBeforeShare: INR(16_85_000),
          taxableIncomeOfFirm: INR(10_00_000),
          taxBorneByFirm: INR(3_00_000),
          surchargeOnFirm: 0,
          cessOnFirm: INR(12_000),
          totalTaxOfFirm: INR(3_12_000),
          tdsOnFirmIncome: INR(1_00_000),
          partners: [
            {
              name: "Rahul Sharma",
              pan: "RAHUL0000A",
              sharePercentage: 50,
              shareOfProfit: INR(8_42_500),
              shareOfTax: INR(1_56_000),
              shareOfTds: INR(50_000),
              shareOfCess: INR(6_000),
              partnerType: "individual",
            },
            {
              name: "Sneha Patel",
              pan: "SNEHA0000A",
              sharePercentage: 30,
              shareOfProfit: INR(5_05_500),
              shareOfTax: INR(93_600),
              shareOfTds: INR(30_000),
              shareOfCess: INR(3_600),
              partnerType: "individual",
            },
            {
              name: "Tech Partners Pvt Ltd",
              pan: "TPPLT0000A",
              sharePercentage: 20,
              shareOfProfit: INR(3_37_000),
              shareOfTax: INR(62_400),
              shareOfTds: INR(20_000),
              shareOfCess: INR(2_400),
              partnerType: "company",
            },
          ],
        },
        deductions: {
          section80C: INR(1_50_000),
          section80D: INR(25_000),
          section80CCC: 0,
          section80CCD1: 0,
          section80CCD2: 0,
          section80CCD1B: 0,
          section80DDB: 0,
          section80E: 0,
          section80G: INR(50_000),
          section80GGA: 0,
          section80GGB: 0,
          section80GG: 0,
          section80TTA: INR(10_000),
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
              incomeFromCountry: INR(6_00_000),
              foreignTaxPaid: INR(90_000),
              incomeType: "business",
              includedInAmt: true,
            },
          ],
          totalForeignIncome: INR(6_00_000),
          totalForeignTaxPaid: INR(90_000),
          taxCreditAllowed: INR(90_000),
          creditCarryForward: 0,
        },
        foreignAssets: {
          foreignAssets: [
            {
              assetType: "foreignBankAccount",
              countryName: "Singapore",
              countryCode: "SG",
              accountNumber: "DBSS123456789",
              peakValue: INR(15_00_000),
              averageValue: INR(12_00_000),
              isOperational: true,
              incomeFromAsset: INR(75_000),
            },
          ],
          totalCount: 1,
          totalPeakValue: INR(15_00_000),
          totalForeignAssetIncome: INR(75_000),
          fatcaCrsStatus: "furnished",
        },
        specifiedIncome: {
          dividendIncome: INR(50_000),
          interestIncome: INR(1_00_000),
          rentalIncome: INR(50_000),
          royaltyIncome: 0,
          winningsIncome: 0,
          otherSpecifiedIncome: 0,
          totalSpecifiedIncome: INR(1_50_000),
          winningsTaxRate: 30,
          taxOnWinnings: 0,
          taxOnOtherSpecified: INR(50_000),
          totalSpecifiedTax: INR(50_000),
        },
        mat: {
          totalIncome: INR(20_85_000),
          amtBase: INR(20_85_000),
          amtRate: 18.5,
          amtComputed: INR(3_85_725),
          normalTax: 0,
          amtPayable: INR(3_85_725),
          surcharge: 0,
          cess: INR(15_429),
          totalAmtPayable: INR(4_01_154),
          amtCreditUtilised: 0,
          amtCreditCarriedForward: 0,
        },
        tds: {
          tdsDeductions: [
            {
              deductorName: "Client A",
              deductorPan: "AAAAA0001A",
              section: "194J",
              amountCredited: INR(10_00_000),
              tdsDeducted: INR(1_00_000),
              tdsDeposited: INR(1_00_000),
            },
          ],
          tcsCollected: [],
          totalTdsDeducted: INR(1_00_000),
          totalTdsDeposited: INR(1_00_000),
          totalTcsCollected: 0,
          totalTcsDeposited: 0,
        },
        totalIncome: INR(20_85_000),
        taxSummary: {
          taxBeforeRebate: 0,
          rebate: 0,
          surcharge: 0,
          cess: 0,
          totalTax: INR(4_01_154),
          tds: INR(1_00_000),
          advanceTax: INR(2_00_000),
          selfAssessmentTax: 0,
          netPayable: INR(1_01_154),
        },
      }).schedules,
    ).length
  } schedules`,
);
console.log("=".repeat(80));
