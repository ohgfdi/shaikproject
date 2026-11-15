/**
 * TDS Practice Module — CA India TDS/TCS engine.
 *
 * This module aggregates all TDS sub-modules:
 *   - tds-sections.ts — Section applicability matrix (194A, 194C, 194H, 194I,
 *     194J, 194Q, 194R, 194S, 194-IA, 194-IB, 194-IR, 206C, 206C(1H),
 *     206C(1G), 206C(1F), etc.)
 *   - tds-threshold-engine.ts — Threshold tracking and time-of-deduction rules
 *     (aggregate thresholds, earlier-of-payment-or-credit, early-deduction
 *     logic)
 *   - tds-challan-engine.ts — Challan mapping, bank reconciliation, challan
 *     splitting, untagged challan handling
 *   - tds-ldc-form15g.ts — Lower Deduction Certificate (LDC) u/s 197 and Form
 *     15G/15H capture and tracking
 *   - tds-penalty-exposure.ts — Section 201, 201(1A), 206C, 234E, 271Q
 *     penalty and interest computation
 *   - tds-form16-generator.ts — Form 16/16A generation with annexures
 *   - tds-cross-border.ts — Non-resident TDS, DTAA treaty rates, FCTRS
 *
 * SCOPE AND HONESTY — same contract as all the CA engines: this is arithmetic
 * on caller-supplied data and reference data surfaced for verification. It does
 * not fetch live law, does not file returns, and does not issue a legal opinion.
 * Finance Act amendments, CBDT notifications, and treaty interpretations are the
 * caller's to own by supplying updated data.
 *
 * All amounts are in MINOR UNITS (paise) as integers.
 */

// Section matrix
export { TDS_SECTIONS } from "./tds-sections";
export type {
  TdsSectionDefinition,
  lookupSection,
  sectionsForForm,
  tcsSections,
  tdsSections,
  sectionsAllowingForm15G_15H,
  sectionsAllowingLdc,
  crossBorderSections,
} from "./tds-sections";

// Threshold tracking and time-of-deduction
export {
  TDS_TIME_OF_DEDUCTION_RULES,
  effectiveDeductibleDate,
  evaluateTdsThreshold,
  isForm15G_15HSection,
  processTdsPayments,
  getThresholdForSection,
  getThresholdTypeForSection,
  computeTdsAmount,
  getRateForSection,
  buildThresholdStates,
  thresholdCrossingSummary,
  lookupTimeOfDeductionRule,
} from "./tds-threshold-engine";
export type { TdsPaymentEvent, TdsThresholdOutcome, ThresholdState, TimeOfDeductionRule } from "./tds-threshold-engine";

// Challan mapping and bank reconciliation
export {
  isValidBsrCode,
  isValidChallanSerial,
  verifyChallan,
  mapChallansToDeductions,
  reconcileChallans,
  challanCoverageSummary,
  outstandingDeductions,
  underutilizedChallans,
  challanUtilizationBySection,
} from "./tds-challan-engine";
export type {
  TdsChallanReceipt,
  TdsDeductionEvent,
  ChallanDeductionMapping,
  BankReconciliationEntry,
  ChallanVerification,
} from "./tds-challan-engine";

// LDC and Form 15G/15H
export {
  isLdcCertificateValid,
  ldcCoversSection,
  findActiveLdc,
  expiringLdCs,
  isForm15Valid,
  validateForm15Type,
  form15CoversSection,
  findActiveForm15,
  expiringForm15s,
  validateForm15Declaration,
  getTdsExemptionCover,
  generateRenewalReminders,
} from "./tds-ldc-form15g";
export type {
  LdcApplication,
  LdcCertificate,
  LdcApplicationStatus,
  LdcCertificateStatus,
  Form15Declaration,
  Form15Type,
  Form15Status,
} from "./tds-ldc-form15g";

// Penalty exposure and interest
export {
  monthsOrPartBetween,
  depositDueDate,
  returnFilingDueDate,
  computeTdsExposure,
  generateExposureWorkingPaper,
} from "./tds-penalty-exposure";
export type {
  ExposureReason,
  TdsExposureItem,
  TdsExposureParams,
  TdsExposureEvent,
  TdsExposureResult,
} from "./tds-penalty-exposure";

// Form 16/16A generation
export {
  generateForm16PartA,
  quarterDateRange,
  generateForm16PartB,
  computeOldRegimeTax,
  generateForm16A,
  createForm16Certificate,
  createForm16ACertificate,
  validateForm16Certificate,
  certificateSummaryForDeductee,
} from "./tds-form16-generator";
export type {
  Form16Type,
  CertificateStatus,
  Form16QuarterBreakdown,
  Form16SalaryAnnexure,
  Form16ChapterVIAAnnexure,
  Form16OtherIncome,
  Form16TaxComputation,
  TdsCertificate,
  Form16PartA,
  Form16PartB,
  Form16ACertificateData,
} from "./tds-form16-generator";

// Cross-border / non-resident TDS
export {
  getDomesticRate,
  getTreatyRate,
  computeNonResidentTds,
  isSubjectToTds195,
  crossBorderTdsComplianceChecklist,
  generateFctxSummary,
} from "./tds-cross-border";
export type {
  DTAAcountry,
  DTaaRoyaltyRate,
  DTaaFTSRate,
  DTaaInterestRate,
  DTaaCapitalGainsRate,
  DTaaRateRegistry,
  NonResidentIncomeType,
  ResidentStatus,
  NonResidentPaymentEvent,
} from "./tds-cross-border";

// Re-export India tax utilities
export { INR } from "./india-tax";
