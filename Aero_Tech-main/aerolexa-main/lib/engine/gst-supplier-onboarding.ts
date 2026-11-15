/**
 * Supplier Onboarding & GSTIN Validation Workflow with Continuous Monitoring
 *
 * Handles:
 * - Supplier KYC onboarding (GSTIN, PAN, address, bank, contacts)
 * - Real-time GSTIN validation via GST portal / GSP
 * - Continuous monitoring: status changes, cancellation, composition opt-in/out
 * - Compliance scoring based on filing history, 2B appearance, mismatch rates
 * - Risk alerts: non-filer, cancelled GSTIN, composition mismatch, 17(5) triggers
 * - Vendor portal integration for self-service updates
 */

import { isValidGstin } from "./india-tax";

export class SupplierOnboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierOnboardingError";
  }
}

// ---------------------------------------------------------------------------
// Supplier Master Data
// ---------------------------------------------------------------------------

export type SupplierStatus = "active" | "inactive" | "blocked" | "pending-verification" | "suspended" | "cancelled";
export type SupplierCategory =
  "goods" | "services" | "capital-goods" | "job-work" | "transport" | "professional" | "other";
export type ComplianceRating = "A" | "B" | "C" | "D" | "unrated";

export interface SupplierMaster {
  id: string;
  entityId: string; // Our entity's ID
  bookId?: string;
  // Core identification
  gstin: string;
  pan: string;
  legalName: string;
  tradeName?: string;
  // Address
  address: {
    buildingNo: string;
    street: string;
    city: string;
    district: string;
    state: string;
    stateCode: string;
    pincode: number;
  };
  // Registration details
  registrationType:
    "regular" | "composition" | "tcs-collector" | "tds-deductor" | "non-resident" | "casual" | "isd" | "unknown";
  constitution: "proprietorship" | "partnership" | "company" | "llp" | "huf" | "trust" | "government" | "other";
  registrationDate: string;
  cancellationDate?: string;
  // Business
  category: SupplierCategory;
  primaryHsnSac: string;
  businessDescription?: string;
  // Banking
  bankAccounts: Array<{
    accountNumber: string;
    ifsc: string;
    bankName: string;
    branch: string;
    isPrimary: boolean;
    verified: boolean;
  }>;
  // Contacts
  contacts: Array<{
    name: string;
    designation: string;
    email: string;
    phone: string;
    isPrimary: boolean;
  }>;
  // Authorized signatories
  authorizedSignatories: Array<{
    name: string;
    designation: string;
    pan: string;
    din?: string;
    email: string;
    phone: string;
  }>;
  // Compliance
  status: SupplierStatus;
  complianceRating: ComplianceRating;
  riskScore: number; // 0-100
  lastValidatedAt: string;
  lastFilingStatus?: {
    gstr1: { period: string; status: "filed" | "not-filed" | "late"; filedAt?: string }[];
    gstr3b: { period: string; status: "filed" | "not-filed" | "late"; filedAt?: string }[];
  };
  // Monitoring
  monitoringEnabled: boolean;
  monitoringFrequency: "daily" | "weekly" | "monthly";
  alerts: SupplierAlert[];
  // Metadata
  onboardedAt: string;
  onboardedBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface SupplierAlert {
  id: string;
  type: AlertType;
  severity: "info" | "warning" | "critical";
  message: string;
  detectedAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  metadata?: Record<string, unknown>;
}

export type AlertType =
  | "gstin-cancelled"
  | "gstin-suspended"
  | "gstr1-not-filed"
  | "gstr3b-not-filed"
  | "composition-opt-in"
  | "composition-opt-out"
  | "address-changed"
  | "core-field-changed"
  | "non-filer-3-months"
  | "non-filer-6-months"
  | "mismatch-rate-high"
  | "blocked-itc-trigger"
  | "rcm-liability"
  | "e-way-bill-penalty"
  | "demand-notice"
  | "audit-initiated"
  | "pan-gstin-mismatch";

// ---------------------------------------------------------------------------
// GSTIN Validation
// ---------------------------------------------------------------------------

export interface GstinValidationResult {
  gstin: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  details?: {
    legalName?: string;
    tradeName?: string;
    status?: string;
    registrationType?: string;
    stateCode?: string;
    registrationDate?: string;
    cancellationDate?: string;
    address?: Record<string, unknown>;
    natureOfBusiness?: string[];
  };
}

/**
 * Validate GSTIN format and optionally fetch details from GST portal/GSP.
 * This is the offline format validation — for live validation, use GSP API.
 */
export function validateGstinOffline(gstin: string): GstinValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isValidGstin(gstin)) {
    errors.push(
      "Invalid GSTIN format. Must be 15 characters: 2-digit state code + 10-char PAN + 1 entity code + 1 check digit + 1 check sum.",
    );
    return { gstin, valid: false, errors, warnings };
  }

  const stateCode = gstin.slice(0, 2);
  const pan = gstin.slice(2, 12);

  // Validate state code (01-38)
  const stateNum = parseInt(stateCode, 10);
  if (stateNum < 1 || stateNum > 38) {
    warnings.push(`State code ${stateCode} is outside standard range (01-38).`);
  }

  // Validate PAN format (5 letters, 4 digits, 1 letter)
  const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
  if (!panRegex.test(pan)) {
    errors.push(`PAN portion ${pan} of GSTIN is invalid.`);
  }

  // Check digit validation (simplified - actual algorithm is more complex)
  // For production, use the official GSTIN check digit algorithm

  return {
    gstin,
    valid: errors.length === 0,
    errors,
    warnings,
    details: { stateCode },
  };
}

/**
 * Simulate live GSTIN validation via GSP (to be implemented with actual GSP credentials).
 * This is the interface for integration with GST Suvidha Provider APIs.
 */
export async function validateGstinLive(
  gstin: string,
  _gspCredentials: { clientId: string; clientSecret: string; username: string; password: string },
): Promise<GstinValidationResult> {
  // This would call the actual GSP API
  // For now, return offline validation with a note
  const offline = validateGstinOffline(gstin);
  offline.warnings.push("Live GSP validation not configured — using offline format validation only.");
  return offline;
}

// ---------------------------------------------------------------------------
// Onboarding Workflow
// ---------------------------------------------------------------------------

export interface OnboardingStep {
  step: number;
  name: string;
  description: string;
  required: boolean;
  completed: boolean;
  completedAt?: string;
  data?: unknown;
}

export interface OnboardingWorkflow {
  supplierId: string;
  steps: OnboardingStep[];
  currentStep: number;
  status: "initiated" | "in-progress" | "pending-approval" | "completed" | "rejected";
  startedAt: string;
  completedAt?: string;
  approvedBy?: string;
  rejectedBy?: string;
  rejectionReason?: string;
}

export const ONBOARDING_STEPS: Omit<OnboardingStep, "completed" | "completedAt" | "data">[] = [
  {
    step: 1,
    name: "GSTIN Verification",
    description: "Validate GSTIN format and fetch registration details from GST portal",
    required: true,
  },
  { step: 2, name: "PAN Verification", description: "Verify PAN matches GSTIN and fetch PAN details", required: true },
  {
    step: 3,
    name: "Address Verification",
    description: "Validate principal place of business and additional places",
    required: true,
  },
  {
    step: 4,
    name: "Bank Account Verification",
    description: "Add and verify bank account details for payments",
    required: true,
  },
  {
    step: 5,
    name: "Contact & Signatory Details",
    description: "Capture authorized contacts and signatories",
    required: true,
  },
  {
    step: 6,
    name: "Business Classification",
    description: "Classify supplier category, HSN/SAC, nature of business",
    required: true,
  },
  {
    step: 7,
    name: "Compliance Baseline",
    description: "Fetch last 12 months filing history and set compliance rating",
    required: false,
  },
  {
    step: 8,
    name: "Risk Assessment",
    description: "Run initial risk scoring based on filing, 2B appearance, alerts",
    required: false,
  },
  {
    step: 9,
    name: "Approval & Activation",
    description: "Internal approval and activation for transactions",
    required: true,
  },
];

const SUPPLIER_JSON_FIELDS = [
  "address",
  "bankAccounts",
  "contacts",
  "authorizedSignatories",
  "lastFilingStatus",
  "alerts",
] as const;

/**
 * Convert a wire-format supplier (nested structures serialized as JSON strings,
 * as stored in the DB) into the typed engine shape.
 */
export function deserializeSupplier(wire: unknown): Partial<SupplierMaster> {
  if (wire == null || typeof wire !== "object") return {};
  const raw = wire as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  for (const key of SUPPLIER_JSON_FIELDS) {
    const value = out[key];
    if (typeof value === "string") {
      try {
        out[key] = JSON.parse(value);
      } catch {
        out[key] = undefined;
      }
    }
  }
  return out as Partial<SupplierMaster>;
}

export function initiateOnboarding(supplier: Partial<SupplierMaster>, _actorId: string): OnboardingWorkflow {
  const now = new Date().toISOString();
  return {
    supplierId: supplier.id ?? `temp-${Date.now()}`,
    steps: ONBOARDING_STEPS.map((s) => ({ ...s, completed: false })),
    currentStep: 1,
    status: "initiated",
    startedAt: now,
  };
}

export function completeOnboardingStep(
  workflow: OnboardingWorkflow,
  stepNumber: number,
  data: unknown,
  _actorId: string,
): OnboardingWorkflow {
  const stepIndex = workflow.steps.findIndex((s) => s.step === stepNumber);
  if (stepIndex === -1) {
    throw new SupplierOnboardingError(`Step ${stepNumber} not found in workflow.`);
  }

  const updated = { ...workflow };
  const existingStep = updated.steps[stepIndex];
  if (!existingStep) {
    throw new SupplierOnboardingError(`Step ${stepNumber} not found in workflow.`);
  }
  updated.steps[stepIndex] = { ...existingStep, completed: true, completedAt: new Date().toISOString(), data };
  updated.currentStep = Math.min(stepNumber + 1, ONBOARDING_STEPS.length);

  if (stepNumber === ONBOARDING_STEPS.length) {
    updated.status = "pending-approval";
  } else {
    updated.status = "in-progress";
  }

  return updated;
}

export function approveOnboarding(workflow: OnboardingWorkflow, actorId: string): OnboardingWorkflow {
  return {
    ...workflow,
    status: "completed",
    completedAt: new Date().toISOString(),
    approvedBy: actorId,
  };
}

export function rejectOnboarding(workflow: OnboardingWorkflow, actorId: string, reason: string): OnboardingWorkflow {
  return {
    ...workflow,
    status: "rejected",
    rejectedBy: actorId,
    rejectionReason: reason,
  };
}

// ---------------------------------------------------------------------------
// Continuous Monitoring Engine
// ---------------------------------------------------------------------------

export interface MonitoringCheckResult {
  supplierId: string;
  gstin: string;
  checkType: AlertType;
  timestamp: string;
  previousState?: unknown;
  currentState: unknown;
  alertGenerated: boolean;
  alert?: SupplierAlert;
}

export interface MonitoringConfig {
  enabled: boolean;
  frequency: "daily" | "weekly" | "monthly";
  checks: {
    gstinStatus: boolean;
    filingStatus: boolean;
    addressChange: boolean;
    coreFieldChange: boolean;
    mismatchRate: boolean;
    rcmLiability: boolean;
    demandNotices: boolean;
  };
  thresholds: {
    mismatchRatePct: number; // Alert if mismatch rate exceeds this
    nonFilerMonths: number; // Alert if not filed for N months
    riskScoreIncrement: number; // Increment risk score per alert
  };
}

export const DEFAULT_MONITORING_CONFIG: MonitoringConfig = {
  enabled: true,
  frequency: "daily",
  checks: {
    gstinStatus: true,
    filingStatus: true,
    addressChange: true,
    coreFieldChange: true,
    mismatchRate: true,
    rcmLiability: true,
    demandNotices: true,
  },
  thresholds: {
    mismatchRatePct: 10,
    nonFilerMonths: 3,
    riskScoreIncrement: 5,
  },
};

/**
 * Run continuous monitoring checks for a supplier.
 * In production, this would fetch live data from GST portal/GSP.
 */
export async function runMonitoringChecks(
  supplier: SupplierMaster,
  config: MonitoringConfig = DEFAULT_MONITORING_CONFIG,
): Promise<MonitoringCheckResult[]> {
  const results: MonitoringCheckResult[] = [];
  const now = new Date().toISOString();

  if (!config.enabled || !supplier.monitoringEnabled) {
    return results;
  }

  // Mock current state (in production, fetch from GSP/GST portal)
  const currentGstinStatus = supplier.status; // Would come from live API
  const currentRegistrationType = supplier.registrationType;

  // 1. GSTIN Status Check
  if (config.checks.gstinStatus) {
    if (currentGstinStatus === "cancelled" && supplier.status !== "cancelled") {
      const alert: SupplierAlert = {
        id: `alert-${Date.now()}`,
        type: "gstin-cancelled",
        severity: "critical",
        message: `Supplier GSTIN ${supplier.gstin} has been CANCELLED. ITC on future invoices will be blocked.`,
        detectedAt: now,
        metadata: { previousStatus: supplier.status, currentStatus: "cancelled" },
      };
      results.push({
        supplierId: supplier.id,
        gstin: supplier.gstin,
        checkType: "gstin-cancelled",
        timestamp: now,
        previousState: supplier.status,
        currentState: "cancelled",
        alertGenerated: true,
        alert,
      });
    } else if (currentGstinStatus === "suspended" && supplier.status !== "suspended") {
      const alert: SupplierAlert = {
        id: `alert-${Date.now()}`,
        type: "gstin-suspended",
        severity: "warning",
        message: `Supplier GSTIN ${supplier.gstin} has been SUSPENDED. Verify before transacting.`,
        detectedAt: now,
        metadata: { previousStatus: supplier.status, currentStatus: "suspended" },
      };
      results.push({
        supplierId: supplier.id,
        gstin: supplier.gstin,
        checkType: "gstin-suspended",
        timestamp: now,
        previousState: supplier.status,
        currentState: "suspended",
        alertGenerated: true,
        alert,
      });
    }
  }

  // 2. Filing Status Check (mock - would fetch from GSP)
  if (config.checks.filingStatus) {
    const lastGstr1Period = supplier.lastFilingStatus?.gstr1?.[0]?.period;
    const lastGstr3bPeriod = supplier.lastFilingStatus?.gstr3b?.[0]?.period;
    const currentPeriod = getCurrentPeriod();

    if (lastGstr1Period && monthsDiff(lastGstr1Period, currentPeriod) >= config.thresholds.nonFilerMonths) {
      const alert: SupplierAlert = {
        id: `alert-${Date.now()}`,
        type: "non-filer-3-months",
        severity: "critical",
        message: `Supplier ${supplier.gstin} has not filed GSTR-1 for ${monthsDiff(lastGstr1Period, currentPeriod)} months. ITC at risk under Rule 37.`,
        detectedAt: now,
        metadata: {
          lastFiledPeriod: lastGstr1Period,
          currentPeriod,
          monthsUnfiled: monthsDiff(lastGstr1Period, currentPeriod),
        },
      };
      results.push({
        supplierId: supplier.id,
        gstin: supplier.gstin,
        checkType: "non-filer-3-months",
        timestamp: now,
        previousState: lastGstr1Period,
        currentState: currentPeriod,
        alertGenerated: true,
        alert,
      });
    }

    if (lastGstr3bPeriod && monthsDiff(lastGstr3bPeriod, currentPeriod) >= config.thresholds.nonFilerMonths) {
      const alert: SupplierAlert = {
        id: `alert-${Date.now()}`,
        type: "gstr3b-not-filed",
        severity: "warning",
        message: `Supplier ${supplier.gstin} has not filed GSTR-3B for ${monthsDiff(lastGstr3bPeriod, currentPeriod)} months.`,
        detectedAt: now,
        metadata: {
          lastFiledPeriod: lastGstr3bPeriod,
          currentPeriod,
          monthsUnfiled: monthsDiff(lastGstr3bPeriod, currentPeriod),
        },
      };
      results.push({
        supplierId: supplier.id,
        gstin: supplier.gstin,
        checkType: "gstr3b-not-filed",
        timestamp: now,
        previousState: lastGstr3bPeriod,
        currentState: currentPeriod,
        alertGenerated: true,
        alert,
      });
    }
  }

  // 3. Composition Opt-in/Out Check
  if (config.checks.coreFieldChange) {
    if (currentRegistrationType === "composition" && supplier.registrationType !== "composition") {
      const alert: SupplierAlert = {
        id: `alert-${Date.now()}`,
        type: "composition-opt-in",
        severity: "warning",
        message: `Supplier ${supplier.gstin} has opted into COMPOSITION scheme. Cannot issue tax invoice / charge GST. B2B supplies may be affected.`,
        detectedAt: now,
        metadata: { previousType: supplier.registrationType, currentType: "composition" },
      };
      results.push({
        supplierId: supplier.id,
        gstin: supplier.gstin,
        checkType: "composition-opt-in",
        timestamp: now,
        previousState: supplier.registrationType,
        currentState: "composition",
        alertGenerated: true,
        alert,
      });
    } else if (currentRegistrationType !== "composition" && supplier.registrationType === "composition") {
      const alert: SupplierAlert = {
        id: `alert-${Date.now()}`,
        type: "composition-opt-out",
        severity: "info",
        message: `Supplier ${supplier.gstin} has opted OUT of composition scheme. Now regular taxpayer — can issue tax invoice.`,
        detectedAt: now,
        metadata: { previousType: "composition", currentType: currentRegistrationType },
      };
      results.push({
        supplierId: supplier.id,
        gstin: supplier.gstin,
        checkType: "composition-opt-out",
        timestamp: now,
        previousState: "composition",
        currentState: currentRegistrationType,
        alertGenerated: true,
        alert,
      });
    }
  }

  // 4. Address Change Check
  if (config.checks.addressChange) {
    // In production, compare with live data
    const addressChanged = false; // Mock
    if (addressChanged) {
      const alert: SupplierAlert = {
        id: `alert-${Date.now()}`,
        type: "address-changed",
        severity: "info",
        message: `Supplier ${supplier.gstin} has changed principal place of business. Update records for E-Way Bill / POS determination.`,
        detectedAt: now,
      };
      results.push({
        supplierId: supplier.id,
        gstin: supplier.gstin,
        checkType: "address-changed",
        timestamp: now,
        currentState: "changed",
        alertGenerated: true,
        alert,
      });
    }
  }

  // 5. Mismatch Rate Check (would use reconciliation data)
  if (config.checks.mismatchRate) {
    const mismatchRate = 0; // Mock - calculate from reconciliation
    if (mismatchRate > config.thresholds.mismatchRatePct) {
      const alert: SupplierAlert = {
        id: `alert-${Date.now()}`,
        type: "mismatch-rate-high",
        severity: "warning",
        message: `Supplier ${supplier.gstin} has ${mismatchRate}% mismatch rate in 2B reconciliation. High risk of ITC reversal.`,
        detectedAt: now,
        metadata: { mismatchRate },
      };
      results.push({
        supplierId: supplier.id,
        gstin: supplier.gstin,
        checkType: "mismatch-rate-high",
        timestamp: now,
        currentState: { mismatchRate },
        alertGenerated: true,
        alert,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Compliance Scoring
// ---------------------------------------------------------------------------

export interface ComplianceScore {
  supplierId: string;
  gstin: string;
  overallScore: number; // 0-100
  rating: ComplianceRating;
  components: {
    filingRegularity: number; // 0-25
    gstr2bAppearance: number; // 0-25
    mismatchRate: number; // 0-20
    paymentTimeliness: number; // 0-15
    disputeHistory: number; // 0-15
  };
  trend: "improving" | "stable" | "declining";
  lastCalculated: string;
  factors: string[];
}

/**
 * Calculate supplier compliance score based on multiple factors.
 */
export function calculateComplianceScore(
  supplier: SupplierMaster,
  reconciliationData: {
    gstr2bAppearanceRate: number; // 0-1
    mismatchRate: number; // 0-1
    avgPaymentDays: number;
    disputeCount: number;
  },
): ComplianceScore {
  const now = new Date().toISOString();
  const factors: string[] = [];

  // Filing regularity (25 pts)
  let filingScore = 25;
  const gstr1Filed = supplier.lastFilingStatus?.gstr1?.filter((f) => f.status === "filed").length ?? 0;
  const gstr3bFiled = supplier.lastFilingStatus?.gstr3b?.filter((f) => f.status === "filed").length ?? 0;
  const expectedFilings = 12; // Last 12 months
  const filingRate = (gstr1Filed + gstr3bFiled) / (expectedFilings * 2);
  filingScore = Math.round(25 * filingRate);
  if (filingScore < 15) factors.push(`Low filing regularity: ${filingRate * 100}%`);

  // GSTR-2B Appearance (25 pts)
  const appearanceScore = Math.round(25 * reconciliationData.gstr2bAppearanceRate);
  if (appearanceScore < 15)
    factors.push(`Low GSTR-2B appearance rate: ${reconciliationData.gstr2bAppearanceRate * 100}%`);

  // Mismatch Rate (20 pts) - inverse
  const mismatchScore = Math.round(20 * (1 - reconciliationData.mismatchRate));
  if (mismatchScore < 10) factors.push(`High mismatch rate: ${reconciliationData.mismatchRate * 100}%`);

  // Payment Timeliness (15 pts)
  let paymentScore = 15;
  if (reconciliationData.avgPaymentDays > 45) paymentScore = 5;
  else if (reconciliationData.avgPaymentDays > 30) paymentScore = 10;
  if (paymentScore < 10) factors.push(`Slow payment: ${reconciliationData.avgPaymentDays} days avg`);

  // Dispute History (15 pts)
  let disputeScore = 15;
  if (reconciliationData.disputeCount > 5) disputeScore = 0;
  else if (reconciliationData.disputeCount > 2) disputeScore = 5;
  else if (reconciliationData.disputeCount > 0) disputeScore = 10;
  if (disputeScore < 10) factors.push(`${reconciliationData.disputeCount} disputes in last 12 months`);

  const overallScore = filingScore + appearanceScore + mismatchScore + paymentScore + disputeScore;

  let rating: ComplianceRating = "D";
  if (overallScore >= 85) rating = "A";
  else if (overallScore >= 70) rating = "B";
  else if (overallScore >= 50) rating = "C";

  // Determine trend (simplified)
  let trend: ComplianceScore["trend"] = "stable";
  if (overallScore > supplier.riskScore) trend = "improving";
  else if (overallScore + 10 <= supplier.riskScore) trend = "declining";

  return {
    supplierId: supplier.id,
    gstin: supplier.gstin,
    overallScore,
    rating,
    components: {
      filingRegularity: filingScore,
      gstr2bAppearance: appearanceScore,
      mismatchRate: mismatchScore,
      paymentTimeliness: paymentScore,
      disputeHistory: disputeScore,
    },
    trend,
    lastCalculated: now,
    factors,
  };
}

// ---------------------------------------------------------------------------
// Risk Scoring & Alerting
// ---------------------------------------------------------------------------

export function calculateRiskScore(supplier: SupplierMaster, alerts: SupplierAlert[]): number {
  let score = 0;

  // Base score from compliance rating
  const ratingScores = { A: 0, B: 10, C: 30, D: 50, unrated: 40 };
  score += ratingScores[supplier.complianceRating];

  // Active alerts
  for (const alert of alerts) {
    if (!alert.resolvedAt) {
      switch (alert.severity) {
        case "critical":
          score += 20;
          break;
        case "warning":
          score += 10;
          break;
        case "info":
          score += 3;
          break;
      }
    }
  }

  // GSTIN status
  if (supplier.status === "cancelled") score += 50;
  else if (supplier.status === "suspended") score += 30;
  else if (supplier.status === "blocked") score += 40;

  // Registration type risk
  if (supplier.registrationType === "composition") score += 5; // Limited ITC

  // Non-filer history
  const currentPeriod = getCurrentPeriod();
  const lastGstr1 = supplier.lastFilingStatus?.gstr1?.[0]?.period;
  if (lastGstr1 && monthsDiff(lastGstr1, currentPeriod) >= 6) score += 20;

  return Math.min(100, score);
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function monthsDiff(fromPeriod: string, toPeriod: string): number {
  const [fy = 0, fm = 0] = fromPeriod.split("-").map(Number);
  const [ty = 0, tm = 0] = toPeriod.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

// ---------------------------------------------------------------------------
// Vendor Portal Integration (Data Model)
// ---------------------------------------------------------------------------

export interface VendorPortalInvite {
  id: string;
  supplierId: string;
  email: string;
  token: string;
  expiresAt: string;
  sentAt: string;
  acceptedAt?: string;
  status: "sent" | "accepted" | "expired" | "revoked";
}

export interface VendorPortalSubmission {
  supplierId: string;
  submittedBy: string; // email of vendor contact
  submittedAt: string;
  fieldsUpdated: string[];
  data: Partial<SupplierMaster>;
  status: "pending-review" | "approved" | "rejected";
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
}

const gstSupplierOnboardingEngine = {
  validateGstinOffline,
  validateGstinLive,
  initiateOnboarding,
  completeOnboardingStep,
  approveOnboarding,
  rejectOnboarding,
  runMonitoringChecks,
  calculateComplianceScore,
  calculateRiskScore,
  DEFAULT_MONITORING_CONFIG,
  ONBOARDING_STEPS,
  SupplierOnboardingError,
};

export default gstSupplierOnboardingEngine;
