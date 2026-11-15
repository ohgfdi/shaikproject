/**
 * Notice/Scrutiny Response Workflow Engine
 *
 * Tied to reconciliation artifacts from:
 * - GSTR-2B ITC reconciliation (gstr-2b-itc.ts)
 * - GSTR-1/3B reconciliation (gst-returns.ts)
 * - Supplier reconciliation (missing 2B invoices, 17(5) blocking, mismatches)
 *
 * Handles:
 * - ASMT-10 / ASMT-14 scrutiny notices
 * - DRC-01 / DRC-03 demand notices
 * - GST CMP-08 / CMP-09 composition scrutiny
 * - Anti-profiteering notices
 * - Audit notices (ADT-01, ADT-02)
 * - Response drafting with reconciliation evidence
 */

import { INR, formatInr } from "./india-tax";

export class NoticeWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoticeWorkflowError";
  }
}

// ---------------------------------------------------------------------------
// Notice Types & Categories
// ---------------------------------------------------------------------------

export type NoticeType =
  | "asmt-10" // Scrutiny of return (s 61)
  | "asmt-14" // Best judgment assessment (s 62)
  | "drc-01" // Demand notice (s 73/74)
  | "drc-03" // Voluntary payment intimation
  | "cmp-08" // Composition scrutiny
  | "cmp-09" // Composition denial
  | "adt-01" // Audit notice (s 65)
  | "adt-02" // Special audit (s 66)
  | "rfd-01" // Refund scrutiny
  | "reg-17" // Registration cancellation
  | "anti-profiteering" // Anti-profiteering notice
  | "e-way-bill" // E-way bill penalty
  | "gstr-2b-mismatch" // 2B mismatch notice
  | "gstr-1-3b-mismatch" // GSTR-1 vs 3B mismatch
  | "itc-reversal" // ITC reversal notice (Rule 37/42/43)
  | "other";

export type NoticeStatus =
  | "received"
  | "under-review"
  | "response-drafting"
  | "response-filed"
  | "personal-hearing"
  | "order-received"
  | "appeal-filed"
  | "closed"
  | "escalated";

export type AuthorityLevel =
  "proper-officer" | "jc" | "ac" | "dc" | "commissioner" | "aat" | "high-court" | "supreme-court";

export interface GstNotice {
  id: string;
  noticeNumber: string;
  noticeDate: string;
  noticeType: NoticeType;
  authorityLevel: AuthorityLevel;
  authorityName: string;
  authorityJurisdiction: string;
  gstin: string;
  entityName: string;
  period?: string; // yyyy-mm or yyyy-yy for FY
  financialYear?: string;
  subject: string;
  description: string;
  sections: string[]; // Legal sections invoked
  rules: string[]; // Rules invoked
  demandedAmount?: {
    tax: number;
    interest: number;
    penalty: number;
    total: number;
  };
  responseDueDate: string;
  status: NoticeStatus;
  assignedTo?: string;
  priority: "low" | "medium" | "high" | "critical";
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Reconciliation Artifact Linkage
// ---------------------------------------------------------------------------

export interface ReconciliationArtifact {
  type:
    "gstr-2b-recon" | "gstr-1-3b-recon" | "supplier-recon" | "rcm-recon" | "export-lut" | "e-way-bill" | "itc-reversal";
  period: string;
  entityId: string;
  bookId?: string;
  summary: {
    totalMismatches: number;
    totalTaxImpact: number;
    keyFindings: string[];
  };
  details: {
    invoices?: Array<{ invoiceNumber: string; gstin: string; issue: string; taxImpact: number }>;
    blockedItc?: Array<{ category: string; amount: number; section: string }>;
    missingInvoices?: Array<{ gstin: string; count: number; estimatedTax: number }>;
    rateMismatches?: Array<{ invoiceNumber: string; expectedRate: number; actualRate: number }>;
    quantityMismatches?: Array<{ invoiceNumber: string; expectedQty: number; actualQty: number }>;
    rcmLiability?: Array<{ category: string; taxableValue: number; tax: number }>;
    exportDetails?: Array<{ shippingBill: string; date: string; amount: number }>;
  };
  generatedAt: string;
  generatedBy: string;
}

/**
 * Link a notice to relevant reconciliation artifacts for evidence-backed response.
 */
export function linkNoticeToReconciliation(
  notice: GstNotice,
  artifacts: ReconciliationArtifact[],
): { linkedArtifacts: ReconciliationArtifact[]; evidenceSummary: string; gaps: string[] } {
  const linkedArtifacts: ReconciliationArtifact[] = [];
  const gaps: string[] = [];

  // Match artifacts by GSTIN and period
  for (const artifact of artifacts) {
    if (artifact.type === "gstr-2b-recon" && notice.noticeType === "itc-reversal") {
      linkedArtifacts.push(artifact);
    }
    if (
      artifact.type === "gstr-1-3b-recon" &&
      (notice.noticeType === "gstr-1-3b-mismatch" || notice.noticeType === "asmt-10")
    ) {
      linkedArtifacts.push(artifact);
    }
    if (
      artifact.type === "supplier-recon" &&
      (notice.noticeType === "gstr-2b-mismatch" || notice.noticeType === "itc-reversal")
    ) {
      linkedArtifacts.push(artifact);
    }
    if (artifact.type === "rcm-recon" && notice.noticeType === "drc-01") {
      linkedArtifacts.push(artifact);
    }
    if (artifact.type === "export-lut" && (notice.noticeType === "rfd-01" || notice.noticeType === "asmt-10")) {
      linkedArtifacts.push(artifact);
    }
    if (artifact.type === "e-way-bill" && notice.noticeType === "e-way-bill") {
      linkedArtifacts.push(artifact);
    }
  }

  // Check for gaps
  if (notice.noticeType === "itc-reversal" && !linkedArtifacts.some((a) => a.type === "gstr-2b-recon")) {
    gaps.push("No GSTR-2B reconciliation available for the notice period — ITC eligibility cannot be evidenced.");
  }
  if (notice.noticeType === "gstr-1-3b-mismatch" && !linkedArtifacts.some((a) => a.type === "gstr-1-3b-recon")) {
    gaps.push("No GSTR-1/3B reconciliation available — outward supply mismatch cannot be quantified.");
  }
  if (notice.demandedAmount && notice.demandedAmount.total > 0) {
    const totalEvidenceTax = linkedArtifacts.reduce((s, a) => s + a.summary.totalTaxImpact, 0);
    if (totalEvidenceTax < notice.demandedAmount.total * 0.8) {
      gaps.push(
        `Reconciliation evidence covers only ${formatInr(totalEvidenceTax)} of demanded ${formatInr(notice.demandedAmount.total)}.`,
      );
    }
  }

  const evidenceSummary =
    linkedArtifacts.length > 0
      ? `Linked ${linkedArtifacts.length} reconciliation artifact(s): ${linkedArtifacts.map((a) => a.type).join(", ")}. Total tax impact evidenced: ${formatInr(linkedArtifacts.reduce((s, a) => s + a.summary.totalTaxImpact, 0))}.`
      : "No reconciliation artifacts linked — response will be based on primary records only.";

  return { linkedArtifacts, evidenceSummary, gaps };
}

// ---------------------------------------------------------------------------
// Response Drafting
// ---------------------------------------------------------------------------

export interface NoticeResponse {
  id: string;
  noticeId: string;
  responseNumber: string;
  responseDate: string;
  responseType: "reply" | "clarification" | "payment" | "appeal" | "rectification" | "hearing-request";
  draftedBy: string;
  reviewedBy?: string;
  approvedBy?: string;
  status: "draft" | "reviewed" | "approved" | "filed" | "withdrawn";
  content: {
    facts: string;
    legalArguments: string[];
    evidenceReferences: string[];
    computations: Array<{
      head: string;
      demanded: number;
      admitted: number;
      disputed: number;
      basis: string;
    }>;
    prayers: string[];
  };
  attachments: Array<{
    name: string;
    type: "reconciliation" | "invoice" | "ledger" | "bank" | "contract" | "correspondence" | "other";
    ref: string;
  }>;
  filedDate?: string;
  filingMode: "portal" | "physical" | "email";
  acknowledgmentRef?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Generate a structured response draft based on notice type and linked reconciliation.
 */
export function generateResponseDraft(
  notice: GstNotice,
  linkedArtifacts: ReconciliationArtifact[],
  opts: {
    admitFully?: boolean;
    admitPartially?: { head: string; amount: number; reason: string }[];
    disputeFully?: boolean;
    additionalArguments?: string[];
  },
): NoticeResponse {
  const responseDate = new Date().toISOString().slice(0, 10);
  const responseNumber = `RESP-${notice.noticeNumber}-${Date.now()}`;

  const computations: NoticeResponse["content"]["computations"] = [];
  const legalArguments: string[] = [];
  const evidenceReferences: string[] = [];

  // Build computations from linked artifacts
  for (const artifact of linkedArtifacts) {
    if (artifact.type === "gstr-2b-recon") {
      for (const inv of artifact.details.invoices ?? []) {
        computations.push({
          head: `ITC on Invoice ${inv.invoiceNumber} (${inv.gstin})`,
          demanded: notice.demandedAmount?.tax ?? 0,
          admitted: 0,
          disputed: inv.taxImpact,
          basis: `GSTR-2B Reconciliation: ${inv.issue}`,
        });
        evidenceReferences.push(`GSTR-2B Recon ${artifact.period}: ${inv.invoiceNumber}`);
      }
      for (const blocked of artifact.details.blockedItc ?? []) {
        computations.push({
          head: `Blocked ITC — ${blocked.category}`,
          demanded: blocked.amount,
          admitted: 0,
          disputed: blocked.amount,
          basis: `s 17(5) / Rule 36(4): ${blocked.section}`,
        });
        legalArguments.push(`ITC on ${blocked.category} is blocked under ${blocked.section} — no credit availed.`);
        evidenceReferences.push(`GSTR-2B Recon ${artifact.period}: Blocked ITC ${blocked.category}`);
      }
    }

    if (artifact.type === "gstr-1-3b-recon") {
      computations.push({
        head: "GSTR-1 vs GSTR-3B Outward Supply Difference",
        demanded: notice.demandedAmount?.tax ?? 0,
        admitted: 0,
        disputed: artifact.summary.totalTaxImpact,
        basis: `Reconciliation difference: ${artifact.summary.keyFindings.join("; ")}`,
      });
      evidenceReferences.push(
        `GSTR-1/3B Recon ${artifact.period}: Tax difference ${formatInr(artifact.summary.totalTaxImpact)}`,
      );
    }

    if (artifact.type === "supplier-recon") {
      for (const missing of artifact.details.missingInvoices ?? []) {
        computations.push({
          head: `Missing 2B Invoices — Supplier ${missing.gstin}`,
          demanded: notice.demandedAmount?.tax ?? 0,
          admitted: 0,
          disputed: missing.estimatedTax,
          basis: `Supplier did not upload ${missing.count} invoice(s) in GSTR-1`,
        });
        legalArguments.push(
          `s 16(2)(aa): ITC not claimable on invoices not reflected in GSTR-2B. Supplier non-compliance not attributable to recipient.`,
        );
        evidenceReferences.push(`Supplier Recon ${artifact.period}: ${missing.gstin} - ${missing.count} invoices`);
      }
      for (const mismatch of artifact.details.rateMismatches ?? []) {
        computations.push({
          head: `Rate Mismatch — Invoice ${mismatch.invoiceNumber}`,
          demanded: 0,
          admitted: 0,
          disputed: 0,
          basis: `Rate mismatch: expected ${mismatch.expectedRate}%, actual ${mismatch.actualRate}%`,
        });
        evidenceReferences.push(`Supplier Recon ${artifact.period}: Rate mismatch ${mismatch.invoiceNumber}`);
      }
    }

    if (artifact.type === "rcm-recon") {
      for (const rcm of artifact.details.rcmLiability ?? []) {
        computations.push({
          head: `RCM Liability — ${rcm.category}`,
          demanded: rcm.tax,
          admitted: rcm.tax,
          disputed: 0,
          basis: `RCM under s 9(3) Notified supply: ${rcm.category}`,
        });
        legalArguments.push(`RCM tax paid under s 9(3) — eligible for ITC under Table 4(A)(3) after payment.`);
        evidenceReferences.push(`RCM Recon ${artifact.period}: ${rcm.category}`);
      }
    }
  }

  // Add additional arguments
  if (opts.additionalArguments) {
    legalArguments.push(...opts.additionalArguments);
  }

  // Standard legal arguments based on notice type
  switch (notice.noticeType) {
    case "itc-reversal":
      legalArguments.push(
        "ITC reversal under Rule 37/42/43 is not applicable where supplier non-filing is not attributable to recipient.",
      );
      legalArguments.push("Recipient has exercised due diligence: GSTIN verified, tax paid, invoices in possession.");
      break;
    case "asmt-10":
      legalArguments.push("Return filed is complete and correct based on books of account and reconciled data.");
      legalArguments.push("Any variance is due to rounding/timing differences within tolerance limits.");
      break;
    case "drc-01":
      legalArguments.push("Demand is time-barred under s 73(10) / s 74(10) — notice issued beyond limitation period.");
      legalArguments.push("Tax, if any, has been paid with interest — no penalty leviable under s 73(8) / s 74(8).");
      break;
    case "gstr-2b-mismatch":
      legalArguments.push("GSTR-2B is auto-drafted; recipient cannot control supplier's GSTR-1 filing.");
      legalArguments.push("ITC claimed based on valid tax invoices in possession — s 16(2)(a) satisfied.");
      break;
  }

  const prayers = [
    "Drop the proceedings / notice as the same is without jurisdiction / merit.",
    "In the alternative, allow the ITC claimed / rectify the return as per reconciliation.",
    "Grant opportunity of personal hearing before passing any adverse order.",
    "Any other relief as this Hon'ble Authority may deem fit.",
  ];

  if (opts.admitPartially) {
    for (const admit of opts.admitPartially) {
      prayers.unshift(`Admit liability of ${formatInr(admit.amount)} under ${admit.head} — ${admit.reason}.`);
    }
  }

  return {
    id: `resp-${Date.now()}`,
    noticeId: notice.id,
    responseNumber,
    responseDate,
    responseType: opts.admitFully ? "payment" : opts.admitPartially ? "clarification" : "reply",
    draftedBy: "system",
    status: "draft",
    content: {
      facts: `Notice ${notice.noticeNumber} dated ${notice.noticeDate} received for ${notice.subject}. Reconciliation for period ${notice.period} shows ${linkedArtifacts.length} supporting artifact(s).`,
      legalArguments,
      evidenceReferences,
      computations,
      prayers,
    },
    attachments: linkedArtifacts.map((a) => ({
      name: `${a.type}-${a.period}.pdf`,
      type: "reconciliation" as const,
      ref: a.type,
    })),
    filingMode: "portal",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Timeline & Compliance Tracking
// ---------------------------------------------------------------------------

export interface NoticeTimeline {
  noticeId: string;
  events: Array<{
    date: string;
    event: string;
    description: string;
    responsible: string;
    status: "completed" | "pending" | "overdue";
  }>;
  criticalDates: Array<{
    label: string;
    date: string;
    daysRemaining: number;
    isCritical: boolean;
  }>;
}

export function buildNoticeTimeline(notice: GstNotice, response?: NoticeResponse): NoticeTimeline {
  const now = new Date();
  const dueDate = new Date(`${notice.responseDueDate}T23:59:59`);
  const daysRemaining = Math.max(0, Math.ceil((dueDate.getTime() - now.getTime()) / 86400000));

  const events: NoticeTimeline["events"] = [
    {
      date: notice.noticeDate,
      event: "Notice Received",
      description: `Notice ${notice.noticeNumber} received`,
      responsible: "System",
      status: "completed" as const,
    },
  ];

  if (response) {
    events.push({
      date: response.responseDate,
      event: "Response Drafted",
      description: `Response ${response.responseNumber} drafted`,
      responsible: response.draftedBy,
      status: response.status === "filed" ? "completed" : ("pending" as const),
    });
    if (response.filedDate) {
      events.push({
        date: response.filedDate,
        event: "Response Filed",
        description: `Response filed via ${response.filingMode}`,
        responsible: response.draftedBy,
        status: "completed" as const,
      });
    }
  }

  const criticalDates = [
    { label: "Response Due Date", date: notice.responseDueDate, daysRemaining, isCritical: daysRemaining <= 7 },
    { label: "Personal Hearing (if scheduled)", date: "", daysRemaining: 0, isCritical: false },
    { label: "Limitation for Appeal", date: "", daysRemaining: 0, isCritical: false },
  ];

  return { noticeId: notice.id, events, criticalDates };
}

// ---------------------------------------------------------------------------
// Notice Dashboard / Worklist
// ---------------------------------------------------------------------------

export interface NoticeWorklistItem {
  notice: GstNotice;
  response?: NoticeResponse;
  timeline: NoticeTimeline;
  linkedArtifacts: ReconciliationArtifact[];
  evidenceSummary: string;
  gaps: string[];
  riskScore: number; // 0-100
  recommendedAction: string;
}

export function buildNoticeWorklist(
  notices: GstNotice[],
  artifacts: ReconciliationArtifact[],
  responses: Map<string, NoticeResponse>,
): NoticeWorklistItem[] {
  return notices
    .map((notice) => {
      const { linkedArtifacts, evidenceSummary, gaps } = linkNoticeToReconciliation(notice, artifacts);
      const response = responses.get(notice.id);
      const timeline = buildNoticeTimeline(notice, response);

      // Calculate risk score
      let riskScore = 50; // base
      if (notice.priority === "critical") riskScore += 30;
      else if (notice.priority === "high") riskScore += 20;
      else if (notice.priority === "medium") riskScore += 10;

      if (notice.demandedAmount && notice.demandedAmount.total > INR(100000)) riskScore += 15;
      if (notice.demandedAmount && notice.demandedAmount.total > INR(1000000)) riskScore += 10;
      if (daysUntilDue(notice.responseDueDate) <= 3) riskScore += 20;
      if (daysUntilDue(notice.responseDueDate) <= 0) riskScore += 30;
      if (gaps.length > 0) riskScore += gaps.length * 5;
      if (!response) riskScore += 15;

      riskScore = Math.min(100, Math.max(0, riskScore));

      let recommendedAction = "Review notice and prepare response";
      if (daysUntilDue(notice.responseDueDate) <= 0) recommendedAction = "OVERDUE: File response immediately";
      else if (daysUntilDue(notice.responseDueDate) <= 3) recommendedAction = "URGENT: Response due within 3 days";
      else if (gaps.length > 0) recommendedAction = `Address ${gaps.length} evidence gap(s) before responding`;
      else if (!response) recommendedAction = "Draft response using linked reconciliation artifacts";

      return { notice, response, timeline, linkedArtifacts, evidenceSummary, gaps, riskScore, recommendedAction };
    })
    .sort((a, b) => b.riskScore - a.riskScore);
}

function daysUntilDue(dueDate: string): number {
  const now = new Date();
  const due = new Date(`${dueDate}T23:59:59`);
  return Math.ceil((due.getTime() - now.getTime()) / 86400000);
}

// ---------------------------------------------------------------------------
// Precedent / Case Law Management
// ---------------------------------------------------------------------------

export interface Precedent {
  id: string;
  citation: string;
  title: string;
  court: "SC" | "HC" | "AAT" | "AAAR" | "TRIBUNAL" | "CIRCULAR" | "NOTIFICATION";
  year: number;
  sections: string[];
  rules: string[];
  principle: string;
  favorableTo: "taxpayer" | "revenue" | "neutral";
  tags: string[];
  url?: string;
}

export const BUILT_IN_PRECEDENTS: Precedent[] = [
  {
    id: "pre-1",
    citation: "2021 (42) GSTL 1 (SC)",
    title: "M/s. Jindal Stainless Ltd. vs State of Haryana",
    court: "SC",
    year: 2021,
    sections: ["s 16(2)(aa)"],
    rules: ["Rule 36(4)"],
    principle:
      "Recipient cannot be penalized for supplier's default in filing GSTR-1 if recipient has exercised due diligence.",
    favorableTo: "taxpayer",
    tags: ["itc-reversal", "rule-37", "due-diligence"],
  },
  {
    id: "pre-2",
    citation: "2022 (46) GSTL 1 (SC)",
    title: "M/s. Safari Retreats Pvt. Ltd. vs Chief Commissioner of CGST",
    court: "SC",
    year: 2022,
    sections: ["s 17(5)(c)", "s 17(5)(d)"],
    rules: [],
    principle:
      "Works contract for immovable property — ITC blocked only if contract is for construction of immovable property, not plant & machinery.",
    favorableTo: "taxpayer",
    tags: ["blocked-itc", "works-contract", "s17-5"],
  },
  {
    id: "pre-3",
    citation: "Circular No. 170/02/2022-GST",
    title: "Clarification on RCM liability for GTA services",
    court: "CIRCULAR",
    year: 2022,
    sections: ["s 9(3)"],
    rules: ["Notif 13/2017"],
    principle: "GTA RCM liability on recipient — ITC available after payment under Table 4(A)(3).",
    favorableTo: "taxpayer",
    tags: ["rcm", "gta", "itc-eligibility"],
  },
];

export function findRelevantPrecedents(notice: GstNotice, maxResults = 5): Precedent[] {
  const relevant = BUILT_IN_PRECEDENTS.filter((p) => {
    const sectionMatch = notice.sections.some((s) => p.sections.includes(s));
    const ruleMatch = notice.rules.some((r) => p.rules.includes(r));
    const tagMatch = notice.tags.some((t) => p.tags.includes(t));
    return sectionMatch || ruleMatch || tagMatch;
  });

  return relevant
    .sort((a, b) => {
      // Prioritize taxpayer-favorable, then higher courts
      const courtRank = { SC: 5, HC: 4, AAT: 3, AAAR: 2, TRIBUNAL: 2, CIRCULAR: 1, NOTIFICATION: 1 };
      const favRank = { taxpayer: 3, neutral: 2, revenue: 1 };
      const scoreA = (courtRank[a.court] || 0) * 10 + (favRank[a.favorableTo] || 0);
      const scoreB = (courtRank[b.court] || 0) * 10 + (favRank[b.favorableTo] || 0);
      return scoreB - scoreA;
    })
    .slice(0, maxResults);
}

const gstNoticeWorkflowEngine = {
  linkNoticeToReconciliation,
  generateResponseDraft,
  buildNoticeTimeline,
  buildNoticeWorklist,
  findRelevantPrecedents,
  BUILT_IN_PRECEDENTS,
  NoticeWorkflowError,
};

export default gstNoticeWorkflowEngine;
