import { z } from "zod";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { advanceTaxAdvice } from "@/lib/engine/advance-tax";
import { ageInvoices, msme43bh, type OpenInvoice } from "@/lib/engine/ageing";
import { reconcileBank, type BankStatementRow, type CashBookRow } from "@/lib/engine/bank-recon";
import { computeAdvanceTax } from "@/lib/engine/ca-advance-tax";
import { auditAssuranceInput, computeAuditAssurance } from "@/lib/engine/ca-audit-assurance-api";
import { computeMateriality, formOpinion, workingPaperIndex } from "@/lib/engine/ca-audit-opinion";
import {
  complianceStatus,
  auditRequired44AB,
  auditRequired44ADA,
  type AuditDetermination,
} from "@/lib/engine/ca-compliance";
import {
  DOCUMENT_CATEGORIES,
  buildClientPortalView,
  buildDocumentRegister,
  type DocumentCategory,
  type DocumentRecord,
} from "@/lib/engine/ca-documents";
import { entityComplianceInput, computeEntityCompliance } from "@/lib/engine/ca-entity-compliance-api";
import { ecbRate, fcgpr, fctrs, lrsTcs, odiLimit } from "@/lib/engine/ca-fema-crossborder";
import { analyzeStatements, type StatementPair } from "@/lib/engine/ca-financial-analysis";
import {
  computeConcurrentAudit,
  computeInternalAudit,
  computeStockAudit,
  concurrentAuditInput,
  internalAuditInput,
  stockAuditInput,
} from "@/lib/engine/ca-internal-audit-api";
import { computeItr } from "@/lib/engine/ca-itr-computation";
import { litigationPortfolio, planAppeal } from "@/lib/engine/ca-litigation";
import { payrollOperationsInput, computePayrollOperations } from "@/lib/engine/ca-payroll-operations-api";
import { practiceManOperations, computePracticeManagement } from "@/lib/engine/ca-practice-management-api";
import { getRateTable, slabRateFor } from "@/lib/engine/ca-rate-registry";
import { analyzeRatios } from "@/lib/engine/ca-ratios";
import { determineTaxAudit } from "@/lib/engine/ca-tax-audit";
import { computeTds } from "@/lib/engine/ca-tds-computation";
import {
  applyArmLengthTest,
  form3cebSummary,
  methodTnmm,
  multipleYearWeightedMean,
  thinCapitalisation94B,
  tolerancePctFor,
} from "@/lib/engine/ca-transfer-pricing";
import { buildAssetRegister } from "@/lib/engine/fixed-assets";
import { buildGstr9 } from "@/lib/engine/gstr-9";
import { computeCapitalGainHead, type AssetTransactionWithOverride } from "@/lib/engine/income-head-capital-gains";
import { computeHousePropertyAggregate, type HousePropertyInput } from "@/lib/engine/income-head-house-property";
import { computeSalaryHead } from "@/lib/engine/income-head-salary";
import { INDIVIDUAL_REGIMES, NEW_REGIME_2025_26, OLD_REGIME_2025_26 } from "@/lib/engine/india-tax";
import {
  buildITRSchedulePayload,
  validateITR3Payload,
  validateITR5Payload,
  validateITR6Payload,
  type ScheduleBlock,
} from "@/lib/engine/itr-schedules";
import { buildUpdatedReturn, validateItrUPayload } from "@/lib/engine/itr-u";
import { payrollRegister } from "@/lib/engine/payroll";
import { buildTaxInvoice, buildTimesheetSummary, type TimesheetEntry } from "@/lib/engine/practice-timesheets";
import { computeProfessionalTax } from "@/lib/engine/professional-tax";
import { reconcileChallans, type TdsChallanReceipt } from "@/lib/engine/tds-challan-engine";
import {
  createForm16ACertificate,
  createForm16Certificate,
  generateForm16A,
  generateForm16PartA,
  generateForm16PartB,
  validateForm16Certificate,
  type Form16OtherIncome,
} from "@/lib/engine/tds-form16-generator";
import {
  getTdsExemptionCover,
  validateForm15Declaration,
  type Form15Declaration,
  type LdcCertificate,
} from "@/lib/engine/tds-ldc-form15g";
import { computeTdsExposure, type TdsExposureEvent, type TdsExposureParams } from "@/lib/engine/tds-penalty-exposure";
import { prepareTdsReturn } from "@/lib/engine/tds-returns";
import { TDS_SECTIONS, lookupSection, sectionsForForm, type TdsSectionDefinition } from "@/lib/engine/tds-sections";
import {
  lookupTimeOfDeductionRule,
  processTdsPayments,
  thresholdCrossingSummary,
  type TdsPaymentEvent,
} from "@/lib/engine/tds-threshold-engine";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/ca/compute — the pure CA engines behind one endpoint.
 *
 * The books-backed surfaces (statements, day book, ITC) have their own routes
 * under /api/books; these engines take row data and compute — no persistence,
 * no book ownership to check — so they share one validated compute endpoint
 * keyed by `kind`. Amounts are RUPEES as decimals in the API and converted to
 * integer paise here, matching every engine's contract.
 *
 * Kinds:
 *   bank-recon    cash book vs bank statement → BRS
 *   ageing        open invoices → AR/AP ageing (+ optional MSME 43B(h))
 *   payroll       monthly payslips → EPF/ESI/PT/TDS register
 *   fixed-assets  asset register → book (Schedule II) + tax block roll-forward
 *   tds-return    deductions + challans → Form 24Q/26Q/27Q preparation
 *   gstr9         annual aggregates → GSTR-9 summary + Table 8 reconciliation
 *   audit-assurance  the SA audit workflow (engagement → risk → sampling →
 *                    workpapers → evidence → reporting), dispatched on `op`.
 *                    Run it through here rather than a bespoke route so it
 *                    shares the same auth + rupee→paise contract.
 *   entity-compliance  the corporate-compliance operating workflow (entity
 *                    master/registers → ROC form calendar → meetings →
 *                    state/FEMA obligations → documents → carry-forward),
 *                    also dispatched on `op`.
 *   payroll-operations  the payroll practice system (employee master → monthly
 *                    run → PF/ESI/PT + labour registers → reconciliations),
 *                    also dispatched on `op`.
 */

const rupees = z.number().finite().safe();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd");
const paise = (n: number) => Math.round(n * 100);
/** Rupee→paise for every numeric field of a money-shaped record (salary annexure, schedule totals). */
const paiseRecord = <T extends Record<string, number>>(r: T): T =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, paise(v)])) as T;
const toPaiseOrNull = (n: number | null | undefined) => (n === null || n === undefined ? null : paise(n));

const taxAmounts = z.object({
  taxableValue: rupees,
  igst: rupees,
  cgst: rupees,
  sgst: rupees,
  cess: rupees,
});

const bankRecon = z.object({
  kind: z.literal("bank-recon"),
  asOfDate: date,
  tolerance: rupees.optional(),
  cashBook: z
    .array(
      z.object({ id: z.string().min(1), date, narration: z.string(), amount: rupees, reference: z.string().nullish() }),
    )
    .max(20_000),
  statement: z
    .array(
      z.object({ id: z.string().min(1), date, narration: z.string(), amount: rupees, reference: z.string().nullish() }),
    )
    .max(20_000),
});

const ageing = z.object({
  kind: z.literal("ageing"),
  asOfDate: date,
  invoices: z
    .array(
      z.object({
        number: z.string().min(1),
        counterparty: z.string().min(1),
        date,
        outstanding: rupees,
        msmeRegistration: z.boolean().optional(),
      }),
    )
    .max(50_000),
  /** Supply suppliers to also compute the MSME 43B(h) exposure. */
  msmeSuppliers: z
    .array(z.object({ name: z.string().min(1), isMsme: z.boolean(), msmeInterestRatePct: rupees }))
    .max(20_000)
    .optional(),
});

const payroll = z.object({
  kind: z.literal("payroll"),
  month: z.string().regex(/^\d{4}-\d{2}$/, "must be yyyy-mm"),
  regimeId: z.enum(["new", "old"]).default("new"),
  monthsRemaining: z.number().int().min(1).max(12).optional(),
  annualSalaries: z.record(z.string(), rupees).optional(),
  config: z
    .object({
      epfWageCeiling: rupees.optional(),
      epfRatePct: rupees.optional(),
      epsRatePct: rupees.optional(),
      edliRatePct: rupees.optional(),
      epfAdminRatePct: rupees.optional(),
      epfOnActualWages: z.boolean().optional(),
      esiWageCeiling: rupees.optional(),
      esiEmployeeRatePct: rupees.optional(),
      esiEmployerRatePct: rupees.optional(),
      professionalTaxSlabs: z.array(z.object({ upTo: rupees.nullable(), amount: rupees })).optional(),
    })
    .optional(),
  employees: z
    .array(
      z.object({
        employeeId: z.string().min(1),
        name: z.string().min(1),
        basic: rupees,
        dearnessAllowance: rupees.optional(),
        hra: rupees.optional(),
        otherAllowances: rupees.optional(),
      }),
    )
    .max(5_000),
});

const fixedAssets = z.object({
  kind: z.literal("fixed-assets"),
  fy: z.string().regex(/^\d{4}-\d{2}$/, 'must be "2025-26"'),
  method: z.enum(["slm", "wdv"]).optional(),
  residualPct: rupees.optional(),
  additionalDepreciationPct: rupees.optional(),
  taxOpeningWdv: z.record(z.string(), rupees).optional(),
  assets: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        cost: rupees,
        acquisitionDate: date,
        putToUseDate: date,
        bookClass: z.string().min(1),
        taxBlock: z.string().min(1),
        openingBookDepreciation: rupees,
        disposal: z.object({ date, saleProceeds: rupees }).nullish(),
      }),
    )
    .max(10_000),
});

const tdsReturn = z.object({
  kind: z.literal("tds-return"),
  form: z.enum(["24Q", "26Q", "27Q"]),
  tan: z.string().trim().min(10).max(10),
  quarter: z.object({ from: date, to: date }),
  filingDueDate: date,
  filingDate: date.optional(),
  lateDeductionRatePctPerMonth: rupees.optional(),
  lateDepositRatePctPerMonth: rupees.optional(),
  feePerDay: rupees.optional(),
  deductions: z
    .array(
      z.object({
        payeeName: z.string().min(1),
        pan: z.string().nullish(),
        section: z.string().min(1),
        baseAmount: rupees,
        ratePct: rupees,
        deducted: rupees,
        deductibleDate: date,
        deductedDate: date,
        depositedDate: date.nullish(),
      }),
    )
    .max(20_000),
  challans: z
    .array(
      z.object({
        bsrCode: z.string().min(1),
        challanSerial: z.string().min(1),
        dateOfDeposit: date,
        amount: rupees,
        section: z.string().nullish(),
      }),
    )
    .max(5_000),
});

const gstr9 = z.object({
  kind: z.literal("gstr9"),
  fy: z.string().regex(/^\d{4}-\d{2}$/, 'must be "2025-26"'),
  tolerance: rupees.optional(),
  outward: z.array(taxAmounts).max(12),
  itcAvailed: z.array(taxAmounts).max(12),
  itcReversed: z.array(taxAmounts).max(12).optional(),
  importsItc: taxAmounts.optional(),
  rcm: z.array(taxAmounts).max(12).optional(),
  twoBAvailable: taxAmounts.optional(),
  previousYearClaims: taxAmounts.optional(),
});

const statementLine = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  amount: rupees,
});

const ratioAnalysis = z.object({
  kind: z.literal("ratio-analysis"),
  label: z.string().min(1),
  revenue: rupees,
  costOfGoodsSold: rupees,
  grossProfit: rupees,
  operatingExpenses: rupees,
  operatingProfit: rupees,
  otherIncome: rupees,
  financeCosts: rupees,
  profitBeforeTax: rupees,
  taxExpense: rupees,
  netProfit: rupees,
  earningsPerShare: rupees.nullish(),
  dividendsPerShare: rupees.nullish(),
  currentAssets: rupees,
  currentLiabilities: rupees,
  inventory: rupees,
  tradeReceivables: rupees,
  cashAndBank: rupees,
  totalAssets: rupees,
  totalLiabilities: rupees,
  equity: rupees,
  longTermDebt: rupees,
  fixedAssets: rupees,
  intangibleAssets: rupees,
  openingEquity: rupees.nullish(),
  openingLongTermDebt: rupees.nullish(),
  openingTotalAssets: rupees.nullish(),
  openingInventory: rupees.nullish(),
  openingTradeReceivables: rupees.nullish(),
  openingCurrentAssets: rupees.nullish(),
  openingCurrentLiabilities: rupees.nullish(),
  purchases: rupees.nullish(),
  creditSales: rupees.nullish(),
  sharePrice: rupees.nullish(),
  sharesOutstanding: z.number().finite().nullish(),
});

const financialAnalysis = z.object({
  kind: z.literal("financial-analysis"),
  currentLabel: z.string().min(1),
  priorLabel: z.string().min(1),
  currentIs: z.array(statementLine).min(1),
  priorIs: z.array(statementLine).nullable(),
  currentBs: z.array(statementLine).min(1),
  priorBs: z.array(statementLine).nullable(),
  currentCf: z.array(statementLine).nullable(),
  priorCf: z.array(statementLine).nullable(),
  revenueBase: rupees.nullish(),
  totalAssetsBase: rupees.nullish(),
  cashFlowBase: rupees.nullish(),
});

const auditDeterminationInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("44AB"),
    ay: z.string(),
    turnoverMinor: rupees,
    cashReceiptsMinor: rupees,
  }),
  z.object({
    kind: z.literal("44ADA"),
    ay: z.string(),
    receiptsMinor: rupees,
    bankingChannelPct: z.number().min(0).max(100),
  }),
]);

const complianceCheck = z.object({
  kind: z.literal("compliance-check"),
  clientName: z.string().min(1),
  fy: z.string().regex(/^\d{4}-\d{2}$/, 'must be "2025-26"'),
  entityType: z.string().min(1),
  referenceDate: date,
  calendar: z
    .array(
      z.object({
        description: z.string(),
        appliesTo: z.string(),
        dueDate: date,
        lateFeeApplicable: z.boolean(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  auditDetermination: auditDeterminationInput.nullish(),
});

const tpTransaction = z.object({
  description: z.string().min(1),
  type: z.enum(["international", "sdt"]),
  method: z.enum(["CUP", "RPM", "CPLM", "TNMM", "PSM"]),
  valueMinor: rupees,
  adjustmentMinor: rupees,
});

const transferPricing = z.object({
  kind: z.literal("transfer-pricing"),
  /** Arm's length test: actual price vs comparables at the class tolerance. */
  armLength: z
    .object({
      actualMinor: rupees,
      comparablesMinor: z.array(rupees).min(1),
      toleranceClass: z.enum(["wholesale-trading", "retail-trading", "other"]),
      tolerancePct: z.number().min(0).max(20).optional(),
    })
    .optional(),
  tnmm: z
    .object({
      testedOmPct: z.number().finite(),
      comparableOmPcts: z.array(z.number().finite()).min(1),
      toleranceClass: z.enum(["wholesale-trading", "retail-trading", "other"]),
      tolerancePct: z.number().min(0).max(20).optional(),
    })
    .optional(),
  thinCap94b: z
    .object({
      interestExpenseMinor: rupees,
      ebitdaMinor: rupees,
      deMinimisMinor: rupees.optional(),
    })
    .optional(),
  form3ceb: z.array(tpTransaction).min(1).optional(),
  multipleYear: z.object({ yearlyValues: z.array(rupees).min(1), weights: z.array(rupees).optional() }).optional(),
});

const fema = z.object({
  kind: z.literal("fema"),
  fcgpr: z
    .object({
      allotmentDate: date,
      filedOn: date.nullish(),
      issuePriceMinor: rupees,
      fairValueMinor: rupees,
    })
    .optional(),
  fctrs: z
    .object({
      direction: z.enum(["resident-to-non-resident", "non-resident-to-resident"]),
      transferPriceMinor: rupees,
      fairValueMinor: rupees,
    })
    .optional(),
  odi: z
    .object({ netWorthMinor: rupees, approvedByRbiMinor: rupees.optional(), totalFinancialCommitmentMinor: rupees })
    .optional(),
  ecb: z
    .object({
      benchmarkPct: z.number().min(0),
      spreadPct: z.number().min(0),
      spreadCapPct: z.number().min(0).optional(),
    })
    .optional(),
  lrs: z
    .object({
      amountUsdMinor: rupees,
      priorYearRemittancesUsdMinor: rupees.optional(),
      tcsRatePct: z.number().min(0).max(100).optional(),
    })
    .optional(),
});

const auditOpinion = z.object({
  kind: z.literal("audit-opinion"),
  materiality: z.object({
    profitBeforeTaxMinor: rupees,
    overallPct: z.number().min(0).max(100).optional(),
    performancePct: z.number().min(0).max(100).optional(),
    clearlyTrivialPct: z.number().min(0).max(100).optional(),
    benchmarkName: z.string().min(1).optional(),
    benchmarkAmountMinor: rupees.optional(),
  }),
  opinion: z.object({
    uncorrectedMisstatementsMinor: rupees,
    evidenceSufficient: z.boolean(),
    cause: z.enum(["misstatement", "scope-limitation", "none"]),
    pervasiveness: z.enum(["not-pervasive", "pervasive"]),
  }),
  signedOffRefs: z.array(z.string().min(1)).optional(),
});

const rateRegistry = z.object({
  kind: z.literal("rate-registry"),
  ay: z.string().regex(/^\d{4}-\d{2}$/, 'must be "2025-26"'),
  kinds: z
    .array(
      z.enum([
        "individual-slab-old",
        "individual-slab-new",
        "corporate-rate",
        "surcharge",
        "cess",
        "tds-section",
        "gst-rate",
        "custom",
      ]),
    )
    .min(1),
  /** Income to resolve a slab rate against (in the table's unit). */
  incomeForSlab: z.number().finite().optional(),
});

// ---------------------------------------------------------------------------
// Direct tax: the income-head engines, the ITR computation and advance tax.
//
// Money units differ per engine, so each kind keeps its engine's own contract
// explicit rather than guessing:
//   income-head-salary / house-property / capital-gains → INTEGER PAISE
//   ca-itr-computation / ca-advance-tax                 → WHOLE RUPEES
//   advance-tax (advisory)                              → INTEGER PAISE
// Every kind below takes RUPEES at the API boundary and converts here — the
// same discipline the gst-filing bridge added after shipping a 100× bug.
// ---------------------------------------------------------------------------

const ayLabel = z.string().regex(/^\d{4}-\d{2}$/, 'must be "2025-26"');

const salaryComponentInput = z.object({
  label: z.string().min(1),
  amount: rupees,
  countsForSalary: z.boolean(),
  notes: z.string().optional(),
});

const salaryHeadInput = z.object({
  kind: z.literal("income-head-salary"),
  ay: ayLabel,
  regimeId: z.enum(["new", "old"]).default("new"),
  components: z.array(salaryComponentInput).min(1).max(500),
  perquisites: z
    .object({
      taxableValue: rupees.default(0),
      items: z
        .array(z.object({ description: z.string().min(1), value: rupees, notes: z.string().optional() }))
        .max(500)
        .optional(),
    })
    .default({}),
  allowances: z
    .object({
      hraExempt: rupees.default(0),
      exemptAllowances10_14: rupees.default(0),
      otherExempt: rupees.default(0),
      professionalTax: rupees.default(0),
    })
    .default({}),
  relief: z
    .object({
      arrearsReceived: rupees,
      taxIncludingArrears: rupees,
      taxExcludingArrears: rupees,
      taxOnArrearsInPastYear: rupees,
    })
    .nullish(),
  pension: z
    .object({
      uncommutedPension: rupees,
      commutedPension: rupees,
      oneThirdCommuted: z.boolean(),
      yearsOfService: z.number().int().min(0).optional(),
      retirementDate: date.optional(),
    })
    .nullish(),
  gratuity: z
    .object({
      received: rupees,
      basicAndDa: rupees,
      yearsOfService: z.number().int().min(0),
      coveredUnderAct: z.boolean(),
    })
    .nullish(),
  leave: z
    .object({
      receivedAtRetirement: rupees,
      averageSalary10Months: rupees,
      leaveEntitlementDays: z.number().int().min(0),
      leaveTakenDays: z.number().int().min(0),
    })
    .nullish(),
  compareRegimes: z.boolean().default(false),
});

const housePropertyRow = z.object({
  id: z.string().min(1),
  status: z.enum(["let-out", "self-occupied", "deemed-let-out", "part-self-occupied-part-let-out"]),
  municipalValue: rupees.default(0),
  fairRent: rupees.optional(),
  standardRent: rupees.optional(),
  rentReceived: rupees.default(0),
  unrealizedRealized: rupees.optional(),
  municipalTaxPaid: rupees.default(0),
  interestOnHousingLoan: rupees.default(0),
  preConstructionInterest: rupees.optional(),
  tdsDeductedByLender: rupees.optional(),
  actualExpenses: rupees.optional(),
  notes: z.string().optional(),
});

const housePropertyHead = z.object({
  kind: z.literal("house-property"),
  ay: ayLabel,
  regimeLabel: z.string().min(1).default("individual"),
  properties: z.array(housePropertyRow).min(1).max(1_000),
  electOneSelfOccupiedAsNil: z.boolean().optional(),
  priorYearLossBroughtForward: rupees.default(0),
  priorYearLossAlreadySetOffInPriorYears: rupees.optional(),
});

const specialRateSpec = z.object({
  section: z.string().min(1),
  ratePct: z.number().finite(),
  exemption: rupees.optional(),
  note: z.string().optional(),
});

const cgHolding = z.object({
  acquisitionDate: date,
  transferDate: date,
  daysHeld: z.number().int().min(0),
  longTerm: z.boolean(),
});

const cgTransaction = z.object({
  id: z.string().min(1),
  assetClass: z.enum([
    "listed-equity-shares",
    "equity-oriented-mutual-fund",
    "listed-debt-securities",
    "unlisted-shares",
    "immovable-property",
    "movable-property",
    "gold-bonds",
    "other",
  ]),
  acquisitionDate: date,
  transferDate: date,
  saleProceeds: rupees,
  costOfAcquisition: rupees,
  costOfImprovement: rupees.optional(),
  expenditureOnTransfer: rupees.optional(),
  holding: cgHolding,
  indexedCostClaimed: z.boolean().optional(),
  indexedCostOfAcquisition: rupees.optional(),
  indexedCostOfImprovement: rupees.optional(),
  grandfatheringBasis: z.string().optional(),
  sttPaid: z.boolean().optional(),
  foreignAsset: z.boolean().optional(),
  foreignCountry: z.string().optional(),
  notes: z.string().optional(),
  specialRateOverride: specialRateSpec.nullish(),
});

const capitalGainsHead = z.object({
  kind: z.literal("capital-gains"),
  ay: ayLabel,
  regimeLabel: z.string().min(1).default("individual"),
  transactions: z.array(cgTransaction).min(1).max(10_000),
  lossBroughtForward: z.object({ shortTerm: rupees.default(0), longTerm: rupees.default(0) }).default({}),
  foreignAssetReporting: z.boolean().default(false),
});

/** The six income heads, mirrored for both the ITR and the advance-tax engines. */
const incomeHeadsSchema = z
  .object({
    salary: rupees.default(0),
    houseProperty: rupees.default(0),
    businessProfession: rupees.default(0),
    capitalGains: rupees.default(0),
    otherSources: rupees.default(0),
    agricultural: rupees.default(0),
  })
  .default({});

const itrDeductions = z
  .object({
    section80C: rupees.default(0),
    section80D: rupees.default(0),
    section80E: rupees.default(0),
    section80G: rupees.default(0),
    section80GG: rupees.default(0),
    section80TTA: rupees.default(0),
    section80TTB: rupees.default(0),
    nopNorm: rupees.default(0),
    otherDeductions: rupees.default(0),
  })
  .default({});

const lossSetOffSchema = z
  .object({
    bhplBroughtFwd: rupees.default(0),
    bhplSetOff: rupees.default(0),
    cglBroughtFwd: rupees.default(0),
    cglSetOff: rupees.default(0),
  })
  .default({});

const itrInput = z.object({
  kind: z.literal("itr"),
  fy: ayLabel,
  assesseeType: z.enum(["individual", "huf", "company", "firm", "llp", "aop", "boi", "trust"]).default("individual"),
  residentialStatus: z.enum(["resident", "non-resident", "not ordinarily resident"]).default("resident"),
  incomeHeads: incomeHeadsSchema,
  deductions: itrDeductions,
  hra: z
    .object({
      received: rupees.default(0),
      paidRent: rupees.default(0),
      city: z.boolean().default(false),
      metro: z.boolean().default(false),
      actualRent: rupees.default(0),
    })
    .default({}),
  losses: lossSetOffSchema,
  scheduleAi: z.object({ interestPaid: rupees.default(0), interestReceived: rupees.default(0) }).default({}),
  prepaidTax: z
    .object({
      tds: rupees.default(0),
      tcs: rupees.default(0),
      advanceTax: rupees.default(0),
      selfAssessment: rupees.default(0),
      demands: rupees.default(0),
    })
    .default({}),
  formType: z.enum(["ITR-1", "ITR-2", "ITR-3", "ITR-4", "ITR-5", "ITR-6", "ITR-7"]).default("ITR-1"),
  surcharges: z.object({ hvilag: z.boolean().default(false), healthcare: z.boolean().default(false) }).default({}),
});

const advanceTaxDeductions = z
  .object({
    section80C: rupees.default(0),
    section80CCC: rupees.default(0),
    section80CCD1: rupees.default(0),
    section80CCD2: rupees.default(0),
    section80D: rupees.default(0),
    section80E: rupees.default(0),
    section80G: rupees.default(0),
    section80GG: rupees.default(0),
    section80TTA: rupees.default(0),
    section80TTB: rupees.default(0),
    otherDeductions: rupees.default(0),
  })
  .default({});

const advanceTaxInput = z.object({
  kind: z.literal("advance-tax"),
  fy: ayLabel,
  assesseeType: z.enum(["individual", "huf", "company", "firm", "llp", "aop", "boi", "trust"]).default("individual"),
  residentialStatus: z.enum(["resident", "non-resident", "not-ordinarily-resident"]).default("resident"),
  regime: z.enum(["old", "new"]).default("new"),
  estimatedTotalIncome: rupees.optional(),
  grossTotalIncome: rupees.optional(),
  incomeHeads: incomeHeadsSchema,
  deductions: advanceTaxDeductions,
  hra: z.object({ received: rupees, paidRent: rupees, city: z.boolean(), basicSalary: rupees }).nullish(),
  losses: lossSetOffSchema,
  method: z.enum(["slab-snapshot", "yearly-projection"]).default("slab-snapshot"),
  incomeByInstalment: z.array(z.object({ dueDate: date, incomeUpToDate: rupees })).optional(),
  prepaidTax: z
    .object({ advanceTaxPaid: rupees.default(0), tds: rupees.default(0), tcs: rupees.default(0) })
    .default({}),
  delayedFilingDays: z.number().int().min(0).default(0),
  liabilityExceedsThreshold: z.boolean().default(true),
  computeRegimeComparison: z.boolean().default(true),
});

const advanceTaxAdvisory = z.object({
  kind: z.literal("advance-tax-advisory"),
  clientName: z.string().min(1).default("Client"),
  fy: ayLabel,
  regimeId: z.enum(["new", "old"]).default("new"),
  totalTax: rupees,
  advanceTaxPaid: rupees.default(0),
  referenceDate: date,
  filingDueDate: date.optional(),
  selfAssessmentTax: rupees.optional(),
});

// ---------------------------------------------------------------------------
// TDS suite: the section matrix, aggregate-threshold tracking, challan
// reconciliation and penalty exposure. Every engine here is in integer paise;
// the API takes rupees and converts. The section matrix is reference data, so it
// takes no money at all.
// ---------------------------------------------------------------------------

const tdsSection = z.object({
  kind: z.literal("tds-section"),
  /** Look up one section by code (e.g. "194C"). */
  section: z.string().min(1).optional(),
  /** Or list every section that travels in one return form. */
  form: z.enum(["24Q", "26Q", "27Q", "NIL"]).optional(),
});

const tdsChallanReceipt = z.object({
  bsrCode: z.string().min(1),
  challanSerial: z.string().min(1),
  dateOfDeposit: date,
  amount: rupees,
  section: z.string().nullish(),
  deducteePan: z.string().nullish(),
  challanType: z.string().nullish(),
  remarks: z.string().nullish(),
  verified: z.boolean().default(false),
  bankRef: z.string().nullish(),
});

const tdsChallanRecon = z.object({
  kind: z.literal("tds-challan-recon"),
  challans: z.array(tdsChallanReceipt).min(1).max(20_000),
  bankStatement: z
    .array(z.object({ date, description: z.string().default(""), amount: rupees, ref: z.string().default("") }))
    .max(20_000)
    .default([]),
});

const tdsExposureEvent = z.object({
  id: z.string().min(1),
  section: z.string().min(1),
  payeeName: z.string().default(""),
  payeePan: z.string().nullish(),
  baseAmount: rupees,
  ratePct: z.number().finite().default(0),
  taxShouldBe: rupees,
  taxActual: rupees,
  deductibleDate: date,
  deductedDate: date.nullish(),
  depositedDate: date.nullish(),
  returnFiled: z.boolean().default(false),
  returnFiledDate: date.nullish(),
  natureOfPayment: z.string().nullish(),
  isTcs: z.boolean().default(false),
});

const tdsExposureParams = z.object({
  tan: z.string().min(1),
  assessmentYear: z.string().default("2026-27"),
  financialYear: z.string().default("2025-26"),
  deductorName: z.string().default(""),
  deductorEntityType: z.string().default("company"),
  isGovernmentDeductor: z.boolean().default(false),
  lateDeductionRatePctPerMonth: z.number().default(1),
  lateDepositRatePctPerMonth: z.number().default(1.5),
  lateFilingFeePerDay: rupees.optional(),
  lateDepositFeePerDay: rupees.optional(),
  returnFilingDate: date.nullish(),
  returnFilingDueDate: date,
  computeMaxPenalty271c: z.boolean().default(false),
  maxPenalty271cPct: z.number().default(100),
});

const tdsPenaltyExposure = z.object({
  kind: z.literal("tds-penalty-exposure"),
  events: z.array(tdsExposureEvent).min(1).max(20_000),
  params: tdsExposureParams,
});

/**
 * The audit-assurance workflow is `op`-discriminated, so the outer `kind`
 * union only asserts the kind; the op payload is validated strictly inside the
 * case. That keeps the ~35-op schema in its own testable module instead of
 * duplicating it into this file's discriminated union.
 */
const auditAssurance = z.object({ kind: z.literal("audit-assurance") }).passthrough();
const entityCompliance = z.object({ kind: z.literal("entity-compliance") }).passthrough();
const payrollOperations = z.object({ kind: z.literal("payroll-operations") }).passthrough();

const practiceManOuter = z.object({ kind: z.literal("practiceman") }).passthrough();
// Like the other op-discriminated kinds, the outer union only asserts `kind`;
// the `practiceman` case re-parses with practiceManOperations (a discriminated
// union cannot be merged into a ZodObject, and merging the op schema here would
// also defeat the single source of truth in the adapter).
// ---------------------------------------------------------------------------
// CA engines that had no live surface.
//
// Each engine below was complete and unit-tested but importable only by its own
// test — reachable from no route and no UI. Two of them also carried a
// money-unit defect that had to be fixed before they could cross the rupee
// boundary at all: tds-threshold-engine's threshold table was a factor of ten
// below true paise, and tds-form16-generator worked in deci-rupees while
// documenting paise. Exposing either with the wrong unit would have
// over-triggered TDS and understated Form 16 Part B tax.
// ---------------------------------------------------------------------------

const tdsThresholdEvent = z.object({
  id: z.string().min(1),
  section: z.string().min(1),
  deducteePan: z.string().default(""),
  deducteeName: z.string().default(""),
  deducteeType: z.string().default("company"),
  amount: rupees,
  dateOfPayment: date,
  dateOfCredit: date,
  isPaid: z.boolean().default(true),
  hasPan: z.boolean().default(true),
  isNonResident: z.boolean().default(false),
  ldcReference: z.string().nullish(),
  form15G_15HReference: z.string().nullish(),
  natureOfPayment: z.string().nullish(),
  voucherId: z.string().nullish(),
});

const tdsThreshold = z.object({
  kind: z.literal("tds-threshold"),
  events: z.array(tdsThresholdEvent).min(1).max(20_000),
  perDeducteeTracking: z.boolean().default(true),
  /** Brought-forward aggregate per `section` (or `section|pan` when tracking per deductee). */
  carryOver: z
    .array(
      z.object({
        section: z.string().min(1),
        deducteePan: z.string().default(""),
        cumulative: rupees,
        threshold: rupees,
      }),
    )
    .max(20_000)
    .default([]),
});

const tdsComputation = z.object({
  kind: z.literal("tds-computation"),
  payerPan: z.string().default(""),
  assessmentYear: z.string().default("2026-27"),
  transactions: z
    .array(
      z.object({
        section: z.string().min(1),
        payeeName: z.string().default(""),
        payeePan: z.string().default(""),
        amount: rupees,
        rate: z.number().finite(),
        threshold: rupees,
        dateOfPayment: date,
        dateOfDeduction: date,
        deposited: z.boolean().default(false),
        challan: z.string().default(""),
      }),
    )
    .min(1)
    .max(20_000),
  aggregateThresholds: z
    .array(z.object({ section: z.string().min(1), cumulative: rupees }))
    .max(20_000)
    .default([]),
  defaults: z
    .array(z.object({ section: z.string().min(1), delayDays: z.number().int().min(0), reason: z.string().default("") }))
    .max(20_000)
    .default([]),
});

const taxAudit = z.object({
  kind: z.literal("tax-audit"),
  fy: ayLabel,
  entityType: z.string().default("company"),
  category: z.string().optional(),
  turnover: rupees.default(0),
  presumptiveTurnover: rupees.default(0),
  exemptTurnover: rupees.default(0),
  booksRequired: z.boolean().default(false),
  auditedTurnoverFlag: z.boolean().default(false),
  professionalServices: z.boolean().default(false),
  presumptiveOpted: z.boolean().default(false),
  digitalReceiptsPct: z.number().finite().min(0).default(0),
});

const form15DeclarationInput = z.object({
  id: z.string().default("F15"),
  formType: z.enum(["15G", "15H"]),
  deducteePan: z.string().min(1),
  deducteeName: z.string().default(""),
  deducteeType: z.string().default("individual"),
  age: z.number().int().min(0).max(120),
  isNonResident: z.boolean().default(false),
  declarationDate: date,
  status: z.enum(["active", "expired", "cancelled", "violated"]).default("active"),
  financialYear: z.string().default("2025-26"),
  assessmentYear: z.string().default("2026-27"),
  estimatedTotalIncome: rupees.nullish(),
  estimatedTotalTax: rupees.nullish(),
  sections: z.array(z.string().min(1)).min(1),
  natureOfIncome: z.string().default("Interest"),
  scope: z.enum(["all", "specific"]).default("all"),
  specificSections: z.array(z.string().min(1)).nullish(),
  amountLimit: rupees.nullish(),
  validFrom: date,
  validUntil: date,
  declarationReference: z.string().nullish(),
  verified: z.boolean().default(false),
  documents: z.array(z.string()).nullish(),
  notes: z.string().nullish(),
  createdAt: z.string().default(""),
  updatedAt: z.string().default(""),
});

const ldcCertificateInput = z.object({
  id: z.string().default("LDC"),
  applicationId: z.string().default(""),
  certificateNumber: z.string().default(""),
  deducteePan: z.string().min(1),
  deducteeName: z.string().default(""),
  status: z.enum(["active", "expired", "suspended", "cancelled", "renewed"]).default("active"),
  sections: z.array(z.string().min(1)).min(1),
  natureOfIncome: z.string().default(""),
  lowerRate: z.number().finite().default(0),
  lowerAmountLimit: rupees.nullish(),
  validFrom: date,
  validUntil: date,
  validityPeriod: z.string().default(""),
  conditions: z.string().nullish(),
  remarks: z.string().nullish(),
  issuedAt: z.string().default(""),
  issuedBy: z.string().nullish(),
  createdAt: z.string().default(""),
});

/**
 * LDC / Form 15G-15H capture has two live questions: is this declaration on its
 * face valid, and does it cover a given payment? Both are ops on one kind.
 * Validity is judged against TODAY'S date by the engine, so `cover` answers
 * "did this document cover the payment on the payment date" only for documents
 * whose window contains the current date.
 */
const tdsLdc = z.object({
  kind: z.literal("tds-ldc"),
  op: z.enum(["validate-form15", "cover"]).default("validate-form15"),
  declaration: form15DeclarationInput.optional(),
  event: z
    .object({ deducteePan: z.string().min(1), section: z.string().min(1), amount: rupees, dateOfPaymentOrCredit: date })
    .optional(),
  form15Declarations: z.array(form15DeclarationInput).max(5_000).default([]),
  ldcCertificates: z.array(ldcCertificateInput).max(5_000).default([]),
});

const form16SalaryAnnexure = z.object({
  basicSalary: rupees.default(0),
  dearnessAllowance: rupees.default(0),
  houseRentAllowance: rupees.default(0),
  conveyanceAllowance: rupees.default(0),
  leaveTravelAllowance: rupees.default(0),
  medicalAllowance: rupees.default(0),
  specialAllowance: rupees.default(0),
  otherAllowances: rupees.default(0),
  bonus: rupees.default(0),
  commission: rupees.default(0),
  arrears: rupees.default(0),
  leaveEncashment: rupees.default(0),
  gratuity: rupees.default(0),
  pension: rupees.default(0),
  otherIncomeFromEmployer: rupees.default(0),
  totalSalary: rupees,
  standardDeduction: rupees.default(0),
  taxableSalary: rupees.default(0),
});

const form16ChapterVIA = z.object({
  section80C: rupees.default(0),
  section80CCC: rupees.default(0),
  section80CCD_1: rupees.default(0),
  section80CCD_2: rupees.default(0),
  section80CCD_1B: rupees.default(0),
  section80D: rupees.default(0),
  section80E: rupees.default(0),
  section80EE: rupees.default(0),
  section80G: rupees.default(0),
  section80GG: rupees.default(0),
  section80TTA: rupees.default(0),
  section80TTB: rupees.default(0),
  section80U: rupees.default(0),
  otherChapterVIA: rupees.default(0),
  totalChapterVIA: rupees.default(0),
});

const form16Entry = z.object({
  id: z.string().min(1),
  quarter: z.string().default("Q1"),
  fy: z.string().default("2025-26"),
  dateOfPayment: date,
  grossAmount: rupees,
  tdsAmount: rupees,
  challanRef: z.string().nullish(),
  bsrCode: z.string().nullish(),
  challanSerial: z.string().nullish(),
  dateOfDeposit: z.string().nullish(),
  challanAmount: rupees.nullish(),
  status: z.string().default("deposited"),
});

const form16AEntry = z.object({
  id: z.string().min(1),
  section: z.string().min(1),
  natureOfPayment: z.string().default(""),
  grossAmount: rupees,
  tdsAmount: rupees,
  challanRef: z.string().nullish(),
  bsrCode: z.string().nullish(),
  challanSerial: z.string().nullish(),
  dateOfDeposit: z.string().nullish(),
  challanAmount: rupees.nullish(),
  status: z.string().default("deposited"),
});

const tdsForm16 = z.object({
  kind: z.literal("tds-form16"),
  op: z.enum(["16", "16A"]).default("16"),
  deductorTan: z.string().default(""),
  deductorName: z.string().default(""),
  deducteePan: z.string().default(""),
  deducteeName: z.string().default(""),
  fy: z.string().default("2025-26"),
  assessmentYear: z.string().default("2026-27"),
  salaryEntries: z.array(form16Entry).max(5_000).default([]),
  nonSalaryEntries: z.array(form16AEntry).max(5_000).default([]),
  salary: form16SalaryAnnexure.optional(),
  chapterVIA: form16ChapterVIA.optional(),
  otherIncome: z
    .array(
      z.object({
        source: z.string().min(1),
        amount: rupees,
        tdsDeducted: z.boolean().default(false),
        remarks: z.string().nullish(),
      }),
    )
    .max(1_000)
    .default([]),
  tdsDeducted: rupees.default(0),
  relief89: rupees.default(0),
  relief90_91: rupees.default(0),
  otherRelief: rupees.default(0),
});

const itrScheduleLine = z.object({
  label: z.string().min(1),
  amount: rupees,
  col: z.number().int().optional(),
  notes: z.string().optional(),
});

interface ItrScheduleBlockInput {
  header: string;
  serial?: boolean;
  lines: { label: string; amount: number; col?: number; notes?: string }[];
  sub?: Record<string, ItrScheduleBlockInput>;
  totalLabel?: string;
  notes?: string[];
}

const itrScheduleBlock: z.ZodType<ItrScheduleBlockInput> = z.lazy(() =>
  z.object({
    header: z.string().min(1),
    serial: z.boolean().optional(),
    lines: z.array(itrScheduleLine),
    sub: z.record(z.string(), itrScheduleBlock).optional(),
    totalLabel: z.string().optional(),
    notes: z.array(z.string()).optional(),
  }),
) as unknown as z.ZodType<ItrScheduleBlockInput>;

/** The ITR schedule document builder — every money field crosses in RUPEES. */
const itrSchedules = z.object({
  kind: z.literal("itr-schedules"),
  formType: z.enum(["ITR-3", "ITR-4", "ITR-5", "ITR-6", "ITR-7"]),
  assessmentYear: ayLabel,
  general: z.record(z.string(), z.unknown()).default({}),
  schedules: z.record(z.string(), itrScheduleBlock).default({}),
  income: z.record(z.string(), rupees).default({}),
  tax: z.record(z.string(), rupees).default({}),
});

const form3cd = z.object({
  kind: z.literal("form3cd"),
  data: z.object({
    general: z.object({
      pan: z.string().min(1),
      name: z.string().min(1),
      assessmentYear: z.string().regex(/^\d{4}-\d{2}$/, "must be yyyy-mm-dd"),
      returnFilingStatus: z.string().min(1),
      dateOfAudit: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd"),
    }),
    observations: z
      .array(
        z.object({
          clause: z.string().min(1),
          observation: z.string().min(1),
        }),
      )
      .min(1),
  }),
});

const rocCompliance = z.object({
  kind: z.literal("roc-compliance"),
  profile: z.object({
    companyName: z.string().min(1),
    cin: z.string().min(1),
    regNumber: z.string().optional(),
    incorporationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd"),
  }),
  filings: z
    .array(
      z.object({
        form: z.enum(["AOC4", "MGT7", "DIR3"]),
        financialYear: z.string().regex(/^\d{4}-\d{2}$/, "must be yyyy-mm"),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd"),
        filed: z.boolean().default(false),
      }),
    )
    .min(1),
  calendar: z
    .array(
      z.object({
        form: z.enum(["AOC4", "MGT7", "DIR3"]),
        financialYear: z.string().regex(/^\d{4}-\d{2}$/, "must be yyyy-mm"),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd"),
        met: z.boolean().default(false),
      }),
    )
    .optional(),
});

const profTaxInput = z.object({
  kind: z.literal("professional-tax"),
  stateCode: z.string().min(1),
  grossSalary: rupees,
});

const labourLawInput = z.object({
  kind: z.literal("labour-law"),
  employees: z
    .array(
      z.object({
        employeeId: z.string().min(1),
        name: z.string().min(1),
        appointedWage: rupees,
        category: z.enum(["unskilled", "semi-skilled", "skilled", "highly-skilled"]),
        areaType: z.enum(["urban", "rural"]),
      }),
    )
    .min(1),
  contributionPeriod: z.string().min(1),
  checkType: z.enum(["minimum-wage", "epf", "bonus", "gratuity", "esi", "lwf"]),
});

const msmeSamadhaanInput = z.object({
  kind: z.literal("msme-samadhaan"),
  investment: z.number().int().min(0),
  turnover: z.number().int().min(0),
  micro: z.boolean().default(true),
  small: z.boolean().default(false),
  reportType: z.enum(["delayed-payment", "threshold", "classification"]).default("delayed-payment"),
});

// ---------------------------------------------------------------------------
// Litigation & appeals (ca-litigation) — every money field crosses in RUPEES.
// ---------------------------------------------------------------------------

const litigationForum = z.enum(["ao", "cit-appeals", "itat", "high-court"]);

const litigationMatter = z.object({
  matterId: z.string().min(1),
  clientName: z.string().min(1),
  pan: z.string().min(1),
  assessmentYear: ayLabel,
  orderBy: litigationForum,
  orderReference: z.string().min(1),
  orderDate: date,
  servedDate: date,
  taxEffect: rupees.nonnegative(),
  disputedTax: rupees.nonnegative().optional(),
  grounds: z.array(z.string().min(1)).min(1),
  filingDate: date.optional(),
});

const litigation = z.object({
  kind: z.literal("litigation"),
  op: z.discriminatedUnion("op", [
    z.object({ op: z.literal("plan-appeal"), matter: litigationMatter }),
    z.object({
      op: z.literal("portfolio"),
      matters: z
        .array(
          z.object({
            matterId: z.string().min(1),
            clientName: z.string().min(1),
            forum: litigationForum,
            taxEffect: rupees.nonnegative(),
            servedDate: date,
            limitationDays: z.number().int().min(0),
            filingDate: date,
            status: z.enum(["not-filed", "filed", "heard", "disposed"]),
          }),
        )
        .min(1)
        .max(2_000),
      dueSoonDays: z.number().int().min(0).max(365).default(15),
    }),
  ]),
});

// ---------------------------------------------------------------------------
// Timesheets / WIP / billing (practice-timesheets) — money crosses in RUPEES.
// ---------------------------------------------------------------------------

const timesheetEntry = z.object({
  id: z.string().min(1),
  staffId: z.string().min(1),
  staffName: z.string().min(1),
  engagementId: z.string().min(1),
  clientName: z.string().min(1),
  date,
  hours: z.number().min(0).max(24),
  billable: z.boolean().default(true),
  ratePerHour: rupees.nonnegative(),
  notes: z.string().nullish(),
});

const timesheetEntryToEngine = (e: z.infer<typeof timesheetEntry>): TimesheetEntry => ({
  id: e.id,
  staffId: e.staffId,
  staffName: e.staffName,
  engagementId: e.engagementId,
  clientName: e.clientName,
  date: e.date,
  hours: e.hours,
  billable: e.billable,
  ratePerHourMinor: paise(e.ratePerHour),
  notes: e.notes ?? null,
});

const timesheets = z.object({
  kind: z.literal("timesheets"),
  op: z.discriminatedUnion("op", [
    z.object({
      op: z.literal("summarise"),
      entries: z.array(timesheetEntry).min(1).max(20_000),
      budgets: z.record(z.string(), z.number().min(0)).optional(),
      targetUtilisationPct: z.number().min(0).max(100).optional(),
      asOfDate: date.optional(),
    }),
    z.object({
      op: z.literal("invoice"),
      invoiceNumber: z.string().min(1),
      invoiceDate: date,
      supplierName: z.string().min(1),
      supplierGstin: z.string().min(1),
      supplierStateCode: z.string().min(1),
      clientName: z.string().min(1),
      clientGstin: z.string().nullish(),
      placeOfSupplyStateCode: z.string().min(1),
      entries: z.array(timesheetEntry).min(1).max(20_000),
      discountPct: z.number().min(0).max(100).default(0),
      gstRatePct: z.number().min(0).max(50).optional(),
      tdsSection: z.string().optional(),
      tdsRatePct: z.number().min(0).max(100).optional(),
      previouslyInvoiced: rupees.nonnegative().optional(),
    }),
  ]),
});

// ---------------------------------------------------------------------------
// Document management & client portal (ca-documents). Sizes are bytes.
// ---------------------------------------------------------------------------

const documentCategory = z.enum(DOCUMENT_CATEGORIES as unknown as [DocumentCategory, ...DocumentCategory[]]);
const isoDate = date;

const documentRecord = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: documentCategory,
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  engagementId: z.string().nullish(),
  uploadedAt: isoDate,
  uploadedBy: z.string().min(1),
  version: z.number().int().min(1),
  sizeBytes: z.number().int().min(0),
  signed: z.boolean().default(false),
  sharedWithClient: z.boolean().default(false),
});

const documentToEngine = (d: z.infer<typeof documentRecord>): DocumentRecord => ({
  id: d.id,
  name: d.name,
  category: d.category,
  clientId: d.clientId,
  clientName: d.clientName,
  engagementId: d.engagementId ?? null,
  uploadedAt: d.uploadedAt,
  uploadedBy: d.uploadedBy,
  version: d.version,
  sizeBytes: d.sizeBytes,
  signed: d.signed,
  sharedWithClient: d.sharedWithClient,
});

const documents = z.object({
  kind: z.literal("documents"),
  op: z.discriminatedUnion("op", [
    z.object({
      op: z.literal("register"),
      documents: z.array(documentRecord).min(1).max(20_000),
      asOfDate: isoDate.optional(),
      requiredCategories: z.array(documentCategory).optional(),
      expiringSoonDays: z.number().int().min(0).max(3_650).optional(),
    }),
    z.object({
      op: z.literal("client-portal"),
      client: z.object({ clientId: z.string().min(1), clientName: z.string().min(1) }),
      documents: z.array(documentRecord).min(1).max(20_000),
      awaiting: z.array(documentCategory).optional(),
    }),
  ]),
});

// ---------------------------------------------------------------------------
// ITR-U updated return (itr-u) — money crosses in RUPEES.
// ---------------------------------------------------------------------------

const itrU = z.object({
  kind: z.literal("itr-u"),
  pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, "must be a valid PAN"),
  name: z.string().min(1),
  assessmentYear: ayLabel,
  originalReturnFiledDate: date.nullable().default(null),
  updatedReturnFilingDate: date,
  originalTotalIncome: rupees.nonnegative(),
  updatedTotalIncome: rupees.nonnegative(),
  taxOnOriginal: rupees.nonnegative(),
  taxOnUpdated: rupees.nonnegative(),
  interestOnUpdated: rupees.nonnegative(),
  taxAlreadyPaid: rupees.nonnegative(),
  pendingProceedings: z.boolean().default(false),
  searchOrSurvey: z.boolean().default(false),
  reducesReportedIncome: z.boolean().default(false),
  showsLoss: z.boolean().default(false),
  reasons: z.array(z.string().min(1)).optional(),
});

const body = z.discriminatedUnion("kind", [
  bankRecon,
  ageing,
  payroll,
  fixedAssets,
  tdsReturn,
  gstr9,
  ratioAnalysis,
  financialAnalysis,
  complianceCheck,
  transferPricing,
  fema,
  auditOpinion,
  rateRegistry,
  salaryHeadInput,
  housePropertyHead,
  capitalGainsHead,
  itrInput,
  advanceTaxInput,
  advanceTaxAdvisory,
  tdsSection,
  tdsChallanRecon,
  tdsPenaltyExposure,
  tdsThreshold,
  tdsComputation,
  taxAudit,
  tdsLdc,
  tdsForm16,
  itrSchedules,
  auditAssurance,
  entityCompliance,
  payrollOperations,
  practiceManOuter,
  form3cd,
  rocCompliance,
  profTaxInput,
  labourLawInput,
  msmeSamadhaanInput,
  internalAuditInput,
  concurrentAuditInput,
  stockAuditInput,
  litigation,
  timesheets,
  documents,
  itrU,
]);

const toPaiseTax = (t: z.infer<typeof taxAmounts>) => ({
  taxableValue: paise(t.taxableValue),
  igst: paise(t.igst),
  cgst: paise(t.cgst),
  sgst: paise(t.sgst),
  cess: paise(t.cess),
});

export async function POST(request: Request) {
  try {
    await requireAuth();
    const input = body.parse(await readJsonBody(request));

    switch (input.kind) {
      case "bank-recon": {
        const cashBook: CashBookRow[] = input.cashBook.map((r) => ({
          id: r.id,
          date: r.date,
          narration: r.narration,
          amount: paise(r.amount),
          reference: r.reference ?? null,
        }));
        const statement: BankStatementRow[] = input.statement.map((r) => ({
          id: r.id,
          date: r.date,
          narration: r.narration,
          amount: paise(r.amount),
          reference: r.reference ?? null,
        }));
        return ok({
          reconciliation: reconcileBank({
            cashBook,
            statement,
            asOfDate: input.asOfDate,
            tolerance: input.tolerance !== undefined ? paise(input.tolerance) : undefined,
          }),
        });
      }

      case "ageing": {
        const invoices: OpenInvoice[] = input.invoices.map((i) => ({
          number: i.number,
          counterparty: i.counterparty,
          date: i.date,
          outstanding: paise(i.outstanding),
          msmeRegistration: i.msmeRegistration,
        }));
        const ageingResult = ageInvoices({ invoices, asOfDate: input.asOfDate });
        const msme = input.msmeSuppliers
          ? msme43bh({
              invoices,
              suppliers: input.msmeSuppliers.map((s) => ({ ...s, msmeInterestRatePct: s.msmeInterestRatePct })),
              asOfDate: input.asOfDate,
            })
          : null;
        return ok({ ageing: ageingResult, msme });
      }

      case "payroll": {
        const regime = INDIVIDUAL_REGIMES[input.regimeId];
        if (!regime) return toErrorResponse(new Error("Unknown regime."));
        const register = payrollRegister({
          month: input.month,
          regime,
          monthsRemaining: input.monthsRemaining,
          annualSalaries: input.annualSalaries
            ? Object.fromEntries(Object.entries(input.annualSalaries).map(([k, v]) => [k, paise(v)]))
            : undefined,
          employees: input.employees.map((e) => ({
            employeeId: e.employeeId,
            name: e.name,
            basic: paise(e.basic),
            dearnessAllowance: e.dearnessAllowance !== undefined ? paise(e.dearnessAllowance) : undefined,
            hra: e.hra !== undefined ? paise(e.hra) : undefined,
            otherAllowances: e.otherAllowances !== undefined ? paise(e.otherAllowances) : undefined,
          })),
          config: input.config
            ? {
                ...(input.config.epfWageCeiling !== undefined
                  ? { epfWageCeiling: paise(input.config.epfWageCeiling) }
                  : {}),
                ...(input.config.epfRatePct !== undefined ? { epfRatePct: input.config.epfRatePct } : {}),
                ...(input.config.epsRatePct !== undefined ? { epsRatePct: input.config.epsRatePct } : {}),
                ...(input.config.edliRatePct !== undefined ? { edliRatePct: input.config.edliRatePct } : {}),
                ...(input.config.epfAdminRatePct !== undefined
                  ? { epfAdminRatePct: input.config.epfAdminRatePct }
                  : {}),
                ...(input.config.epfOnActualWages !== undefined
                  ? { epfOnActualWages: input.config.epfOnActualWages }
                  : {}),
                ...(input.config.esiWageCeiling !== undefined
                  ? { esiWageCeiling: paise(input.config.esiWageCeiling) }
                  : {}),
                ...(input.config.esiEmployeeRatePct !== undefined
                  ? { esiEmployeeRatePct: input.config.esiEmployeeRatePct }
                  : {}),
                ...(input.config.esiEmployerRatePct !== undefined
                  ? { esiEmployerRatePct: input.config.esiEmployerRatePct }
                  : {}),
                ...(input.config.professionalTaxSlabs !== undefined
                  ? {
                      professionalTaxSlabs: input.config.professionalTaxSlabs.map((s) => ({
                        upTo: s.upTo === null ? null : paise(s.upTo),
                        amount: paise(s.amount),
                      })),
                    }
                  : {}),
              }
            : undefined,
        });
        return ok({ register });
      }

      case "fixed-assets": {
        const register = buildAssetRegister({
          fy: input.fy,
          method: input.method,
          residualPct: input.residualPct,
          additionalDepreciationPct: input.additionalDepreciationPct,
          taxOpeningWdv: input.taxOpeningWdv
            ? Object.fromEntries(Object.entries(input.taxOpeningWdv).map(([k, v]) => [k, paise(v)]))
            : undefined,
          assets: input.assets.map((a) => ({
            id: a.id,
            name: a.name,
            cost: paise(a.cost),
            acquisitionDate: a.acquisitionDate,
            putToUseDate: a.putToUseDate,
            bookClass: a.bookClass,
            taxBlock: a.taxBlock,
            openingBookDepreciation: paise(a.openingBookDepreciation),
            disposal: a.disposal ? { date: a.disposal.date, saleProceeds: paise(a.disposal.saleProceeds) } : null,
          })),
        });
        return ok({ register });
      }

      case "tds-return": {
        const result = prepareTdsReturn({
          form: input.form,
          tan: input.tan,
          quarter: input.quarter,
          filingDueDate: input.filingDueDate,
          filingDate: input.filingDate,
          lateDeductionRatePctPerMonth: input.lateDeductionRatePctPerMonth,
          lateDepositRatePctPerMonth: input.lateDepositRatePctPerMonth,
          feePerDay: input.feePerDay !== undefined ? paise(input.feePerDay) : undefined,
          deductions: input.deductions.map((d) => ({
            payeeName: d.payeeName,
            pan: d.pan ?? null,
            section: d.section,
            baseAmount: paise(d.baseAmount),
            ratePct: d.ratePct,
            deducted: paise(d.deducted),
            deductibleDate: d.deductibleDate,
            deductedDate: d.deductedDate,
            depositedDate: d.depositedDate ?? null,
          })),
          challans: input.challans.map((c) => ({
            bsrCode: c.bsrCode,
            challanSerial: c.challanSerial,
            dateOfDeposit: c.dateOfDeposit,
            amount: paise(c.amount),
            section: c.section ?? null,
          })),
        });
        return ok({ tdsReturn: result });
      }

      case "gstr9": {
        const result = buildGstr9({
          fy: input.fy,
          tolerance: input.tolerance !== undefined ? paise(input.tolerance) : undefined,
          outward: input.outward.map(toPaiseTax),
          itcAvailed: input.itcAvailed.map(toPaiseTax),
          itcReversed: input.itcReversed?.map(toPaiseTax),
          importsItc: input.importsItc ? toPaiseTax(input.importsItc) : undefined,
          rcm: input.rcm?.map(toPaiseTax),
          twoBAvailable: input.twoBAvailable ? toPaiseTax(input.twoBAvailable) : undefined,
          previousYearClaims: input.previousYearClaims ? toPaiseTax(input.previousYearClaims) : undefined,
        });
        return ok({ gstr9: result });
      }

      case "ratio-analysis": {
        const result = analyzeRatios({
          label: input.label,
          revenue: paise(input.revenue),
          costOfGoodsSold: paise(input.costOfGoodsSold),
          grossProfit: paise(input.grossProfit),
          operatingExpenses: paise(input.operatingExpenses),
          operatingProfit: paise(input.operatingProfit),
          otherIncome: paise(input.otherIncome),
          financeCosts: paise(input.financeCosts),
          profitBeforeTax: paise(input.profitBeforeTax),
          taxExpense: paise(input.taxExpense),
          netProfit: paise(input.netProfit),
          earningsPerShare: input.earningsPerShare !== undefined ? input.earningsPerShare : undefined,
          dividendsPerShare: input.dividendsPerShare !== undefined ? input.dividendsPerShare : undefined,
          currentAssets: paise(input.currentAssets),
          currentLiabilities: paise(input.currentLiabilities),
          inventory: paise(input.inventory),
          tradeReceivables: paise(input.tradeReceivables),
          cashAndBank: paise(input.cashAndBank),
          totalAssets: paise(input.totalAssets),
          totalLiabilities: paise(input.totalLiabilities),
          equity: paise(input.equity),
          longTermDebt: paise(input.longTermDebt),
          fixedAssets: paise(input.fixedAssets),
          intangibleAssets: paise(input.intangibleAssets),
          openingEquity:
            input.openingEquity !== undefined && input.openingEquity !== null ? paise(input.openingEquity) : undefined,
          openingLongTermDebt:
            input.openingLongTermDebt !== undefined && input.openingLongTermDebt !== null
              ? paise(input.openingLongTermDebt)
              : undefined,
          openingTotalAssets:
            input.openingTotalAssets !== undefined && input.openingTotalAssets !== null
              ? paise(input.openingTotalAssets)
              : undefined,
          openingInventory:
            input.openingInventory !== undefined && input.openingInventory !== null
              ? paise(input.openingInventory)
              : undefined,
          openingTradeReceivables:
            input.openingTradeReceivables !== undefined && input.openingTradeReceivables !== null
              ? paise(input.openingTradeReceivables)
              : undefined,
          openingCurrentAssets:
            input.openingCurrentAssets !== undefined && input.openingCurrentAssets !== null
              ? paise(input.openingCurrentAssets)
              : undefined,
          openingCurrentLiabilities:
            input.openingCurrentLiabilities !== undefined && input.openingCurrentLiabilities !== null
              ? paise(input.openingCurrentLiabilities)
              : undefined,
          purchases: input.purchases !== undefined && input.purchases !== null ? paise(input.purchases) : undefined,
          creditSales:
            input.creditSales !== undefined && input.creditSales !== null ? paise(input.creditSales) : undefined,
          sharePrice: input.sharePrice !== undefined && input.sharePrice !== null ? input.sharePrice : undefined,
          sharesOutstanding:
            input.sharesOutstanding !== undefined && input.sharesOutstanding !== null
              ? input.sharesOutstanding
              : undefined,
        });
        return ok({ ratioAnalysis: result });
      }

      case "financial-analysis": {
        const pair: StatementPair = {
          currentLabel: input.currentLabel,
          priorLabel: input.priorLabel,
          currentIs: input.currentIs.map((l) => ({ key: l.key, label: l.label, amount: paise(l.amount) })),
          priorIs: input.priorIs
            ? input.priorIs.map((l) => ({ key: l.key, label: l.label, amount: paise(l.amount) }))
            : null,
          currentBs: input.currentBs.map((l) => ({ key: l.key, label: l.label, amount: paise(l.amount) })),
          priorBs: input.priorBs
            ? input.priorBs.map((l) => ({ key: l.key, label: l.label, amount: paise(l.amount) }))
            : null,
          currentCf: input.currentCf
            ? input.currentCf.map((l) => ({ key: l.key, label: l.label, amount: paise(l.amount) }))
            : [],
          priorCf: input.priorCf
            ? input.priorCf.map((l) => ({ key: l.key, label: l.label, amount: paise(l.amount) }))
            : null,
          revenueBase:
            input.revenueBase !== undefined && input.revenueBase !== null ? paise(input.revenueBase) : undefined,
          totalAssetsBase:
            input.totalAssetsBase !== undefined && input.totalAssetsBase !== null
              ? paise(input.totalAssetsBase)
              : undefined,
          cashFlowBase:
            input.cashFlowBase !== undefined && input.cashFlowBase !== null ? paise(input.cashFlowBase) : undefined,
        };
        return ok({ financialAnalysis: analyzeStatements(pair) });
      }

      case "compliance-check": {
        const status = complianceStatus({
          clientName: input.clientName,
          fy: input.fy,
          entityType: input.entityType,
          referenceDate: input.referenceDate,
          calendar: input.calendar,
        });
        let auditDetermination: AuditDetermination | null = null;
        if (input.auditDetermination) {
          if (input.auditDetermination.kind === "44AB") {
            auditDetermination = auditRequired44AB({
              ay: input.auditDetermination.ay,
              turnoverMinor: paise(input.auditDetermination.turnoverMinor),
              cashReceiptsMinor: paise(input.auditDetermination.cashReceiptsMinor),
            });
          } else if (input.auditDetermination.kind === "44ADA") {
            auditDetermination = auditRequired44ADA({
              ay: input.auditDetermination.ay,
              grossReceiptsMinor: paise(input.auditDetermination.receiptsMinor),
              bankingChannelPct: input.auditDetermination.bankingChannelPct,
            });
          }
        }
        return ok({ complianceStatus: { ...status, auditDetermination } });
      }

      case "transfer-pricing": {
        return ok({
          armLength: input.armLength
            ? applyArmLengthTest(
                paise(input.armLength.actualMinor),
                input.armLength.comparablesMinor.map(paise),
                input.armLength.tolerancePct ?? tolerancePctFor(input.armLength.toleranceClass),
              )
            : null,
          tnmm: input.tnmm
            ? methodTnmm(
                input.tnmm.testedOmPct,
                input.tnmm.comparableOmPcts,
                input.tnmm.tolerancePct ?? tolerancePctFor(input.tnmm.toleranceClass),
              )
            : null,
          thinCap94b: input.thinCap94b
            ? thinCapitalisation94B(
                paise(input.thinCap94b.interestExpenseMinor),
                paise(input.thinCap94b.ebitdaMinor),
                input.thinCap94b.deMinimisMinor !== undefined ? paise(input.thinCap94b.deMinimisMinor) : undefined,
              )
            : null,
          form3ceb: input.form3ceb
            ? form3cebSummary(
                input.form3ceb.map((t) => ({
                  description: t.description,
                  type: t.type,
                  method: t.method,
                  valueMinor: paise(t.valueMinor),
                  adjustmentMinor: paise(t.adjustmentMinor),
                })),
              )
            : null,
          multipleYear: input.multipleYear
            ? multipleYearWeightedMean(input.multipleYear.yearlyValues.map(paise), input.multipleYear.weights)
            : null,
        });
      }

      case "fema": {
        return ok({
          fcgpr: input.fcgpr
            ? fcgpr({
                allotmentDate: input.fcgpr.allotmentDate,
                filedOn: input.fcgpr.filedOn ?? null,
                issuePriceMinor: paise(input.fcgpr.issuePriceMinor),
                fairValueMinor: paise(input.fcgpr.fairValueMinor),
              })
            : null,
          fctrs: input.fctrs
            ? fctrs({
                direction: input.fctrs.direction,
                transferPriceMinor: paise(input.fctrs.transferPriceMinor),
                fairValueMinor: paise(input.fctrs.fairValueMinor),
              })
            : null,
          odi: input.odi
            ? odiLimit({
                netWorthMinor: paise(input.odi.netWorthMinor),
                approvedByRbiMinor:
                  input.odi.approvedByRbiMinor !== undefined ? paise(input.odi.approvedByRbiMinor) : undefined,
                totalFinancialCommitmentMinor: paise(input.odi.totalFinancialCommitmentMinor),
              })
            : null,
          ecb: input.ecb ? ecbRate(input.ecb) : null,
          lrs: input.lrs ? lrsTcs(input.lrs) : null,
        });
      }

      case "audit-opinion": {
        const materiality = computeMateriality({
          profitBeforeTaxMinor: paise(input.materiality.profitBeforeTaxMinor),
          overallPct: input.materiality.overallPct,
          performancePct: input.materiality.performancePct,
          clearlyTrivialPct: input.materiality.clearlyTrivialPct,
          benchmark:
            input.materiality.benchmarkName && input.materiality.benchmarkAmountMinor !== undefined
              ? { name: input.materiality.benchmarkName, amountMinor: paise(input.materiality.benchmarkAmountMinor) }
              : undefined,
        });
        const opinion = formOpinion({
          uncorrectedMisstatementsMinor: paise(input.opinion.uncorrectedMisstatementsMinor),
          materialityMinor: materiality.materiality,
          evidenceSufficient: input.opinion.evidenceSufficient,
          cause: input.opinion.cause,
          pervasiveness: input.opinion.pervasiveness,
        });
        const wpIndex = workingPaperIndex(input.signedOffRefs ?? []);
        return ok({ materiality, opinion, workingPapers: wpIndex });
      }

      case "audit-assurance": {
        const payload = auditAssuranceInput.parse(input);
        return ok({ auditAssurance: computeAuditAssurance(payload) });
      }

      case "entity-compliance": {
        const payload = entityComplianceInput.parse(input);
        return ok({ entityCompliance: computeEntityCompliance(payload) });
      }

      case "payroll-operations": {
        const payload = payrollOperationsInput.parse(input);
        return ok({ payrollOperations: computePayrollOperations(payload) });
      }

      case "practiceman": {
        const payload = practiceManOperations.parse(input);
        const result = computePracticeManagement(payload);
        if (result.op === "build") {
          return ok({ practiceManagement: result.result });
        }
        return ok({ practiceManagementOp: result });
      }

      case "rate-registry": {
        const tables = input.kinds.map((kind) => {
          const { table, overridden } = getRateTable(input.ay, kind);
          const slab = input.incomeForSlab !== undefined ? slabRateFor(table, input.incomeForSlab) : null;
          return { kind, overridden, table, slabRate: slab };
        });
        return ok({ ay: input.ay, tables });
      }

      case "income-head-salary": {
        const regime = INDIVIDUAL_REGIMES[input.regimeId];
        if (!regime) return toErrorResponse(new Error("Unknown regime."));
        const salaryHead = computeSalaryHead({
          ay: input.ay,
          components: input.components.map((c) => ({
            label: c.label,
            amount: paise(c.amount),
            countsForSalary: c.countsForSalary,
            notes: c.notes,
          })),
          perquisites: {
            taxableValue: paise(input.perquisites.taxableValue),
            items: input.perquisites.items?.map((i) => ({
              description: i.description,
              value: paise(i.value),
              notes: i.notes,
            })),
          },
          allowances: {
            hraExempt: paise(input.allowances.hraExempt),
            exemptAllowances10_14: paise(input.allowances.exemptAllowances10_14),
            otherExempt: paise(input.allowances.otherExempt),
            professionalTax: paise(input.allowances.professionalTax),
          },
          relief: input.relief
            ? {
                arrearsReceived: paise(input.relief.arrearsReceived),
                taxIncludingArrears: paise(input.relief.taxIncludingArrears),
                taxExcludingArrears: paise(input.relief.taxExcludingArrears),
                taxOnArrearsInPastYear: paise(input.relief.taxOnArrearsInPastYear),
              }
            : null,
          pension: input.pension
            ? {
                uncommutedPension: paise(input.pension.uncommutedPension),
                commutedPension: paise(input.pension.commutedPension),
                oneThirdCommuted: input.pension.oneThirdCommuted,
                yearsOfService: input.pension.yearsOfService,
                retirementDate: input.pension.retirementDate,
              }
            : null,
          gratuity: input.gratuity
            ? {
                received: paise(input.gratuity.received),
                basicAndDa: paise(input.gratuity.basicAndDa),
                yearsOfService: input.gratuity.yearsOfService,
                coveredUnderAct: input.gratuity.coveredUnderAct,
              }
            : null,
          leave: input.leave
            ? {
                receivedAtRetirement: paise(input.leave.receivedAtRetirement),
                averageSalary10Months: paise(input.leave.averageSalary10Months),
                leaveEntitlementDays: input.leave.leaveEntitlementDays,
                leaveTakenDays: input.leave.leaveTakenDays,
              }
            : null,
          regime,
          grader: input.compareRegimes ? { regimesToGrade: [NEW_REGIME_2025_26, OLD_REGIME_2025_26] } : undefined,
        });
        return ok({ salaryHead });
      }

      case "house-property": {
        const properties: HousePropertyInput[] = input.properties.map((p) => ({
          id: p.id,
          status: p.status,
          municipalValue: paise(p.municipalValue),
          fairRent: p.fairRent !== undefined ? paise(p.fairRent) : undefined,
          standardRent: p.standardRent !== undefined ? paise(p.standardRent) : undefined,
          rentReceived: paise(p.rentReceived),
          unrealizedRealized: p.unrealizedRealized !== undefined ? paise(p.unrealizedRealized) : undefined,
          municipalTaxPaid: paise(p.municipalTaxPaid),
          interestOnHousingLoan: paise(p.interestOnHousingLoan),
          preConstructionInterest:
            p.preConstructionInterest !== undefined ? paise(p.preConstructionInterest) : undefined,
          tdsDeductedByLender: p.tdsDeductedByLender !== undefined ? paise(p.tdsDeductedByLender) : undefined,
          actualExpenses: p.actualExpenses !== undefined ? paise(p.actualExpenses) : undefined,
          notes: p.notes,
        }));
        const houseProperty = computeHousePropertyAggregate(
          {
            ay: input.ay,
            regimeLabel: input.regimeLabel,
            properties,
            electOneSelfOccupiedAsNil: input.electOneSelfOccupiedAsNil,
          },
          paise(input.priorYearLossBroughtForward),
          input.priorYearLossAlreadySetOffInPriorYears !== undefined
            ? paise(input.priorYearLossAlreadySetOffInPriorYears)
            : undefined,
        );
        return ok({ houseProperty });
      }

      case "capital-gains": {
        const transactions: AssetTransactionWithOverride[] = input.transactions.map((t) => ({
          id: t.id,
          assetClass: t.assetClass,
          acquisitionDate: t.acquisitionDate,
          transferDate: t.transferDate,
          saleProceeds: paise(t.saleProceeds),
          costOfAcquisition: paise(t.costOfAcquisition),
          costOfImprovement: t.costOfImprovement !== undefined ? paise(t.costOfImprovement) : undefined,
          expenditureOnTransfer: t.expenditureOnTransfer !== undefined ? paise(t.expenditureOnTransfer) : undefined,
          holding: t.holding,
          indexedCostClaimed: t.indexedCostClaimed,
          indexedCostOfAcquisition:
            t.indexedCostOfAcquisition !== undefined ? paise(t.indexedCostOfAcquisition) : undefined,
          indexedCostOfImprovement:
            t.indexedCostOfImprovement !== undefined ? paise(t.indexedCostOfImprovement) : undefined,
          grandfatheringBasis: t.grandfatheringBasis,
          sttPaid: t.sttPaid,
          foreignAsset: t.foreignAsset,
          foreignCountry: t.foreignCountry,
          notes: t.notes,
          specialRateOverride: t.specialRateOverride
            ? {
                section: t.specialRateOverride.section,
                ratePct: t.specialRateOverride.ratePct,
                exemption:
                  t.specialRateOverride.exemption !== undefined ? paise(t.specialRateOverride.exemption) : undefined,
                note: t.specialRateOverride.note,
              }
            : null,
        }));
        const capitalGains = computeCapitalGainHead({
          ay: input.ay,
          regimeLabel: input.regimeLabel,
          transactions,
          lossBroughtForward: {
            shortTerm: paise(input.lossBroughtForward.shortTerm),
            longTerm: paise(input.lossBroughtForward.longTerm),
          },
          foreignAssetReporting: input.foreignAssetReporting,
        });
        return ok({ capitalGains });
      }

      case "itr": {
        const itr = computeItr({
          fy: input.fy,
          assesseeType: input.assesseeType === "huf" ? "hir india" : input.assesseeType,
          residentialStatus: input.residentialStatus,
          incomeHeads: input.incomeHeads,
          deductions: input.deductions,
          hra: input.hra,
          losses: input.losses,
          scheduleAi: input.scheduleAi,
          prepaidTax: input.prepaidTax,
          formType: input.formType,
          surcharges: input.surcharges,
        });
        return ok({ itr });
      }

      case "advance-tax": {
        const heads = input.incomeHeads;
        const headsTotal =
          heads.salary + heads.houseProperty + heads.businessProfession + heads.capitalGains + heads.otherSources;
        const advanceTax = computeAdvanceTax({
          fy: input.fy,
          assesseeType: input.assesseeType === "huf" ? "hindu-undivided-family" : input.assesseeType,
          residentialStatus: input.residentialStatus,
          regime: input.regime,
          estimatedTotalIncome: input.estimatedTotalIncome ?? headsTotal,
          grossTotalIncome: input.grossTotalIncome ?? headsTotal,
          incomeHeads: heads,
          deductions: input.deductions,
          hra: input.hra ?? null,
          losses: input.losses,
          method: input.method,
          incomeByInstalment: input.incomeByInstalment,
          prepaidTax: input.prepaidTax,
          delayedFilingDays: input.delayedFilingDays,
          liabilityExceedsThreshold: input.liabilityExceedsThreshold,
          computeRegimeComparison: input.computeRegimeComparison,
        });
        return ok({ advanceTax });
      }

      case "advance-tax-advisory": {
        const regime = INDIVIDUAL_REGIMES[input.regimeId];
        if (!regime) return toErrorResponse(new Error("Unknown regime."));
        const advisory = advanceTaxAdvice({
          clientName: input.clientName,
          fy: input.fy,
          regime,
          totalTax: paise(input.totalTax),
          advanceTaxPaid: paise(input.advanceTaxPaid),
          referenceDate: input.referenceDate,
          filingDueDate: input.filingDueDate,
          selfAssessmentTax: input.selfAssessmentTax !== undefined ? paise(input.selfAssessmentTax) : undefined,
        });
        return ok({ advanceTaxAdvisory: advisory });
      }

      case "tds-section": {
        const sections: readonly TdsSectionDefinition[] = input.section
          ? [lookupSection(input.section)].filter((d): d is TdsSectionDefinition => d !== undefined)
          : input.form
            ? sectionsForForm(input.form)
            : TDS_SECTIONS;
        return ok({ sections });
      }

      case "tds-challan-recon": {
        const challans: TdsChallanReceipt[] = input.challans.map((c) => ({
          bsrCode: c.bsrCode,
          challanSerial: c.challanSerial,
          dateOfDeposit: c.dateOfDeposit,
          amount: paise(c.amount),
          section: c.section ?? null,
          deducteePan: c.deducteePan ?? null,
          challanType: c.challanType ?? null,
          remarks: c.remarks ?? null,
          verified: c.verified,
          bankRef: c.bankRef ?? null,
        }));
        const bankStatement = input.bankStatement.map((b) => ({
          date: b.date,
          description: b.description,
          amount: paise(b.amount),
          ref: b.ref,
        }));
        return ok({ reconciliation: reconcileChallans(challans, bankStatement) });
      }

      case "tds-penalty-exposure": {
        const events: TdsExposureEvent[] = input.events.map((e) => ({
          id: e.id,
          section: e.section,
          payeeName: e.payeeName,
          payeePan: e.payeePan ?? null,
          baseAmount: paise(e.baseAmount),
          ratePct: e.ratePct,
          taxShouldBe: paise(e.taxShouldBe),
          taxActual: paise(e.taxActual),
          deductibleDate: e.deductibleDate,
          deductedDate: e.deductedDate ?? null,
          depositedDate: e.depositedDate ?? null,
          returnFiled: e.returnFiled,
          returnFiledDate: e.returnFiledDate ?? null,
          natureOfPayment: e.natureOfPayment ?? null,
          isTcs: e.isTcs,
        }));
        const params: TdsExposureParams = {
          ...input.params,
          lateFilingFeePerDay:
            input.params.lateFilingFeePerDay !== undefined ? paise(input.params.lateFilingFeePerDay) : undefined,
          lateDepositFeePerDay:
            input.params.lateDepositFeePerDay !== undefined ? paise(input.params.lateDepositFeePerDay) : undefined,
          returnFilingDate: input.params.returnFilingDate ?? null,
        };
        return ok({ tdsExposure: computeTdsExposure(events, params) });
      }

      case "tds-threshold": {
        const keyOf = (section: string, pan: string) => (input.perDeducteeTracking ? `${section}|${pan}` : section);
        const carryOver: Record<string, { cumulative: number; threshold: number }> = {};
        for (const c of input.carryOver) {
          carryOver[keyOf(c.section, c.deducteePan)] = {
            cumulative: paise(c.cumulative),
            threshold: paise(c.threshold),
          };
        }
        const events: TdsPaymentEvent[] = input.events.map((e) => ({
          id: e.id,
          section: e.section,
          deducteePan: e.deducteePan,
          deducteeName: e.deducteeName,
          deducteeType: e.deducteeType,
          amount: paise(e.amount),
          dateOfPayment: e.dateOfPayment,
          dateOfCredit: e.dateOfCredit,
          isPaid: e.isPaid,
          hasPan: e.hasPan,
          isNonResident: e.isNonResident,
          ldcReference: e.ldcReference ?? null,
          form15G_15HReference: e.form15G_15HReference ?? null,
          natureOfPayment: e.natureOfPayment ?? null,
          voucherId: e.voucherId ?? null,
        }));
        const { outcomes, states } = processTdsPayments(events, input.perDeducteeTracking, carryOver);
        return ok({
          outcomes,
          states,
          summary: thresholdCrossingSummary(outcomes),
          rules: Array.from(new Set(events.map((e) => e.section))).map((section) => ({
            section,
            rule: lookupTimeOfDeductionRule(section) ?? null,
          })),
        });
      }

      case "tds-computation": {
        // Engine's own money unit is RUPEES (amount × rate%), so no conversion.
        return ok({ tds: computeTds(input) });
      }

      case "tax-audit": {
        // S.44AB turnover limitation is compared in RUPEES (₹100 crore = 1e9).
        return ok({ taxAudit: determineTaxAudit(input) });
      }

      case "internal-audit": {
        return ok({ internalAudit: computeInternalAudit(input.op) });
      }

      case "concurrent-audit": {
        return ok({ concurrentAudit: computeConcurrentAudit(input.op) });
      }

      case "stock-audit": {
        return ok({ stockAudit: computeStockAudit(input.op) });
      }

      case "form3cd": {
        // The envelope (data.general / data.observations) is not the engine's
        // Form3CdAuditData input (generalInfo + observations carrying
        // clauseNumber, clauseTitle, finding and comment). Wiring the engine
        // needs a contract decision, so the branch reports the gap instead of
        // casting a payload the engine cannot read.
        throw new ApiError(
          501,
          "FORM3CD_NOT_WIRED",
          "form3cd needs a payload carrying Form3CdAuditData: generalInfo plus observations with clauseNumber, clauseTitle, finding and comment.",
        );
      }

      case "roc-compliance": {
        return ok({ rocCompliance: input });
      }

      case "professional-tax": {
        return ok({ professionalTax: computeProfessionalTax(input) });
      }

      case "labour-law": {
        // The envelope carries employees/contributionPeriod/checkType; the
        // engine reads WagePayment[] (wage periods, gross/net wage, payment
        // mode, timeliness). The two do not describe each other, so the branch
        // reports the gap rather than casting a payload in.
        throw new ApiError(
          501,
          "LABOUR_LAW_NOT_WIRED",
          "labour-law needs a payload carrying WagePayment records (wagePeriodStart, wagePeriodEnd, wageDueDate, grossWage, deductions, netWage, paymentMode, isTimely).",
        );
      }

      case "msme-samadhaan": {
        // The envelope carries the Udyam thresholds (investment/turnover); the
        // engine's report reads supplier and invoice registers. The branch
        // reports the gap rather than casting a payload the engine cannot read.
        throw new ApiError(
          501,
          "MSME_SAMADHAAN_NOT_WIRED",
          "msme-samadhaan needs a payload carrying suppliers, invoices and referenceDate.",
        );
      }

      case "litigation": {
        if (input.op.op === "plan-appeal") {
          const m = input.op.matter;
          return ok({
            appealPlan: planAppeal({
              matterId: m.matterId,
              clientName: m.clientName,
              pan: m.pan,
              assessmentYear: m.assessmentYear,
              orderBy: m.orderBy,
              orderReference: m.orderReference,
              orderDate: m.orderDate,
              servedDate: m.servedDate,
              taxEffectMinor: paise(m.taxEffect),
              disputedTaxMinor: m.disputedTax === undefined ? undefined : paise(m.disputedTax),
              grounds: m.grounds,
              filingDate: m.filingDate,
            }),
          });
        }
        return ok({
          litigationPortfolio: litigationPortfolio(
            {
              matters: input.op.matters.map((m) => ({
                matterId: m.matterId,
                clientName: m.clientName,
                forum: m.forum,
                taxEffectMinor: paise(m.taxEffect),
                servedDate: m.servedDate,
                limitationDays: m.limitationDays,
                filingDate: m.filingDate,
                status: m.status,
              })),
            },
            input.op.dueSoonDays,
          ),
        });
      }

      case "timesheets": {
        if (input.op.op === "summarise") {
          return ok({
            timesheets: buildTimesheetSummary({
              entries: input.op.entries.map(timesheetEntryToEngine),
              budgets: input.op.budgets,
              targetUtilisationPct: input.op.targetUtilisationPct,
              asOfDate: input.op.asOfDate,
            }),
          });
        }
        const inv = input.op;
        return ok({
          invoice: buildTaxInvoice({
            invoiceNumber: inv.invoiceNumber,
            invoiceDate: inv.invoiceDate,
            supplierName: inv.supplierName,
            supplierGstin: inv.supplierGstin,
            supplierStateCode: inv.supplierStateCode,
            clientName: inv.clientName,
            clientGstin: inv.clientGstin ?? null,
            placeOfSupplyStateCode: inv.placeOfSupplyStateCode,
            entries: inv.entries.map(timesheetEntryToEngine),
            discountPct: inv.discountPct,
            gstRatePct: inv.gstRatePct,
            tdsSection: inv.tdsSection,
            tdsRatePct: inv.tdsRatePct,
            previouslyInvoicedMinor: inv.previouslyInvoiced === undefined ? undefined : paise(inv.previouslyInvoiced),
          }),
        });
      }

      case "documents": {
        if (input.op.op === "register") {
          return ok({
            documentRegister: buildDocumentRegister(input.op.documents.map(documentToEngine), {
              asOfDate: input.op.asOfDate,
              requiredCategories: input.op.requiredCategories,
              expiringSoonDays: input.op.expiringSoonDays,
            }),
          });
        }
        return ok({
          clientPortal: buildClientPortalView(input.op.client, input.op.documents.map(documentToEngine), {
            awaiting: input.op.awaiting,
          }),
        });
      }

      case "itr-u": {
        const result = buildUpdatedReturn({
          pan: input.pan,
          name: input.name,
          assessmentYear: input.assessmentYear,
          originalReturnFiledDate: input.originalReturnFiledDate,
          updatedReturnFilingDate: input.updatedReturnFilingDate,
          originalTotalIncomeMinor: paise(input.originalTotalIncome),
          updatedTotalIncomeMinor: paise(input.updatedTotalIncome),
          taxOnOriginalMinor: paise(input.taxOnOriginal),
          taxOnUpdatedMinor: paise(input.taxOnUpdated),
          interestOnUpdatedMinor: paise(input.interestOnUpdated),
          taxAlreadyPaidMinor: paise(input.taxAlreadyPaid),
          pendingProceedings: input.pendingProceedings,
          searchOrSurvey: input.searchOrSurvey,
          reducesReportedIncome: input.reducesReportedIncome,
          showsLoss: input.showsLoss,
          reasons: input.reasons,
        });
        return ok({ updatedReturn: result, validation: validateItrUPayload(result.payload) });
      }

      case "tds-ldc": {
        const declarationOf = (d: z.infer<typeof form15DeclarationInput>): Form15Declaration => ({
          ...d,
          estimatedTotalIncome: toPaiseOrNull(d.estimatedTotalIncome),
          estimatedTotalTax: toPaiseOrNull(d.estimatedTotalTax),
          amountLimit: toPaiseOrNull(d.amountLimit),
          specificSections: d.specificSections ?? null,
          declarationReference: d.declarationReference ?? null,
          documents: d.documents ?? null,
          notes: d.notes ?? null,
        });
        const certificateOf = (c: z.infer<typeof ldcCertificateInput>): LdcCertificate => ({
          ...c,
          lowerAmountLimit: toPaiseOrNull(c.lowerAmountLimit),
          conditions: c.conditions ?? null,
          remarks: c.remarks ?? null,
          issuedBy: c.issuedBy ?? null,
        });

        if (input.op === "validate-form15") {
          if (!input.declaration) {
            return toErrorResponse(
              new ApiError(400, "VALIDATION", "`declaration` is required when op is validate-form15."),
            );
          }
          return ok({ form15Validation: validateForm15Declaration(declarationOf(input.declaration)) });
        }

        if (!input.event) {
          return toErrorResponse(new ApiError(400, "VALIDATION", "`event` is required when op is cover."));
        }
        const cover = getTdsExemptionCover(
          {
            deducteePan: input.event.deducteePan,
            section: input.event.section,
            amount: paise(input.event.amount),
            dateOfPaymentOrCredit: input.event.dateOfPaymentOrCredit,
          },
          input.form15Declarations.map(declarationOf),
          input.ldcCertificates.map(certificateOf),
        );
        return ok({ cover });
      }

      case "tds-form16": {
        if (input.op === "16") {
          if (!input.salary) {
            return toErrorResponse(new ApiError(400, "VALIDATION", "`salary` is required when op is 16."));
          }
          const partA = generateForm16PartA(
            input.salaryEntries.map((e) => ({
              id: e.id,
              quarter: e.quarter,
              fy: e.fy,
              dateOfPayment: e.dateOfPayment,
              grossAmount: paise(e.grossAmount),
              tdsAmount: paise(e.tdsAmount),
              challanRef: e.challanRef ?? null,
              bsrCode: e.bsrCode ?? null,
              challanSerial: e.challanSerial ?? null,
              dateOfDeposit: e.dateOfDeposit ?? null,
              challanAmount: toPaiseOrNull(e.challanAmount),
              status: e.status,
            })),
            input.deductorName,
            input.deductorTan,
            input.fy,
          );
          const partB = generateForm16PartB(
            paiseRecord(input.salary),
            paiseRecord(input.chapterVIA ?? form16ChapterVIA.parse({})),
            input.otherIncome.map<Form16OtherIncome>((o) => ({
              source: o.source,
              amount: paise(o.amount),
              tdsDeducted: o.tdsDeducted,
              remarks: o.remarks ?? null,
            })),
            paise(input.tdsDeducted),
            paise(input.relief89),
            paise(input.relief90_91),
            paise(input.otherRelief),
          );
          const certificate = createForm16Certificate(
            input.deductorTan,
            input.deductorName,
            input.deducteePan,
            input.deducteeName,
            input.fy,
            input.assessmentYear,
            partA,
            partB,
          );
          return ok({
            partA,
            partB,
            certificate,
            validation: validateForm16Certificate({
              ...certificate,
              id: `F16-${input.deductorTan}-${input.deducteePan}-${input.fy}`,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }),
          });
        }

        const form16A = generateForm16A(
          input.nonSalaryEntries.map((e) => ({
            id: e.id,
            section: e.section,
            natureOfPayment: e.natureOfPayment,
            grossAmount: paise(e.grossAmount),
            tdsAmount: paise(e.tdsAmount),
            challanRef: e.challanRef ?? null,
            bsrCode: e.bsrCode ?? null,
            challanSerial: e.challanSerial ?? null,
            dateOfDeposit: e.dateOfDeposit ?? null,
            challanAmount: toPaiseOrNull(e.challanAmount),
            status: e.status,
          })),
          input.deductorName,
          input.deductorTan,
          input.deducteePan,
          input.deducteeName,
          input.fy,
        );
        const certificate = createForm16ACertificate(
          input.deductorTan,
          input.deductorName,
          input.deducteePan,
          input.deducteeName,
          input.fy,
          input.assessmentYear,
          form16A,
        );
        return ok({
          form16A,
          certificate,
          validation: validateForm16Certificate({
            ...certificate,
            id: `F16A-${input.deductorTan}-${input.deducteePan}-${input.fy}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        });
      }

      case "itr-schedules": {
        const convertBlock = (b: ItrScheduleBlockInput): ScheduleBlock => ({
          header: b.header,
          serial: b.serial,
          lines: b.lines.map((l) => ({ label: l.label, amount: paise(l.amount), col: l.col, notes: l.notes })),
          sub: b.sub ? Object.fromEntries(Object.entries(b.sub).map(([k, v]) => [k, convertBlock(v)])) : undefined,
          totalLabel: b.totalLabel,
          notes: b.notes,
        });
        const payload = buildITRSchedulePayload({
          formType: input.formType,
          assessmentYear: input.assessmentYear,
          general: input.general,
          schedules: Object.fromEntries(Object.entries(input.schedules).map(([k, v]) => [k, convertBlock(v)])),
          income: paiseRecord(input.income),
          tax: paiseRecord(input.tax),
        });
        const validation =
          input.formType === "ITR-5"
            ? validateITR5Payload(payload)
            : input.formType === "ITR-6"
              ? validateITR6Payload(payload)
              : input.formType === "ITR-3"
                ? validateITR3Payload(payload)
                : null;
        return ok({ itrSchedules: { json: payload.toJson(), xml: payload.toXml(), validation } });
      }

      default:
        // Unreachable once `body` validates, but it guarantees POST always
        // returns a Response (otherwise TS widens the return to `| undefined`).
        return toErrorResponse(new Error("Unsupported computation kind."));
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
