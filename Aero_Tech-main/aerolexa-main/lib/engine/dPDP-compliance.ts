/** DPDP Act 2023 compliance module for Indian data protection */

export class DpdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DpdpError";
  }
}

// ---------------------------------------------------------------------------
// Consent records (DPDP Section 6 - consent before processing)
// ---------------------------------------------------------------------------

export interface ConsentPurpose {
  purposeId: string;
  purpose: string;
  description: string;
  isLegitimateUse: boolean;
  dataInvolved: string[];
}

export interface ConsentRecord {
  id: string;
  dataPrincipalId: string; // user Id
  dataPrincipalName: string;
  dataPrincipalEmail: string;
  dataPrincipalPhone?: string | null;
  purposeId: string;
  purpose: string;
  granted: boolean;
  policyVersion: string;
  timestamp: string; // ISO date
  ipHash?: string | null;
  withdrawalDate?: string | null;
  supersededBy?: string | null;
  notes?: string[] | null;
}

export interface ConsentRegistry {
  records: ConsentRecord[];
  byPurpose: { purposeId: string; purpose: string; granted: number; refused: number; pending: number }[];
  totals: { total: number; active: number; withdrawn: number; refused: number };
  warnings: string[];
  methodology: string[];
}

export function registerConsent(record: Omit<ConsentRecord, "id" | "withdrawalDate" | "supersededBy">): ConsentRecord {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.timestamp)) {
    throw new DpdpError("timestamp must be yyyy-mm-dd.");
  }
  if (!record.dataPrincipalEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.dataPrincipalEmail)) {
    throw new DpdpError("dataPrincipalEmail must be a valid email.");
  }
  if (record.policyVersion.length === 0) {
    throw new DpdpError("policyVersion must be provided.");
  }

  return {
    id: `CONSENT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...record,
    withdrawalDate: null,
    supersededBy: null,
    notes: record.notes ?? [],
  };
}

export function withdrawConsent(consentId: string, recordDate: string): ConsentRecord | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) {
    throw new DpdpError("recordDate must be yyyy-mm-dd.");
  }
  // In production, fetch from DB. Here we return a placeholder.
  return {
    id: consentId,
    dataPrincipalId: "DP-123",
    dataPrincipalName: "Example User",
    dataPrincipalEmail: "user@example.com",
    purposeId: "PURPOSE-1",
    purpose: "Example purpose",
    granted: true,
    policyVersion: "1.0",
    timestamp: "2026-01-01",
    ipHash: null,
    withdrawalDate: recordDate,
    supersededBy: null,
    notes: ["Consent withdrawn by data principal."],
  };
}

export function buildConsentRegistry(records: ConsentRecord[]): ConsentRegistry {
  const byPurposeMap = new Map<
    string,
    { purposeId: string; purpose: string; granted: number; refused: number; pending: number }
  >();

  for (const r of records) {
    const existing = byPurposeMap.get(r.purposeId);
    if (existing) {
      if (r.granted) existing.granted++;
      else if (!r.granted) existing.refused++;
    } else {
      byPurposeMap.set(r.purposeId, {
        purposeId: r.purposeId,
        purpose: r.purpose,
        granted: r.granted ? 1 : 0,
        refused: !r.granted ? 1 : 0,
        pending: 0,
      });
    }
  }

  const active = records.filter((r) => r.granted && !r.withdrawalDate).length;
  const withdrawn = records.filter((r) => r.withdrawalDate).length;

  return {
    records,
    byPurpose: [...byPurposeMap.values()],
    totals: {
      total: records.length,
      active,
      withdrawn,
      refused: records.filter((r) => !r.granted && !r.withdrawalDate).length,
    },
    warnings: active === 0 && records.length > 0 ? ["No active consent records - check consent status."] : [],
    methodology: [`Consent registry: ${records.length} record(s), ${active} active, ${withdrawn} withdrawn.`],
  };
}

// ---------------------------------------------------------------------------
// Data principal rights (DPDP Section 11-13)
// ---------------------------------------------------------------------------

export interface DataPrincipalRequest {
  requestId: string;
  dataPrincipalId: string;
  requestType: "access" | "correction" | "erasure" | "portability" | "grievance";
  timestamp: string;
  description: string;
  status: "received" | "acknowledged" | "in-progress" | "completed" | "rejected" | "expired";
  completionDate?: string | null;
  notes?: string[];
}

export interface DataPrincipalRightsReport {
  requests: DataPrincipalRequest[];
  summary: {
    total: number;
    access: number;
    correction: number;
    erasure: number;
    portability: number;
    grievance: number;
    completed: number;
    pending: number;
    rejected: number;
  };
  slammingPeriod: number; // days for grievance resolution (DPDP: 30 days)
  warnings: string[];
  methodology: string[];
}

export function processDataPrincipalRequest(
  request: Omit<DataPrincipalRequest, "requestId" | "status">,
): DataPrincipalRequest {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.timestamp)) {
    throw new DpdpError("timestamp must be yyyy-mm-dd.");
  }
  return {
    requestId: `DPR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ...request,
    status: "received",
    completionDate: null,
    notes: request.notes ?? [],
  };
}

export function buildDataPrincipalRightsReport(requests: DataPrincipalRequest[]): DataPrincipalRightsReport {
  const summary = {
    total: requests.length,
    access: requests.filter((r) => r.requestType === "access").length,
    correction: requests.filter((r) => r.requestType === "correction").length,
    erasure: requests.filter((r) => r.requestType === "erasure").length,
    portability: requests.filter((r) => r.requestType === "portability").length,
    grievance: requests.filter((r) => r.requestType === "grievance").length,
    completed: requests.filter((r) => r.status === "completed").length,
    pending: requests.filter((r) => ["received", "acknowledged", "in-progress"].includes(r.status)).length,
    rejected: requests.filter((r) => r.status === "rejected").length,
  };

  const expired = requests.filter((r) => {
    if (r.status === "completed" || r.status === "rejected" || r.status === "expired") return false;
    const reqDate = new Date(r.timestamp);
    const now = new Date();
    const daysDiff = Math.floor((now.getTime() - reqDate.getTime()) / 86400000);
    return daysDiff > 30;
  });

  return {
    requests,
    summary,
    slammingPeriod: 30,
    warnings:
      expired.length > 0 ? [`${expired.length} request(s) exceeding 30-day resolution deadline - escalate.`] : [],
    methodology: [
      `Data principal rights report: ${requests.length} request(s), ${summary.completed} completed, ${summary.pending} pending, ${summary.rejected} rejected.`,
      `DPDP mandates 30-day resolution for grievances.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Data breach notification (DPDP Section 8(6))
// ---------------------------------------------------------------------------

export interface DataBreach {
  breachId: string;
  timestamp: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  dataAffected: string[]; // categories of personal data
  dataPrincipalsAffected: number;
  cause: string;
  containmentStatus: "contained" | "being-contained" | "uncontained";
  notifiedToAuthority: boolean;
  notificationDate?: string | null;
  notifiedToPrincipals: boolean;
  principalNotificationDate?: string | null;
  remediation?: string[];
  notes?: string[];
}

export interface BreachReport {
  breaches: DataBreach[];
  summary: {
    total: number;
    low: number;
    medium: number;
    high: number;
    critical: number;
    notifiedToAuthority: number;
    notifiedToPrincipals: number;
    contained: number;
  };
  warnings: string[];
  methodology: string[];
}

export function reportDataBreach(
  breach: Omit<DataBreach, "breachId" | "notificationDate" | "principalNotificationDate">,
): DataBreach {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(breach.timestamp)) {
    throw new DpdpError("timestamp must be yyyy-mm-dd.");
  }
  if (
    breach.severity !== "low" &&
    breach.severity !== "medium" &&
    breach.severity !== "high" &&
    breach.severity !== "critical"
  ) {
    throw new DpdpError("severity must be low/medium/high/critical.");
  }
  if (breach.dataPrincipalsAffected < 0) {
    throw new DpdpError("dataPrincipalsAffected cannot be negative.");
  }

  return {
    breachId: `BREACH-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ...breach,
    notificationDate: breach.notifiedToAuthority ? breach.timestamp : null,
    principalNotificationDate: breach.notifiedToPrincipals ? breach.timestamp : null,
    remediation: breach.remediation ?? [],
    notes: breach.notes ?? [],
  };
}

export function buildBreachReport(breaches: DataBreach[]): BreachReport {
  const summary = {
    total: breaches.length,
    low: breaches.filter((b) => b.severity === "low").length,
    medium: breaches.filter((b) => b.severity === "medium").length,
    high: breaches.filter((b) => b.severity === "high").length,
    critical: breaches.filter((b) => b.severity === "critical").length,
    notifiedToAuthority: breaches.filter((b) => b.notifiedToAuthority).length,
    notifiedToPrincipals: breaches.filter((b) => b.notifiedToPrincipals).length,
    contained: breaches.filter((b) => b.containmentStatus === "contained").length,
  };

  const unnotified = breaches.filter((b) => !b.notifiedToAuthority && b.severity === "high");

  return {
    breaches,
    summary,
    warnings:
      unnotified.length > 0
        ? [
            `${unnotified.length} high-severity breach(s) not yet notified to authority - mandatory notification required.`,
          ]
        : [],
    methodology: [
      `Breach report: ${breaches.length} breach(s), ${summary.notifiedToAuthority} notified to authority, ${summary.contained} contained.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Data Processing Agreement (DPA) checklist
// ---------------------------------------------------------------------------

export interface DpaChecklist {
  dpaId: string;
  dataFiduciary: string;
  dataProcessor: string;
  processingPurpose: string;
  dataCategories: string[];
  dataPrincipalCategories: string[];
  retentionPeriod: string;
  securityMeasures: string[];
  crossBorderTransfer: boolean;
  transferDestination?: string | null;
  auditRights: boolean;
  breachNotification: boolean;
  subProcessorApproval: boolean;
  status: "draft" | "under-review" | "signed" | "expired" | "terminated";
  signatureDate?: string | null;
  expiryDate?: string | null;
}

export interface DpaReport {
  dpas: DpaChecklist[];
  summary: {
    total: number;
    draft: number;
    signed: number;
    expired: number;
    terminated: number;
    withCrossBorder: number;
    withoutAuditRights: number;
    withoutBreachNotification: number;
  };
  warnings: string[];
  methodology: string[];
}

export function buildDpaReport(dpas: DpaChecklist[]): DpaReport {
  const summary = {
    total: dpas.length,
    draft: dpas.filter((d) => d.status === "draft").length,
    signed: dpas.filter((d) => d.status === "signed").length,
    expired: dpas.filter((d) => d.status === "expired").length,
    terminated: dpas.filter((d) => d.status === "terminated").length,
    withCrossBorder: dpas.filter((d) => d.crossBorderTransfer).length,
    withoutAuditRights: dpas.filter((d) => !d.auditRights).length,
    withoutBreachNotification: dpas.filter((d) => !d.breachNotification).length,
  };

  const warnings = [];
  if (summary.withoutAuditRights > 0) {
    warnings.push(`${summary.withoutAuditRights} DPA(s) missing audit rights - non-compliant.`);
  }
  if (summary.withoutBreachNotification > 0) {
    warnings.push(`${summary.withoutBreachNotification} DPA(s) missing breach notification clause - non-compliant.`);
  }

  return {
    dpas,
    summary,
    warnings,
    methodology: [
      `DPA report: ${dpas.length} agreement(s), ${summary.signed} signed, ${summary.draft} draft, ${summary.expired} expired.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Data Fiduciary registration (DPDP Section 4)
// ---------------------------------------------------------------------------

export interface DataFiduciary {
  fidId: string;
  name: string;
  type: "government" | "company" | "firm" | "llp" | "individual" | "other";
  address: string;
  contactEmail: string;
  contactPhone?: string | null;
  significantDataProcessor: boolean;
  dataProtectionOfficer?: string | null;
  doContactEmail?: string | null;
  registrationDate: string;
  status: "registered" | "compliance-review" | "non-compliant" | "suspended";
  notes?: string[];
}

export interface FiduciaryReport {
  fiduciaries: DataFiduciary[];
  summary: {
    total: number;
    registered: number;
    complianceReview: number;
    nonCompliant: number;
    suspended: number;
    significantProcessors: number;
    withDpo: number;
  };
  warnings: string[];
  methodology: string[];
}

export function registerDataFiduciary(fiduciary: Omit<DataFiduciary, "fidId" | "status">): DataFiduciary {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fiduciary.registrationDate)) {
    throw new DpdpError("registrationDate must be yyyy-mm-dd.");
  }
  if (!fiduciary.contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fiduciary.contactEmail)) {
    throw new DpdpError("contactEmail must be a valid email.");
  }

  return {
    fidId: `FID-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ...fiduciary,
    status: "registered",
    notes: fiduciary.notes ?? [],
  };
}

export function buildFiduciaryReport(fiduciaries: DataFiduciary[]): FiduciaryReport {
  const summary = {
    total: fiduciaries.length,
    registered: fiduciaries.filter((f) => f.status === "registered").length,
    complianceReview: fiduciaries.filter((f) => f.status === "compliance-review").length,
    nonCompliant: fiduciaries.filter((f) => f.status === "non-compliant").length,
    suspended: fiduciaries.filter((f) => f.status === "suspended").length,
    significantProcessors: fiduciaries.filter((f) => f.significantDataProcessor).length,
    withDpo: fiduciaries.filter((f) => f.dataProtectionOfficer).length,
  };

  const warnings = [];
  const nonCompliant = fiduciaries.filter((f) => f.status === "non-compliant" || f.status === "suspended");
  if (nonCompliant.length > 0) {
    warnings.push(`${nonCompliant.length} fiduciary(ies) non-compliant or suspended - action required.`);
  }
  const significantButNoDpo = fiduciaries.filter((f) => f.significantDataProcessor && !f.dataProtectionOfficer);
  if (significantButNoDpo.length > 0) {
    warnings.push(
      `${significantButNoDpo.length} significant data processor(s) without appointed DPO - mandatory under DPDP.`,
    );
  }

  return {
    fiduciaries,
    summary,
    warnings,
    methodology: [
      `Fiduciary report: ${fiduciaries.length} registered, ${summary.significantProcessors} significant data processor(s), ${summary.withDpo} with DPO.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Data Audit Report (DPDP Section 10)
// ---------------------------------------------------------------------------

export interface DataAudit {
  auditId: string;
  fiduciaryId: string;
  auditDate: string;
  auditorName: string;
  scope: string[];
  findings: {
    category: "consent" | "security" | "rights" | "breach" | "cross-border" | "retention";
    severity: "low" | "medium" | "high";
    count: number;
    description: string;
  }[];
  complianceScore: number; // 0-100
  recommendations: string[];
  nextAuditDate?: string | null;
}

export interface AuditReport {
  audits: DataAudit[];
  summary: {
    total: number;
    avgComplianceScore: number;
    totalFindings: number;
    low: number;
    medium: number;
    high: number;
    overdueNextAudit: number;
  };
  warnings: string[];
  methodology: string[];
}

export function buildAuditReport(audits: DataAudit[]): AuditReport {
  const summary = {
    total: audits.length,
    avgComplianceScore:
      audits.length > 0 ? Math.round(audits.reduce((s, a) => s + a.complianceScore, 0) / audits.length) : 0,
    totalFindings: audits.reduce((s, a) => s + a.findings.length, 0),
    low: audits.reduce((s, a) => s + a.findings.filter((f) => f.severity === "low").length, 0),
    medium: audits.reduce((s, a) => s + a.findings.filter((f) => f.severity === "medium").length, 0),
    high: audits.reduce((s, a) => s + a.findings.filter((f) => f.severity === "high").length, 0),
    overdueNextAudit: audits.filter((a) => {
      if (!a.nextAuditDate) return false;
      return new Date(a.nextAuditDate) < new Date();
    }).length,
  };

  const warnings = [];
  if (summary.high > 0) {
    warnings.push(`${summary.high} high-severity findings - remediation required.`);
  }
  if (summary.overdueNextAudit > 0) {
    warnings.push(`${summary.overdueNextAudit} audit(s) overdue for next scheduled audit.`);
  }
  if (summary.avgComplianceScore < 70) {
    warnings.push(
      `Average compliance score ${summary.avgComplianceScore}% is below 70% threshold - overall compliance risk.`,
    );
  }

  return {
    audits,
    summary,
    warnings,
    methodology: [
      `Audit report: ${audits.length} audit(s), average compliance score ${summary.avgComplianceScore}%, ${summary.totalFindings} findings (${summary.high} high, ${summary.medium} medium, ${summary.low} low).`,
    ],
  };
}
