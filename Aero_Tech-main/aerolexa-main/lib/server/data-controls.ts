/**
 * Client-data controls: retention posture, confidentiality, consent, and the
 * controlled export / erasure paths a CA firm owes its clients and the DPDP Act.
 *
 * This is the enforcement layer, not the storage layer:
 *
 *  - RETENTION  — an engagement's purge-eligibility is computed from its
 *    jurisdiction floor, the firm's override and any legal hold
 *    (lib/server/jurisdiction.ts + engagementRetention()). A hold always wins.
 *  - CONSENT    — engagement-scoped ClientConsent rows (append-only proof).
 *    A cross-border transfer of taxpayer data needs one.
 *  - EXPORT     — every export passes assertExportAllowed(): role, consent and
 *    cross-border checks, then redaction of taxpayer identifiers, and a ledger
 *    entry recording who exported what, when and why.
 *  - ERASURE    — plan → request → execute. Execution is refused while a legal
 *    hold applies or the retention floor has not passed. The audit ledger and
 *    the consent proof are NEVER deleted; only the live client artifacts are.
 *
 * Everything is guarded through lib/server/engagement.ts, so org isolation is
 * enforced in one place (404 across firms, never 403).
 */

import { ApiError, forbiddenError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import {
  engagementRetention,
  orgPrivacySettings,
  practiceRoleLabel,
  requireEngagementRole,
  scrubIdentifiersInText,
  type EngagementRetention,
  type EngagementRow,
  type PracticeRole,
} from "@/lib/server/engagement";
import { appendLedgerEntry, changeLogRowToView, type ChangeLogEntryView } from "@/lib/server/governance";
import { crossBorderTransfer, jurisdictionProfile } from "@/lib/server/jurisdiction";
import { withTenantDb } from "@/lib/server/tenant-db";
import type { ClientConsentPurpose, DataClassification } from "@/lib/types";

const CLIENT_CONSENT_PURPOSES: readonly ClientConsentPurpose[] = [
  "engagement",
  "statutory-filing",
  "cross-border-transfer",
  "product-improvement",
];

// ---------------------------------------------------------------------------
// Firm privacy posture
// ---------------------------------------------------------------------------

/** Read the firm privacy posture for the caller's organization. */
async function privacyForOrganization(ctx: AuthContext, organizationId: string) {
  const org = await withTenantDb(ctx, (db) =>
    db.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    }),
  );
  return orgPrivacySettings(org?.settings ?? null).privacy;
}

// ---------------------------------------------------------------------------
// Retention posture + erasure checklist
// ---------------------------------------------------------------------------

export interface ErasureChecklistItem {
  kind:
    | "dataset"
    | "analysis"
    | "insight"
    | "dashboard"
    | "report"
    | "notebook"
    | "connector"
    | "scheduledReport"
    | "scheduledNotebook"
    | "workingPaper"
    | "changeRequest"
    | "clientConsent"
    | "changeLog";
  label: string;
  count: number;
  /** The row is part of the statutory audit record and is retained, not erased. */
  retained: boolean;
  note: string;
}

/** Per-engagement data counts + retention posture for the governance panel. */
export interface EngagementDataPosture {
  engagementId: string;
  jurisdiction: string;
  jurisdictionName: string;
  classification: DataClassification;
  retention: EngagementRetention;
  counts: Record<string, number>;
}

async function projectIdsForEngagement(ctx: AuthContext, organizationId: string, engagementId: string): Promise<string[]> {
  const projects = await withTenantDb(ctx, (db) =>
    db.project.findMany({
      where: { engagementId, organizationId },
      select: { id: true },
    }),
  );
  return projects.map((p) => p.id);
}

/**
 * The workspaces an engagement's projects live in. Connectors are
 * workspace-scoped (a Connector has no projectId), and a workspace can serve
 * more than one engagement, so connectors are reported and revoked manually
 * rather than deleted out from under a sibling engagement.
 */
async function workspaceIdsForEngagement(ctx: AuthContext, organizationId: string, engagementId: string): Promise<string[]> {
  const projects = await withTenantDb(ctx, (db) =>
    db.project.findMany({
      where: { engagementId, organizationId },
      select: { workspaceId: true },
    }),
  );
  return [...new Set(projects.map((p) => p.workspaceId))];
}

/** Count what an erasure would remove, and what statute requires keeping. */
export async function erasureChecklistForEngagement(
  ctx: AuthContext,
  organizationId: string,
  engagementId: string,
): Promise<ErasureChecklistItem[]> {
  const projectIds = await projectIdsForEngagement(ctx, organizationId, engagementId);
  const workspaceIds = await workspaceIdsForEngagement(ctx, organizationId, engagementId);
  const byProject = projectIds.length ? { projectId: { in: projectIds } } : { projectId: null as string | null };
  const byWorkspace = workspaceIds.length ? { workspaceId: { in: workspaceIds } } : { id: "__none__" };

  const [
    datasets,
    analyses,
    insights,
    dashboards,
    reports,
    notebooks,
    connectors,
    scheduledReports,
    scheduledNotebooks,
    workingPapers,
    changeRequests,
    clientConsents,
    changeLogs,
  ] = await Promise.all([
    withTenantDb(ctx, (db) => db.dataset.count({ where: byProject })),
    withTenantDb(ctx, (db) => db.analysis.count({ where: byProject })),
    withTenantDb(ctx, (db) => db.insight.count({ where: byProject })),
    withTenantDb(ctx, (db) => db.dashboard.count({ where: byProject })),
    withTenantDb(ctx, (db) => db.report.count({ where: byProject })),
    withTenantDb(ctx, (db) => db.notebook.count({ where: byProject })),
    withTenantDb(ctx, (db) => db.connector.count({ where: byWorkspace })),
    withTenantDb(ctx, (db) => db.scheduledReport.count({ where: byProject })),
    withTenantDb(ctx, (db) => db.scheduledNotebook.count({ where: byProject })),
    withTenantDb(ctx, (db) => db.workingPaper.count({ where: { engagementId } })),
    withTenantDb(ctx, (db) => db.engagementChangeRequest.count({ where: { engagementId } })),
    withTenantDb(ctx, (db) => db.clientConsent.count({ where: { engagementId } })),
    withTenantDb(ctx, (db) => db.engagementChangeLog.count({ where: { engagementId } })),
  ]);

  return [
    {
      kind: "dataset",
      label: "Datasets",
      count: datasets,
      retained: false,
      note: "Row + profiles removed; underlying data files are purged separately.",
    },
    { kind: "analysis", label: "Analyses", count: analyses, retained: false, note: "Removed with the client silo." },
    { kind: "insight", label: "Insights", count: insights, retained: false, note: "" },
    {
      kind: "dashboard",
      label: "Dashboards",
      count: dashboards,
      retained: false,
      note: "Publish links are revoked with the row.",
    },
    { kind: "report", label: "Reports", count: reports, retained: false, note: "" },
    { kind: "notebook", label: "Notebooks", count: notebooks, retained: false, note: "" },
    {
      kind: "connector",
      label: "Connectors (workspace-scoped)",
      count: connectors,
      retained: true,
      note: "A connector can serve several engagements; revoke its credentials manually before erasure.",
    },
    {
      kind: "scheduledReport",
      label: "Scheduled reports",
      count: scheduledReports,
      retained: false,
      note: "Schedules are disabled.",
    },
    {
      kind: "scheduledNotebook",
      label: "Scheduled notebooks",
      count: scheduledNotebooks,
      retained: false,
      note: "Schedules are disabled.",
    },
    {
      kind: "workingPaper",
      label: "Working papers",
      count: workingPapers,
      retained: false,
      note: "Content and versions removed; the ledger entry that recorded them is retained.",
    },
    {
      kind: "changeRequest",
      label: "Change requests",
      count: changeRequests,
      retained: false,
      note: "Current state removed; the ledger history remains.",
    },
    {
      kind: "clientConsent",
      label: "Client consents",
      count: clientConsents,
      retained: true,
      note: "Consent proof is never deleted; only the link to live data is revoked.",
    },
    {
      kind: "changeLog",
      label: "Change-ledger entries",
      count: changeLogs,
      retained: true,
      note: "The immutable audit trail is retained as the statutory record.",
    },
  ];
}

/** The full data-governance posture for an engagement. */
export async function engagementDataPosture(ctx: AuthContext, engagementId: string): Promise<EngagementDataPosture> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const privacy = await privacyForOrganization(ctx, engagement.organizationId);
  const retention = engagementRetention(engagement, privacy);
  const checklist = await erasureChecklistForEngagement(ctx, engagement.organizationId, engagement.id);
  const counts: Record<string, number> = {};
  for (const item of checklist) counts[item.kind] = item.count;
  return {
    engagementId: engagement.id,
    jurisdiction: retention.jurisdiction,
    jurisdictionName: retention.jurisdictionName,
    classification: retention.classification,
    retention,
    counts,
  };
}

// ---------------------------------------------------------------------------
// Retention policy updates (legal hold, jurisdiction, classification)
// ---------------------------------------------------------------------------

export interface ApplyRetentionInput {
  jurisdiction?: string;
  legalHold?: boolean;
  retentionUntil?: string | null;
  dataClassification?: DataClassification;
  reason: string;
}

/**
 * Set the engagement's jurisdiction/classification/retention posture. Requires
 * partner standing, and every change is written to the ledger with its reason.
 */
export async function applyRetentionPolicy(
  ctx: AuthContext,
  engagementId: string,
  input: ApplyRetentionInput,
): Promise<EngagementDataPosture> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "MANAGER");
  if (role !== "PARTNER") throw forbiddenError("Only a partner can change an engagement's retention posture.");
  const reason = (input.reason ?? "").trim();
  if (reason.length < 3) throw new ApiError(400, "VALIDATION", "Record the reason for this retention change.");

  const data: {
    jurisdiction?: string;
    legalHold?: boolean;
    retentionUntil?: Date | null;
    dataClassification?: string;
    retainedById: string;
  } = { retainedById: ctx.user.id };

  if (input.jurisdiction !== undefined) {
    const code = input.jurisdiction.trim().toUpperCase();
    const profile = jurisdictionProfile(code);
    data.jurisdiction = code;
    void profile; // unknown codes are allowed but flagged in the posture
  }
  if (input.legalHold !== undefined) data.legalHold = input.legalHold;
  if (input.retentionUntil !== undefined) {
    data.retentionUntil = input.retentionUntil ? new Date(input.retentionUntil) : null;
    if (data.retentionUntil && Number.isNaN(data.retentionUntil.getTime())) {
      throw new ApiError(400, "VALIDATION", "retentionUntil must be an ISO date or null.");
    }
  }
  if (input.dataClassification !== undefined) data.dataClassification = input.dataClassification;

  const updated = await withTenantDb(ctx, (db) =>
    db.engagement.update({ where: { id: engagement.id }, data }),
  );

  await appendLedgerEntry(ctx, engagement, role, {
    action: "RETENTION_POLICY_UPDATED",
    targetType: "engagement",
    targetId: engagement.id,
    summary: `Retention posture updated: ${reason}`,
    rawSummary: reason,
    meta: {
      jurisdiction: updated.jurisdiction,
      legalHold: updated.legalHold,
      retentionUntil: updated.retentionUntil ? updated.retentionUntil.toISOString() : null,
      classification: updated.dataClassification,
    },
  });

  return engagementDataPosture(ctx, engagementId);
}

// ---------------------------------------------------------------------------
// Client consent
// ---------------------------------------------------------------------------

export interface ClientConsentView {
  id: string;
  purpose: ClientConsentPurpose | string;
  subjectRef: string;
  granted: boolean;
  policyVersion: string;
  evidenceNote: string | null;
  recordedById: string;
  expiresAt: string | null;
  createdAt: string;
}

const CLIENT_CONSENT_POLICY_VERSION = "2026-10-08.1";

/** Current consent state per purpose (latest row wins). */
export async function listClientConsents(ctx: AuthContext, engagementId: string): Promise<ClientConsentView[]> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const rows = await withTenantDb(ctx, (db) =>
    db.clientConsent.findMany({
      where: { engagementId: engagement.id },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    purpose: r.purpose,
    subjectRef: r.subjectRef,
    granted: r.granted,
    policyVersion: r.policyVersion,
    evidenceNote: r.evidenceNote,
    recordedById: r.recordedById,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface RecordClientConsentInput {
  purpose: ClientConsentPurpose;
  subjectRef: string;
  granted?: boolean;
  evidenceNote?: string | null;
  expiresAt?: string | null;
}

/** Record a client consent decision (append-only). Requires manager. */
export async function recordClientConsent(
  ctx: AuthContext,
  engagementId: string,
  input: RecordClientConsentInput,
): Promise<ClientConsentView> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "MANAGER");
  if (!CLIENT_CONSENT_PURPOSES.includes(input.purpose)) {
    throw new ApiError(400, "VALIDATION", `Unknown consent purpose “${input.purpose}”.`);
  }
  const subjectRef = (input.subjectRef ?? "").trim();
  if (subjectRef.length < 2)
    throw new ApiError(400, "VALIDATION", "Record who gave the consent (a role label is fine).");
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new ApiError(400, "VALIDATION", "expiresAt must be an ISO date or null.");
  }

  const row = await withTenantDb(ctx, (db) =>
    db.clientConsent.create({
      data: {
        organizationId: engagement.organizationId,
        engagementId: engagement.id,
        purpose: input.purpose,
        subjectRef,
        granted: input.granted ?? true,
        policyVersion: CLIENT_CONSENT_POLICY_VERSION,
        evidenceNote: input.evidenceNote?.trim() || null,
        recordedById: ctx.user.id,
        expiresAt,
      },
    }),
  );

  await appendLedgerEntry(ctx, engagement, role, {
    action: input.granted === false ? "CLIENT_CONSENT_WITHDRAWN" : "CLIENT_CONSENT_RECORDED",
    targetType: "clientConsent",
    targetId: row.id,
    summary: `Consent ${input.granted === false ? "withdrawn" : "recorded"} for ${input.purpose}`,
    meta: { purpose: input.purpose, subjectRef },
  });

  return {
    id: row.id,
    purpose: row.purpose,
    subjectRef: row.subjectRef,
    granted: row.granted,
    policyVersion: row.policyVersion,
    evidenceNote: row.evidenceNote,
    recordedById: row.recordedById,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Is there a current, unexpired grant for the purpose? */
async function hasCurrentConsent(ctx: AuthContext, engagementId: string, purpose: ClientConsentPurpose, now: Date): Promise<boolean> {
  const rows = await withTenantDb(ctx, (db) =>
    db.clientConsent.findMany({
      where: { engagementId, purpose },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  );
  const latest = rows[0];
  if (!latest) return false;
  if (!latest.granted) return false;
  if (latest.expiresAt && latest.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Controlled export
// ---------------------------------------------------------------------------

export interface ExportDecision {
  allowed: boolean;
  /** Identifiers were redacted in the produced package. */
  redacted: boolean;
  crossBorder: boolean;
  consentRequired: boolean;
  /** Human-readable reasons for a refusal (empty when allowed). */
  blockers: string[];
}

async function evaluateExport(
  ctx: AuthContext,
  engagement: EngagementRow,
  role: PracticeRole,
  opts: { targetJurisdiction?: string; includeIdentifiers?: boolean },
): Promise<ExportDecision> {
  const privacy = await privacyForOrganization(ctx, engagement.organizationId);
  const blockers: string[] = [];

  // 1. Cross-border check. An unknown target is treated as cross-border.
  const transfer = crossBorderTransfer(engagement.jurisdiction, opts.targetJurisdiction ?? engagement.jurisdiction);
  if (transfer.crossBorder && !privacy.crossBorderTransferAllowed) {
    blockers.push("Cross-border transfer is disabled by the firm's privacy posture.");
  }

  // 2. Consent. Taxpayer-data exports need one when the firm requires it, and
  //    any cross-border transfer needs one for the transfer purpose.
  const now = new Date();
  if (transfer.crossBorder && transfer.consentRequired) {
    const ok = await hasCurrentConsent(ctx, engagement.id, "cross-border-transfer", now);
    if (!ok) blockers.push("No current client consent for a cross-border transfer.");
  }
  if (privacy.taxpayerExportConsentRequired) {
    const ok = await hasCurrentConsent(ctx, engagement.id, "statutory-filing", now);
    if (!ok) blockers.push("No current client consent on file for exporting taxpayer data.");
  }

  // 3. Redaction. The firm setting governs the default; a partner/manager may
  //    explicitly request full identifiers, but a cross-border transfer is
  //    ALWAYS redacted so an unredacted taxpayer identifier never leaves the
  //    jurisdiction in a package.
  const wantsFull = opts.includeIdentifiers === true;
  if (wantsFull && role !== "PARTNER" && role !== "MANAGER") {
    blockers.push("Only a partner or manager may export unredacted taxpayer identifiers.");
  }
  let redacted = wantsFull ? false : privacy.panRedactionDefault;
  if (transfer.crossBorder) redacted = true;

  return {
    allowed: blockers.length === 0,
    redacted,
    crossBorder: transfer.crossBorder,
    consentRequired: transfer.consentRequired,
    blockers,
  };
}

/** Assert an export is permitted, or throw with the concrete blockers. */
export async function assertExportAllowed(
  ctx: AuthContext,
  engagementId: string,
  opts: { targetJurisdiction?: string; includeIdentifiers?: boolean } = {},
): Promise<{ role: PracticeRole; decision: ExportDecision; engagement: EngagementRow }> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  if (role === "AUDITOR") throw forbiddenError("Auditors have read-only access and cannot export client data.");
  const decision = await evaluateExport(ctx, engagement, role, opts);
  if (!decision.allowed) {
    throw new ApiError(403, "EXPORT_BLOCKED", `Export blocked: ${decision.blockers.join(" ")}`, decision);
  }
  return { role, decision, engagement };
}

export interface ExportPackage {
  generatedAt: string;
  engagement: {
    id: string;
    name: string;
    code: string | null;
    jurisdiction: string;
    classification: string;
    legalHold: boolean;
  };
  scope: { redacted: boolean; crossBorder: boolean; targetJurisdiction: string | null; reason: string };
  workingPapers: { indexRef: string; title: string; status: string; version: number; contentHash: string | null }[];
  changeRequests: { title: string; state: string; targetType: string; requestedAt: string }[];
  consents: { purpose: string; subjectRef: string; granted: boolean; createdAt: string }[];
  ledger: ChangeLogEntryView[];
  counts: Record<string, number>;
}

/**
 * Produce a controlled export of an engagement's governance record, with
 * identifiers redacted unless a partner/manager explicitly asked for full
 * values, and record the export in the immutable ledger.
 */
export async function exportEngagementPackage(
  ctx: AuthContext,
  engagementId: string,
  opts: { reason: string; targetJurisdiction?: string; includeIdentifiers?: boolean },
): Promise<ExportPackage> {
  const reason = (opts.reason ?? "").trim();
  if (reason.length < 3) throw new ApiError(400, "VALIDATION", "Record the reason for this export.");

  const { role, decision, engagement: eng } = await assertExportAllowed(ctx, engagementId, opts);
  const full = await withTenantDb(ctx, (db) =>
    db.engagement.findUniqueOrThrow({ where: { id: eng.id } }),
  );

  const [workingPapers, changeRequests, consents, checklist, ledger] = await Promise.all([
    prisma.workingPaper.findMany({ where: { engagementId: eng.id }, orderBy: { indexRef: "asc" } }),
    prisma.engagementChangeRequest.findMany({ where: { engagementId: eng.id }, orderBy: { requestedAt: "desc" } }),
    prisma.clientConsent.findMany({ where: { engagementId: eng.id }, orderBy: { createdAt: "desc" } }),
    erasureChecklistForEngagement(ctx, eng.organizationId, eng.id),
    prisma.engagementChangeLog.findMany({ where: { engagementId: eng.id }, orderBy: { seq: "asc" }, take: 2000 }),
  ]);

  const counts: Record<string, number> = {};
  for (const item of checklist) counts[item.kind] = item.count;

  const showFull = !decision.redacted;
  const redactText = (t: string | null) => (showFull ? (t ?? "") : scrubIdentifiersInText(t));

  const pkg: ExportPackage = {
    generatedAt: new Date().toISOString(),
    engagement: {
      id: full.id,
      name: full.name,
      code: full.code,
      jurisdiction: full.jurisdiction,
      classification: full.dataClassification,
      legalHold: full.legalHold,
    },
    scope: {
      redacted: decision.redacted,
      crossBorder: decision.crossBorder,
      targetJurisdiction: opts.targetJurisdiction?.trim().toUpperCase() || null,
      reason,
    },
    workingPapers: workingPapers.map((w) => ({
      indexRef: w.indexRef,
      title: redactText(w.title),
      status: w.status,
      version: w.version,
      contentHash: w.contentHash,
    })),
    changeRequests: changeRequests.map((c) => ({
      title: redactText(c.title),
      state: c.state,
      targetType: c.targetType,
      requestedAt: c.requestedAt.toISOString(),
    })),
    consents: consents.map((c) => ({
      purpose: c.purpose,
      subjectRef: c.subjectRef,
      granted: c.granted,
      createdAt: c.createdAt.toISOString(),
    })),
    ledger: ledger.map((row): ChangeLogEntryView => {
      const view = changeLogRowToView(row);
      return {
        ...view,
        summary: redactText(view.summary) ?? "",
        rawSummary: decision.redacted ? null : view.rawSummary,
      };
    }),
    counts,
  };

  await appendLedgerEntry(ctx, eng, role, {
    action: "ENGAGEMENT_EXPORTED",
    targetType: "engagement",
    targetId: eng.id,
    summary: `Exported governance record${decision.redacted ? " (redacted)" : " (full identifiers)"}${decision.crossBorder ? ` to ${opts.targetJurisdiction}` : ""}: ${reason}`,
    rawSummary: reason,
    meta: {
      redacted: decision.redacted,
      crossBorder: decision.crossBorder,
      targetJurisdiction: opts.targetJurisdiction?.trim().toUpperCase() || null,
    },
  });

  return pkg;
}

// ---------------------------------------------------------------------------
// Erasure: plan → request → execute
// ---------------------------------------------------------------------------

export interface ErasurePlan {
  engagementId: string;
  eligible: boolean;
  blockers: string[];
  retention: EngagementRetention;
  checklist: ErasureChecklistItem[];
  retainedKinds: string[];
}

/** Compute whether an engagement may be erased, and what would be removed. */
export async function planEngagementErasure(ctx: AuthContext, engagementId: string): Promise<ErasurePlan> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const privacy = await privacyForOrganization(ctx, engagement.organizationId);
  const retention = engagementRetention(engagement, privacy);
  const checklist = await erasureChecklistForEngagement(ctx, engagement.organizationId, engagement.id);

  const blockers: string[] = [];
  if (retention.legalHold) blockers.push("A legal hold is active on this engagement.");
  if (!retention.purgeEligible) {
    blockers.push(`The retention floor has not passed (eligible from ${retention.purgeEligibleAt}).`);
  }
  return {
    engagementId: engagement.id,
    eligible: blockers.length === 0,
    blockers,
    retention,
    checklist,
    retainedKinds: checklist.filter((c) => c.retained).map((c) => c.kind),
  };
}

export interface ErasureRequestResult {
  requested: true;
  plan: ErasurePlan;
  ledgerEntry: ChangeLogEntryView;
}

/** Request erasure: records the intent in the ledger and returns the plan. */
export async function requestEngagementErasure(
  ctx: AuthContext,
  engagementId: string,
  reason: string,
): Promise<ErasureRequestResult> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "PARTNER");
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < 5) throw new ApiError(400, "VALIDATION", "Record why the client data is being erased.");

  const plan = await planEngagementErasure(ctx, engagement.id);
  const ledgerEntry = await appendLedgerEntry(ctx, engagement, role, {
    action: "ERASURE_REQUESTED",
    targetType: "engagement",
    targetId: engagement.id,
    summary: `Erasure requested: ${trimmed}`,
    rawSummary: trimmed,
    meta: { eligible: plan.eligible, blockers: plan.blockers },
  });
  return { requested: true, plan, ledgerEntry };
}

export interface ErasureResult {
  engagementId: string;
  erased: Record<string, number>;
  retained: string[];
  archived: true;
}

/**
 * Execute erasure. Refused while a legal hold applies or the retention floor
 * has not passed, unless a partner supplies `overrideRetention: true` with a
 * reason (which is itself recorded). The change ledger and client-consent proof
 * are retained; only live client artifacts are removed.
 */
export async function executeEngagementErasure(
  ctx: AuthContext,
  engagementId: string,
  input: { reason: string; confirm: string; overrideRetention?: boolean },
): Promise<ErasureResult> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "PARTNER");
  const reason = (input.reason ?? "").trim();
  if (reason.length < 5) throw new ApiError(400, "VALIDATION", "Record why the client data is being erased.");
  if (input.confirm !== engagement.code && input.confirm !== engagement.name) {
    throw new ApiError(400, "CONFIRMATION_REQUIRED", "Confirmation must match the engagement name or code.");
  }

  const privacy = await privacyForOrganization(ctx, engagement.organizationId);
  const retention = engagementRetention(engagement, privacy);
  if (retention.legalHold) throw new ApiError(409, "LEGAL_HOLD", "A legal hold is active on this engagement.");
  if (!retention.purgeEligible && !input.overrideRetention) {
    throw new ApiError(
      409,
      "RETENTION_ACTIVE",
      `The retention floor has not passed (eligible from ${retention.purgeEligibleAt}).`,
    );
  }

  const projectIds = await projectIdsForEngagement(ctx, engagement.organizationId, engagement.id);
  const byProject = projectIds.length ? { projectId: { in: projectIds } } : { projectId: null as string | null };

  const erased = await prisma.$transaction(async (tx) => {
    const counts: Record<string, number> = {};
    counts.datasets = (await withTenantDb(ctx, (db) => db.dataset.deleteMany({ where: byProject }))).count;
    counts.analyses = (await withTenantDb(ctx, (db) => db.analysis.deleteMany({ where: byProject }))).count;
    counts.insights = (await withTenantDb(ctx, (db) => db.insight.deleteMany({ where: byProject }))).count;
    counts.dashboards = (await withTenantDb(ctx, (db) => db.dashboard.deleteMany({ where: byProject }))).count;
    counts.reports = (await withTenantDb(ctx, (db) => db.report.deleteMany({ where: byProject }))).count;
    counts.notebooks = (await withTenantDb(ctx, (db) => db.notebook.deleteMany({ where: byProject }))).count;
    counts.scheduledReports = (await withTenantDb(ctx, (db) => db.scheduledReport.deleteMany({ where: byProject }))).count;
    counts.scheduledNotebooks = (await withTenantDb(ctx, (db) => db.scheduledNotebook.deleteMany({ where: byProject }))).count;
    // Working papers: versions cascade with the paper.
    counts.workingPapers = (await withTenantDb(ctx, (db) => db.workingPaper.deleteMany({ where: { engagementId: engagement.id } }))).count;
    counts.changeRequests = (
      await withTenantDb(ctx, (db) => db.engagementChangeRequest.deleteMany({ where: { engagementId: engagement.id } }))
    ).count;
    // Deliberately NOT deleted: workspace-scoped Connectors (shared with other
    // engagements), ClientConsent and EngagementChangeLog (audit proof).
    return counts;
  });

  const archived = await withTenantDb(ctx, (db) =>
    db.engagement.update({
      where: { id: engagement.id },
      data: { status: "ARCHIVED", retentionUntil: null, retainedById: ctx.user.id },
    }),
  );

  await appendLedgerEntry(ctx, engagement, role, {
    action: "ERASURE_EXECUTED",
    targetType: "engagement",
    targetId: engagement.id,
    summary: `Erasure executed: ${reason}`,
    rawSummary: reason,
    meta: {
      erased,
      retained: ["clientConsent", "changeLog"],
      overrideRetention: input.overrideRetention === true,
      reason,
    },
  });

  return {
    engagementId: archived.id,
    erased,
    retained: ["clientConsent", "changeLog"],
    archived: true,
  };
}

/**
 * Convenience summary string for a posture, used by UI and logs (keeps the
 * citation with the number so a reviewer can verify the claim).
 */
export function describeRetention(retention: EngagementRetention): string {
  const hold = retention.legalHold ? "LEGAL HOLD" : retention.purgeEligible ? "purge-eligible" : "retained";
  return `${retention.jurisdictionName}: ${hold} until ${retention.purgeEligibleAt.slice(0, 10)} (${retention.floorDays} days floor)`;
}

/** Re-exported so callers can present role labels without a second import. */
export { practiceRoleLabel };
