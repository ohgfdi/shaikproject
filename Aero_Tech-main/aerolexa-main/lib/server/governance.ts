/**
 * Audit-grade change control for client data and working papers.
 *
 * Two primitives a CA firm is answerable for, both implemented here:
 *
 *  1. WORKING PAPERS (SA 230) — a paper has a current state row plus an
 *     append-only version chain. A version is never edited: a new revision is
 *     appended, and the paper must be reviewed and then signed off. Sign-off
 *     requires a partner/manager, so a preparer cannot sign their own work off
 *     (a partner may, and that fact is recorded).
 *
 *  2. CHANGE REQUESTS + IMMUTABLE LEDGER — every change to client data goes
 *     through a request with an explicit "why" (rationale), a review, and a
 *     role-gated sign-off. Every transition (and every working-paper action)
 *     appends one row to a per-engagement, hash-chained ledger. Each entry
 *     stores the hash of the previous entry, so editing or deleting a row is
 *     detectable: see verifyEngagementLedger().
 *
 * The ledger is the single source of truth for "who changed what, when, why":
 * the change-request table only holds current state. `getChangeRequestTimeline`
 * reconstructs the full history (including review evidence) from the ledger.
 *
 * All authorization funnels through lib/server/engagement.ts, so org isolation
 * (404, never 403) is enforced in one place.
 */

import { createHash } from "node:crypto";

import { ApiError, forbiddenError, notFoundError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJson } from "@/lib/json";
import {
  canPrepareWork,
  canRequestChange,
  canReview,
  canSignOff,
  engagementPracticeRole,
  loadEngagement,
  normalizePracticeRole,
  practiceRank,
  practiceRoleLabel,
  requireEngagementAccess,
  requireEngagementRole,
  type EngagementProject,
  type EngagementRow,
  type PracticeRole,
} from "@/lib/server/engagement";
import type { ChangeRequestState, DataClassification } from "@/lib/types";

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

/** Stable JSON: object keys sorted recursively so a hash is reproducible. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** SHA-256 hex of a value's canonical JSON. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** The exact fields that are chained, in a fixed order. */
interface HashFields {
  seq: number;
  engagementId: string;
  changeRequestId: string | null;
  actorId: string;
  actorPracticeRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  rawSummary: string | null;
  meta: string | null;
  consentAware: boolean;
  prevHash: string | null;
}

const FIELD_SEP = "\u241f"; // unit separator — will not occur in practice data

/** Compute an entry's chain hash from its fields + the previous entry's hash. */
export function computeEntryHash(fields: HashFields): string {
  const canonical = [
    "v1",
    String(fields.seq),
    fields.engagementId,
    fields.changeRequestId ?? "",
    fields.actorId,
    fields.actorPracticeRole,
    fields.action,
    fields.targetType,
    fields.targetId ?? "",
    fields.summary,
    fields.rawSummary ?? "",
    fields.meta ?? "",
    fields.consentAware ? "1" : "0",
    fields.prevHash ?? "",
  ].join(FIELD_SEP);
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Ledger views + append
// ---------------------------------------------------------------------------

export interface ChangeLogEntryView {
  id: string;
  engagementId: string;
  seq: number;
  changeRequestId: string | null;
  actorId: string;
  actorPracticeRole: PracticeRole;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  rawSummary: string | null;
  meta: Record<string, unknown> | null;
  consentAware: boolean;
  prevHash: string | null;
  entryHash: string;
  createdAt: string;
}

type LedgerRow = {
  id: string;
  engagementId: string;
  seq: number;
  changeRequestId: string | null;
  actorId: string;
  actorPracticeRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  rawSummary: string | null;
  meta: string | null;
  consentAware: boolean;
  prevHash: string | null;
  entryHash: string;
  createdAt: Date;
};

export function changeLogRowToView(row: LedgerRow): ChangeLogEntryView {
  return {
    id: row.id,
    engagementId: row.engagementId,
    seq: row.seq,
    changeRequestId: row.changeRequestId,
    actorId: row.actorId,
    actorPracticeRole: normalizePracticeRole(row.actorPracticeRole) ?? "ASSISTANT",
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    summary: row.summary,
    rawSummary: row.rawSummary,
    meta: row.meta ? parseJson<Record<string, unknown> | null>(row.meta, null) : null,
    consentAware: row.consentAware,
    prevHash: row.prevHash,
    entryHash: row.entryHash,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface AppendLedgerInput {
  changeRequestId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  /** Human-readable, already-safe summary. */
  summary: string;
  /** Optional fuller diff. Persisted only when the firm allows full diff logging. */
  rawSummary?: string | null;
  meta?: Record<string, unknown> | null;
}

/** How many times to retry a seq collision before giving up. */
const LEDGER_SEQ_RETRIES = 5;

/**
 * Append an immutable ledger entry, chaining it to the previous entry for the
 * same engagement. `seq` is assigned inside a transaction; a concurrent writer
 * that loses the race retries with the next seq.
 */
export async function appendLedgerEntry(
  ctx: AuthContext,
  engagement: EngagementRow,
  actorRole: PracticeRole,
  input: AppendLedgerInput,
): Promise<ChangeLogEntryView> {
  const org = await prisma.organization.findUnique({
    where: { id: engagement.organizationId },
    select: { settings: true },
  });
  const privacy = org?.settings ? parseJson<{ privacy?: { fullDiffLoggingDefault?: boolean } }>(org.settings, {}) : {};
  const allowRaw = privacy.privacy?.fullDiffLoggingDefault === true && canSignOff(actorRole);
  const rawSummary = allowRaw ? (input.rawSummary ?? null) : null;
  const meta = input.meta ? JSON.stringify(input.meta) : null;
  const consentAware = true;

  for (let attempt = 0; attempt < LEDGER_SEQ_RETRIES; attempt++) {
    try {
      const row = await prisma.$transaction(async (tx) => {
        const last = await tx.engagementChangeLog.findFirst({
          where: { engagementId: engagement.id },
          orderBy: { seq: "desc" },
          select: { seq: true, entryHash: true },
        });
        const seq = (last?.seq ?? 0) + 1;
        const prevHash = last?.entryHash ?? null;
        const fields: HashFields = {
          seq,
          engagementId: engagement.id,
          changeRequestId: input.changeRequestId ?? null,
          actorId: ctx.user.id,
          actorPracticeRole: actorRole,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId ?? null,
          summary: input.summary,
          rawSummary,
          meta,
          consentAware,
          prevHash,
        };
        const entryHash = computeEntryHash(fields);
        return tx.engagementChangeLog.create({
          data: {
            organizationId: engagement.organizationId,
            engagementId: engagement.id,
            seq,
            changeRequestId: input.changeRequestId ?? null,
            actorId: ctx.user.id,
            actorPracticeRole: actorRole,
            action: input.action,
            targetType: input.targetType,
            targetId: input.targetId ?? null,
            summary: input.summary,
            rawSummary,
            meta,
            consentAware,
            prevHash,
            entryHash,
          },
        });
      });
      return changeLogRowToView(row);
    } catch (err) {
      // Unique(engagementId, seq) collision — another writer took this seq.
      const code = (err as { code?: string }).code;
      if (code === "P2002" && attempt < LEDGER_SEQ_RETRIES - 1) continue;
      throw err;
    }
  }
  throw new ApiError(409, "LEDGER_CONTENTION", "Could not append to the change ledger; please retry.");
}

/**
 * Read an engagement's change history (newest first). Kept exported under the
 * original name for callers that only need the list.
 */
export async function listEngagementChangeLog(
  organizationId: string,
  engagementId: string,
  opts?: { after?: string; limit?: number },
): Promise<ChangeLogEntryView[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
  const rows = await prisma.engagementChangeLog.findMany({
    where: { organizationId, engagementId, createdAt: opts?.after ? { gt: new Date(opts.after) } : undefined },
    orderBy: { seq: "desc" },
    take: limit,
  });
  return rows.map(changeLogRowToView);
}

export interface LedgerVerification {
  valid: boolean;
  entries: number;
  /** First seq at which the chain breaks, when invalid. */
  brokenAtSeq: number | null;
  reason: string | null;
}

/**
 * Recompute the whole chain and confirm every entry links to the one before it.
 * Detects edited summaries/diffs, a swapped actor, a deleted middle row and a
 * re-ordered history. This is what makes the ledger tamper-EVIDENT rather than
 * merely append-only by convention.
 */
export async function verifyEngagementLedger(
  organizationId: string,
  engagementId: string,
): Promise<LedgerVerification> {
  const rows = await prisma.engagementChangeLog.findMany({
    where: { organizationId, engagementId },
    orderBy: { seq: "asc" },
  });

  let prevHash: string | null = null;
  let expectedSeq = 1;
  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return {
        valid: false,
        entries: rows.length,
        brokenAtSeq: row.seq,
        reason: `Missing or re-ordered entry at seq ${expectedSeq}.`,
      };
    }
    if ((row.prevHash ?? null) !== prevHash) {
      return {
        valid: false,
        entries: rows.length,
        brokenAtSeq: row.seq,
        reason: `Chain link broken at seq ${row.seq}.`,
      };
    }
    const expected = computeEntryHash({
      seq: row.seq,
      engagementId: row.engagementId,
      changeRequestId: row.changeRequestId,
      actorId: row.actorId,
      actorPracticeRole: row.actorPracticeRole,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      summary: row.summary,
      rawSummary: row.rawSummary,
      meta: row.meta,
      consentAware: row.consentAware,
      prevHash: row.prevHash,
    });
    if (expected !== row.entryHash) {
      return {
        valid: false,
        entries: rows.length,
        brokenAtSeq: row.seq,
        reason: `Entry ${row.seq} content does not match its hash.`,
      };
    }
    prevHash = row.entryHash;
    expectedSeq += 1;
  }
  return { valid: true, entries: rows.length, brokenAtSeq: null, reason: null };
}

// ---------------------------------------------------------------------------
// Change requests
// ---------------------------------------------------------------------------

export interface ChangeRequestView {
  id: string;
  engagementId: string;
  projectId: string | null;
  title: string;
  description: string | null;
  rationale: string | null;
  targetType: string;
  targetId: string | null;
  state: ChangeRequestState;
  assignedToPracticeRole: PracticeRole;
  signOffRequiredFor: PracticeRole;
  reviewNote: string | null;
  requestedById: string;
  requestedAt: string;
  updatedAt: string;
}

type ChangeRequestRow = Parameters<typeof changeRequestRowToView>[0];

function changeRequestRowToView(row: {
  id: string;
  engagementId: string;
  projectId: string | null;
  title: string;
  description: string | null;
  rationale: string | null;
  targetType: string;
  targetId: string | null;
  state: string;
  assignedToPracticeRole: string;
  signOffRequiredFor: string;
  reviewNote: string | null;
  requestedById: string;
  requestedAt: Date;
  updatedAt: Date;
}): ChangeRequestView {
  return {
    id: row.id,
    engagementId: row.engagementId,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    rationale: row.rationale,
    targetType: row.targetType,
    targetId: row.targetId,
    state: row.state as ChangeRequestState,
    assignedToPracticeRole: normalizePracticeRole(row.assignedToPracticeRole) ?? "SENIOR",
    signOffRequiredFor: normalizePracticeRole(row.signOffRequiredFor) ?? "MANAGER",
    reviewNote: row.reviewNote,
    requestedById: row.requestedById,
    requestedAt: row.requestedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateChangeRequestInput {
  title: string;
  description?: string;
  /** The "why". Required before the request can be submitted. */
  rationale?: string;
  targetType: string;
  targetId?: string | null;
  assignedToPracticeRole?: PracticeRole;
  signOffRequiredFor?: PracticeRole;
}

async function loadChangeRequest(engagementId: string, changeRequestId: string) {
  const cr = await prisma.engagementChangeRequest.findFirst({ where: { id: changeRequestId, engagementId } });
  if (!cr) throw notFoundError("Change request not found.");
  return cr;
}

/** Raise a change request (DRAFT). Requires a preparer role. */
export async function createChangeRequest(
  ctx: AuthContext,
  engagementId: string,
  input: CreateChangeRequestInput,
): Promise<ChangeRequestView> {
  const { role, engagement, project } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  if (!canRequestChange(role)) throw forbiddenError("Auditors cannot raise change requests.");
  const title = (input.title ?? "").trim();
  if (title.length < 3) throw new ApiError(400, "VALIDATION", "Give the change request a descriptive title.");

  const row = await prisma.engagementChangeRequest.create({
    data: {
      organizationId: engagement.organizationId,
      engagementId: engagement.id,
      projectId: project?.id ?? null,
      title,
      description: input.description?.trim() || null,
      rationale: input.rationale?.trim() || null,
      targetType: (input.targetType ?? "").trim() || "clientData",
      targetId: input.targetId ?? null,
      state: "DRAFT",
      assignedToPracticeRole: input.assignedToPracticeRole ?? "SENIOR",
      signOffRequiredFor: input.signOffRequiredFor ?? "MANAGER",
      requestedById: ctx.user.id,
      requestedAt: new Date(),
    },
  });

  await appendLedgerEntry(ctx, engagement, role, {
    changeRequestId: row.id,
    action: "CHANGE_REQUEST_CREATED",
    targetType: "changeRequest",
    targetId: row.id,
    summary: `Change request created: ${row.title}`,
    meta: { targetType: row.targetType, signOffRequiredFor: row.signOffRequiredFor },
  });
  return changeRequestRowToView(row);
}

/** DRAFT → REQUESTED. The rationale ("why") must be present. */
export async function submitChangeRequest(
  ctx: AuthContext,
  engagementId: string,
  changeRequestId: string,
): Promise<ChangeRequestView> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  if (!canRequestChange(role)) throw forbiddenError("Auditors cannot submit change requests.");
  const cr = await loadChangeRequest(engagementId, changeRequestId);
  if (cr.state !== "DRAFT" && cr.state !== "CHANGES_REQUESTED") {
    throw new ApiError(409, "INVALID_STATE", "Only a draft or returned request can be submitted.");
  }
  if (!cr.rationale || cr.rationale.trim().length < 3) {
    throw new ApiError(400, "RATIONALE_REQUIRED", "Record the reason for this change before submitting it for review.");
  }
  const updated = await prisma.engagementChangeRequest.update({
    where: { id: cr.id },
    data: { state: "REQUESTED" },
  });
  await appendLedgerEntry(ctx, engagement, role, {
    changeRequestId: cr.id,
    action: "CHANGE_REQUEST_SUBMITTED",
    targetType: "changeRequest",
    targetId: cr.id,
    summary: `Submitted for review: ${cr.title}`,
    rawSummary: cr.rationale,
    meta: { rationale: cr.rationale },
  });
  return changeRequestRowToView(updated);
}

/** REQUESTED | CHANGES_REQUESTED → IN_REVIEW. Requires a reviewer role. */
export async function startReviewChangeRequest(
  ctx: AuthContext,
  engagementId: string,
  changeRequestId: string,
): Promise<ChangeRequestView> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "REVIEWER");
  if (!canReview(role)) throw forbiddenError("You cannot review change requests on this engagement.");
  const cr = await loadChangeRequest(engagementId, changeRequestId);
  if (cr.state !== "REQUESTED" && cr.state !== "CHANGES_REQUESTED") {
    throw new ApiError(409, "INVALID_STATE", "Only a requested change can be taken into review.");
  }
  // Four-eyes: a request can never be reviewed by its own author.
  if (cr.requestedById === ctx.user.id) throw forbiddenError("A change request cannot be reviewed by its author.");

  const updated = await prisma.engagementChangeRequest.update({ where: { id: cr.id }, data: { state: "IN_REVIEW" } });
  await appendLedgerEntry(ctx, engagement, role, {
    changeRequestId: cr.id,
    action: "CHANGE_REQUEST_REVIEW_STARTED",
    targetType: "changeRequest",
    targetId: cr.id,
    summary: `Review started by ${practiceRoleLabel(role)}`,
  });
  return changeRequestRowToView(updated);
}

/**
 * IN_REVIEW → APPROVED | CHANGES_REQUESTED | REJECTED.
 * Approving (or rejecting outright) is a sign-off: partner/manager only. A
 * reviewer may return the request for changes without signing off.
 */
export async function completeChangeReview(
  ctx: AuthContext,
  engagementId: string,
  changeRequestId: string,
  decision: "approve" | "request-changes" | "reject",
  reviewNote?: string | null,
): Promise<ChangeRequestView> {
  const minRole: PracticeRole = decision === "request-changes" ? "REVIEWER" : "MANAGER";
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, minRole);
  if (decision === "request-changes" && !canReview(role)) throw forbiddenError("You cannot review change requests.");
  if (decision !== "request-changes" && !canSignOff(role)) {
    throw forbiddenError("Only a partner or manager can sign off a change to client data.");
  }
  const cr = await loadChangeRequest(engagementId, changeRequestId);
  if (cr.state !== "IN_REVIEW") throw new ApiError(409, "INVALID_STATE", "Only an in-review request can be decided.");
  if (cr.requestedById === ctx.user.id && decision !== "request-changes") {
    throw forbiddenError("A change request cannot be signed off by its author.");
  }

  const nextState: ChangeRequestState =
    decision === "approve" ? "APPROVED" : decision === "reject" ? "REJECTED" : "CHANGES_REQUESTED";
  const note = reviewNote?.trim() || null;
  const updated = await prisma.engagementChangeRequest.update({
    where: { id: cr.id },
    data: { state: nextState, reviewNote: note },
  });
  await appendLedgerEntry(ctx, engagement, role, {
    changeRequestId: cr.id,
    action:
      decision === "approve"
        ? "CHANGE_REQUEST_APPROVED"
        : decision === "reject"
          ? "CHANGE_REQUEST_REJECTED"
          : "CHANGE_REQUEST_CHANGES_REQUESTED",
    targetType: "changeRequest",
    targetId: cr.id,
    summary: `${decision === "approve" ? "Approved" : decision === "reject" ? "Rejected" : "Changes requested"}: ${cr.title}`,
    meta: { reviewNote: note, decision, signOffRole: role },
  });
  return changeRequestRowToView(updated);
}

/** APPROVED → IMPLEMENTED. Requires a preparer role. */
export async function implementChangeRequest(
  ctx: AuthContext,
  engagementId: string,
  changeRequestId: string,
): Promise<ChangeRequestView> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  if (!canPrepareWork(role)) throw forbiddenError("Auditors cannot implement change requests.");
  const cr = await loadChangeRequest(engagementId, changeRequestId);
  if (cr.state !== "APPROVED") throw new ApiError(409, "INVALID_STATE", "Only an approved change can be implemented.");
  const updated = await prisma.engagementChangeRequest.update({ where: { id: cr.id }, data: { state: "IMPLEMENTED" } });
  await appendLedgerEntry(ctx, engagement, role, {
    changeRequestId: cr.id,
    action: "CHANGE_REQUEST_IMPLEMENTED",
    targetType: "changeRequest",
    targetId: cr.id,
    summary: `Implemented: ${cr.title}`,
  });
  return changeRequestRowToView(updated);
}

/** List an engagement's change requests (newest first). */
export async function listChangeRequests(ctx: AuthContext, engagementId: string): Promise<ChangeRequestView[]> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const rows = await prisma.engagementChangeRequest.findMany({
    where: { engagementId: engagement.id },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return rows.map(changeRequestRowToView);
}

/** Full history of one change request, reconstructed from the ledger. */
export async function getChangeRequestTimeline(
  ctx: AuthContext,
  engagementId: string,
  changeRequestId: string,
): Promise<{ request: ChangeRequestView; timeline: ChangeLogEntryView[] }> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const cr = await loadChangeRequest(engagement.id, changeRequestId);
  const rows = await prisma.engagementChangeLog.findMany({
    where: { engagementId: engagement.id, changeRequestId: cr.id },
    orderBy: { seq: "asc" },
  });
  return { request: changeRequestRowToView(cr), timeline: rows.map(changeLogRowToView) };
}

export { changeRequestRowToView };
export type { ChangeRequestRow };

// ---------------------------------------------------------------------------
// Working papers (SA 230)
// ---------------------------------------------------------------------------

export interface WorkingPaperVersionView {
  id: string;
  version: number;
  contentHash: string;
  changeSummary: string;
  preparedById: string;
  createdAt: string;
  content: unknown;
}

export interface WorkingPaperView {
  id: string;
  engagementId: string;
  indexRef: string;
  title: string;
  section: string | null;
  saReference: string | null;
  status: string;
  classification: DataClassification;
  version: number;
  contentHash: string | null;
  preparedById: string | null;
  preparedAt: string | null;
  reviewedById: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  signedOffById: string | null;
  signedOffAt: string | null;
  signOffRole: PracticeRole | null;
  createdAt: string;
  updatedAt: string;
}

type WorkingPaperRow = {
  id: string;
  engagementId: string;
  indexRef: string;
  title: string;
  section: string | null;
  saReference: string | null;
  status: string;
  classification: string;
  version: number;
  contentHash: string | null;
  preparedById: string | null;
  preparedAt: Date | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  signedOffById: string | null;
  signedOffAt: Date | null;
  signOffRole: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toWorkingPaperView(row: WorkingPaperRow): WorkingPaperView {
  return {
    id: row.id,
    engagementId: row.engagementId,
    indexRef: row.indexRef,
    title: row.title,
    section: row.section,
    saReference: row.saReference,
    status: row.status,
    classification: (row.classification as DataClassification) ?? "CONFIDENTIAL",
    version: row.version,
    contentHash: row.contentHash,
    preparedById: row.preparedById,
    preparedAt: row.preparedAt ? row.preparedAt.toISOString() : null,
    reviewedById: row.reviewedById,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewNote: row.reviewNote,
    signedOffById: row.signedOffById,
    signedOffAt: row.signedOffAt ? row.signedOffAt.toISOString() : null,
    signOffRole: normalizePracticeRole(row.signOffRole),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateWorkingPaperInput {
  indexRef: string;
  title: string;
  section?: string;
  saReference?: string;
  classification?: DataClassification;
  content?: unknown;
  changeSummary?: string;
}

/** Create a working paper with its first immutable version. */
export async function createWorkingPaper(
  ctx: AuthContext,
  engagementId: string,
  input: CreateWorkingPaperInput,
): Promise<WorkingPaperView> {
  const { role, engagement, project } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  if (!canPrepareWork(role)) throw forbiddenError("Auditors cannot create working papers.");

  const indexRef = (input.indexRef ?? "").trim();
  const title = (input.title ?? "").trim();
  if (!indexRef) throw new ApiError(400, "VALIDATION", "A working-paper index reference is required (e.g. B-200).");
  if (title.length < 3) throw new ApiError(400, "VALIDATION", "Give the working paper a descriptive title.");

  const existing = await prisma.workingPaper.findUnique({
    where: { engagementId_indexRef: { engagementId: engagement.id, indexRef } },
    select: { id: true },
  });
  if (existing)
    throw new ApiError(409, "DUPLICATE_REF", `A working paper with reference “${indexRef}” already exists.`);

  const content = input.content ?? {};
  const hash = contentHash(content);
  const row = await prisma.$transaction(async (tx) => {
    const wp = await tx.workingPaper.create({
      data: {
        organizationId: engagement.organizationId,
        engagementId: engagement.id,
        projectId: project?.id ?? null,
        indexRef,
        title,
        section: input.section?.trim() || null,
        saReference: input.saReference?.trim() || null,
        status: "DRAFT",
        classification: input.classification ?? "CONFIDENTIAL",
        version: 1,
        contentHash: hash,
        preparedById: ctx.user.id,
        preparedAt: new Date(),
      },
    });
    await tx.workingPaperVersion.create({
      data: {
        workingPaperId: wp.id,
        version: 1,
        content: JSON.stringify(content),
        contentHash: hash,
        changeSummary: input.changeSummary?.trim() || "Initial version",
        preparedById: ctx.user.id,
      },
    });
    return wp;
  });

  await appendLedgerEntry(ctx, engagement, role, {
    action: "WORKING_PAPER_CREATED",
    targetType: "workingPaper",
    targetId: row.id,
    summary: `Working paper ${indexRef} created: ${title}`,
    meta: { contentHash: hash, classification: row.classification },
  });
  return toWorkingPaperView(row);
}

/** Append a new immutable version. Forbidden once signed off or archived. */
export async function addWorkingPaperVersion(
  ctx: AuthContext,
  engagementId: string,
  workingPaperId: string,
  input: { content: unknown; changeSummary: string },
): Promise<WorkingPaperView> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  if (!canPrepareWork(role)) throw forbiddenError("Auditors cannot edit working papers.");
  const wp = await prisma.workingPaper.findFirst({ where: { id: workingPaperId, engagementId: engagement.id } });
  if (!wp) throw notFoundError("Working paper not found.");
  if (wp.status === "SIGNED_OFF" || wp.status === "ARCHIVED") {
    throw new ApiError(409, "INVALID_STATE", "A signed-off working paper cannot be edited.");
  }
  const changeSummary = (input.changeSummary ?? "").trim();
  if (changeSummary.length < 3) throw new ApiError(400, "VALIDATION", "Describe what changed in this revision.");
  const hash = contentHash(input.content);
  const version = wp.version + 1;

  const row = await prisma.$transaction(async (tx) => {
    await tx.workingPaperVersion.create({
      data: {
        workingPaperId: wp.id,
        version,
        content: JSON.stringify(input.content),
        contentHash: hash,
        changeSummary,
        preparedById: ctx.user.id,
      },
    });
    return tx.workingPaper.update({
      where: { id: wp.id },
      data: {
        version,
        contentHash: hash,
        status: "DRAFT",
        preparedById: ctx.user.id,
        preparedAt: new Date(),
        // A new revision invalidates any prior review/sign-off.
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
        signedOffById: null,
        signedOffAt: null,
        signOffRole: null,
      },
    });
  });

  await appendLedgerEntry(ctx, engagement, role, {
    action: "WORKING_PAPER_REVISED",
    targetType: "workingPaper",
    targetId: wp.id,
    summary: `${wp.indexRef} v${version}: ${changeSummary}`,
    rawSummary: changeSummary,
    meta: { version, contentHash: hash },
  });
  return toWorkingPaperView(row);
}

/** DRAFT | REVIEWED → IN_REVIEW. */
export async function submitWorkingPaper(
  ctx: AuthContext,
  engagementId: string,
  workingPaperId: string,
): Promise<WorkingPaperView> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  if (!canPrepareWork(role)) throw forbiddenError("Auditors cannot submit working papers.");
  const wp = await prisma.workingPaper.findFirst({ where: { id: workingPaperId, engagementId: engagement.id } });
  if (!wp) throw notFoundError("Working paper not found.");
  if (wp.status !== "DRAFT" && wp.status !== "REVIEWED") {
    throw new ApiError(409, "INVALID_STATE", "Only a draft or reviewed working paper can be submitted.");
  }
  const updated = await prisma.workingPaper.update({
    where: { id: wp.id },
    data: {
      status: "IN_REVIEW",
      preparedById: wp.preparedById ?? ctx.user.id,
      preparedAt: wp.preparedAt ?? new Date(),
    },
  });
  await appendLedgerEntry(ctx, engagement, role, {
    action: "WORKING_PAPER_SUBMITTED",
    targetType: "workingPaper",
    targetId: wp.id,
    summary: `${wp.indexRef} submitted for review (v${wp.version})`,
  });
  return toWorkingPaperView(updated);
}

/** IN_REVIEW → REVIEWED (approved) or DRAFT (changes requested). */
export async function reviewWorkingPaper(
  ctx: AuthContext,
  engagementId: string,
  workingPaperId: string,
  input: { approved: boolean; note?: string | null },
): Promise<WorkingPaperView> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "REVIEWER");
  if (!canReview(role)) throw forbiddenError("You cannot review working papers on this engagement.");
  const wp = await prisma.workingPaper.findFirst({ where: { id: workingPaperId, engagementId: engagement.id } });
  if (!wp) throw notFoundError("Working paper not found.");
  if (wp.status !== "IN_REVIEW")
    throw new ApiError(409, "INVALID_STATE", "Only an in-review working paper can be reviewed.");
  // Four-eyes is absolute on review — unlike sign-off, the engagement partner is
  // NOT exempt, because review is the independent check on the preparer's work
  // (SA 230). The partner can still sign the paper off afterwards.
  if (wp.preparedById === ctx.user.id) {
    throw forbiddenError("A working paper cannot be reviewed by its preparer.");
  }
  const note = input.note?.trim() || null;
  const updated = await prisma.workingPaper.update({
    where: { id: wp.id },
    data: {
      status: input.approved ? "REVIEWED" : "DRAFT",
      reviewedById: input.approved ? ctx.user.id : null,
      reviewedAt: input.approved ? new Date() : null,
      reviewNote: note,
    },
  });
  await appendLedgerEntry(ctx, engagement, role, {
    action: input.approved ? "WORKING_PAPER_REVIEWED" : "WORKING_PAPER_CHANGES_REQUESTED",
    targetType: "workingPaper",
    targetId: wp.id,
    summary: `${wp.indexRef} v${wp.version} ${input.approved ? "reviewed" : "returned for changes"}`,
    meta: { reviewNote: note, reviewerRole: role },
  });
  return toWorkingPaperView(updated);
}

/** REVIEWED → SIGNED_OFF. Partner/manager only; four-eyes on the preparer. */
export async function signOffWorkingPaper(
  ctx: AuthContext,
  engagementId: string,
  workingPaperId: string,
  note?: string | null,
): Promise<WorkingPaperView> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "MANAGER");
  if (!canSignOff(role)) throw forbiddenError("Only a partner or manager can sign off a working paper.");
  const wp = await prisma.workingPaper.findFirst({ where: { id: workingPaperId, engagementId: engagement.id } });
  if (!wp) throw notFoundError("Working paper not found.");
  if (wp.status !== "REVIEWED")
    throw new ApiError(409, "INVALID_STATE", "Only a reviewed working paper can be signed off.");
  if (wp.preparedById === ctx.user.id && role !== "PARTNER") {
    throw forbiddenError("A working paper cannot be signed off by its preparer unless you are the engagement partner.");
  }
  const updated = await prisma.workingPaper.update({
    where: { id: wp.id },
    data: {
      status: "SIGNED_OFF",
      signedOffById: ctx.user.id,
      signedOffAt: new Date(),
      signOffRole: role,
      reviewNote: note?.trim() || wp.reviewNote,
    },
  });
  await appendLedgerEntry(ctx, engagement, role, {
    action: "WORKING_PAPER_SIGNED_OFF",
    targetType: "workingPaper",
    targetId: wp.id,
    summary: `${wp.indexRef} v${wp.version} signed off by ${practiceRoleLabel(role)}`,
    meta: { signOffRole: role, note: note?.trim() || null, contentHash: wp.contentHash },
  });
  return toWorkingPaperView(updated);
}

/** SIGNED_OFF → ARCHIVED. */
export async function archiveWorkingPaper(
  ctx: AuthContext,
  engagementId: string,
  workingPaperId: string,
): Promise<WorkingPaperView> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "MANAGER");
  if (!canSignOff(role)) throw forbiddenError("Only a partner or manager can archive a working paper.");
  const wp = await prisma.workingPaper.findFirst({ where: { id: workingPaperId, engagementId: engagement.id } });
  if (!wp) throw notFoundError("Working paper not found.");
  if (wp.status !== "SIGNED_OFF")
    throw new ApiError(409, "INVALID_STATE", "Only a signed-off working paper can be archived.");
  const updated = await prisma.workingPaper.update({ where: { id: wp.id }, data: { status: "ARCHIVED" } });
  await appendLedgerEntry(ctx, engagement, role, {
    action: "WORKING_PAPER_ARCHIVED",
    targetType: "workingPaper",
    targetId: wp.id,
    summary: `${wp.indexRef} archived`,
  });
  return toWorkingPaperView(updated);
}

/** List working papers for an engagement. */
export async function listWorkingPapers(ctx: AuthContext, engagementId: string): Promise<WorkingPaperView[]> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const rows = await prisma.workingPaper.findMany({
    where: { engagementId: engagement.id },
    orderBy: [{ indexRef: "asc" }],
    take: 500,
  });
  return rows.map(toWorkingPaperView);
}

/** One working paper with its version chain and ledger timeline. */
export async function getWorkingPaper(
  ctx: AuthContext,
  engagementId: string,
  workingPaperId: string,
): Promise<{ workingPaper: WorkingPaperView; versions: WorkingPaperVersionView[]; timeline: ChangeLogEntryView[] }> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const wp = await prisma.workingPaper.findFirst({ where: { id: workingPaperId, engagementId: engagement.id } });
  if (!wp) throw notFoundError("Working paper not found.");
  const [versions, timeline] = await Promise.all([
    prisma.workingPaperVersion.findMany({ where: { workingPaperId: wp.id }, orderBy: { version: "desc" } }),
    prisma.engagementChangeLog.findMany({
      where: { engagementId: engagement.id, targetType: "workingPaper", targetId: wp.id },
      orderBy: { seq: "asc" },
    }),
  ]);
  return {
    workingPaper: toWorkingPaperView(wp),
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      contentHash: v.contentHash,
      changeSummary: v.changeSummary,
      preparedById: v.preparedById,
      createdAt: v.createdAt.toISOString(),
      content: parseJson<unknown>(v.content, null),
    })),
    timeline: timeline.map(changeLogRowToView),
  };
}

/**
 * SA 230 binder completeness: for each standard working-paper reference, is
 * there a signed-off paper? A missing reference is what a reviewer checks for.
 */
export const STANDARD_WORKING_PAPER_REFS: readonly { ref: string; sa: string; title: string }[] = [
  { ref: "A-100", sa: "SA 210", title: "Engagement terms & acceptance" },
  { ref: "A-200", sa: "SA 315", title: "Understanding of the entity & risk assessment" },
  { ref: "A-300", sa: "SA 320", title: "Materiality determination" },
  { ref: "B-100", sa: "SA 330", title: "Responses to assessed risks / tests of controls" },
  { ref: "B-200", sa: "SA 500", title: "Audit evidence — substantive procedures" },
  { ref: "B-300", sa: "SA 505", title: "External confirmations" },
  { ref: "C-100", sa: "SA 560", title: "Subsequent events review" },
  { ref: "C-200", sa: "SA 570", title: "Going-concern assessment" },
  { ref: "D-100", sa: "SA 700", title: "Draft opinion & report" },
  { ref: "D-200", sa: "SA 230", title: "Review of audit working papers" },
];

export interface WorkingPaperIndexStatus {
  entries: { ref: string; sa: string; title: string; status: "missing" | "prepared" | "signed-off" }[];
  signedOffCount: number;
  complete: boolean;
  missingRefs: string[];
}

export async function workingPaperIndexStatus(
  ctx: AuthContext,
  engagementId: string,
): Promise<WorkingPaperIndexStatus> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const rows = await prisma.workingPaper.findMany({
    where: { engagementId: engagement.id },
    select: { indexRef: true, status: true },
  });
  const byRef = new Map(rows.map((r) => [r.indexRef, r.status]));
  const entries = STANDARD_WORKING_PAPER_REFS.map((e) => {
    const status = byRef.get(e.ref);
    const state: "missing" | "prepared" | "signed-off" = status
      ? status === "SIGNED_OFF" || status === "ARCHIVED"
        ? "signed-off"
        : "prepared"
      : "missing";
    return { ...e, status: state };
  });
  const missingRefs = entries.filter((e) => e.status !== "signed-off").map((e) => e.ref);
  return {
    entries,
    signedOffCount: entries.length - missingRefs.length,
    complete: missingRefs.length === 0,
    missingRefs,
  };
}

/** Assert a caller has at least `min` standing without loading extra context. */
export async function requireEngagementAccessForRow(
  ctx: AuthContext,
  engagement: EngagementRow,
  project: EngagementProject | null | undefined,
  min: PracticeRole,
): Promise<PracticeRole> {
  return requireEngagementAccess(ctx, engagement, project ?? null, min);
}

/** Re-exported for callers that already hold the resolved role. */
export function roleAtLeast(role: PracticeRole, min: PracticeRole): boolean {
  return practiceRank(role) >= practiceRank(min);
}

/**
 * Convenience used by route handlers: resolve an engagement in the caller's org
 * and return the caller's role, without asserting a minimum.
 */
export async function resolveEngagement(
  ctx: AuthContext,
  engagementId: string,
): Promise<{ role: PracticeRole; engagement: EngagementRow; project: EngagementProject | null }> {
  const { engagement, project } = await loadEngagement(ctx, engagementId);
  const role = await engagementPracticeRole(ctx, engagement, project);
  if (!role) throw notFoundError("Engagement not found.");
  return { role, engagement, project };
}
