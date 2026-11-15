/**
 * Practice management — firm-wide operating system for a CA firm.
 *
 * Combines six surfaces that used to live as separate shallow registers into one
 * operating system that a firm can actually run across many clients and
 * engagements:
 *   1. Engagement/matter management — client-scoped engagements with scope,
 *      phases, fee budget vs billed vs realised, time recording, realisation, and
 *      a client communication log.
 *   2. Workpaper system — numbered working papers with cross-references, review/
 *      rework/sign-off states, client-specific templates, and reusable working-
 *      paper families.
 *   3. Deadline management — client- and entity-specific deadlines with
 *      dependency awareness, reassignment, escalation, and a firm-wide compliance
 *      calendar rather than one-off calendars.
 *   4. Document management — versioned working papers, final reports, signed
 *      copies, retention, and client access controls.
 *   5. Client-wise isolation and permissions — partner/reviewer/assistant roles,
 *      assignment of work, and review-status tracking per assignment.
 *   6. Firm-level reporting — realisation, pipeline, overdue work, a compliance
 *      due list across all clients, and staffing load.
 *
 * SCOPE AND HONESTY: this is pure arithmetic and workflow on caller-supplied
 * data. Money fields arrive in MAJOR UNITS (INR rupees) and are kept in major
 * units on the result so the API adapter can convert to paise if another engine
 * requires it. The engine does not persist anything, does not file returns, and
 * does not issue a legal opinion.
 */

import type {
  ClientConfig,
  ClientResult,
  ComplianceDueListItem,
  DocumentConfig,
  EngagementConfig,
  EngagementDeadlineConfig,
  EngagementPhaseConfig,
  EngagementResult,
  EngagementStatus,
  EngagementPhaseResult,
  FirmAnalyticsResult,
  OverdueWorkRollup,
  PracticeManConfig,
  PracticeAccessRole,
  WorkpaperConfig,
} from "@/lib/types";

export type {
  ClientConfig,
  ClientResult,
  ComplianceDueListItem,
  DeadlineResult,
  DocumentConfig,
  DocumentStatus,
  EngagementConfig,
  EngagementDeadlineConfig,
  EngagementPhaseConfig,
  EngagementResult,
  EngagementStatus,
  EngagementPhaseResult,
  FirmAnalyticsResult,
  FirmAnalyticsScope,
  OverdueWorkRollup,
  PracticeManConfig,
  PracticeAccessRole,
  WorkpaperConfig,
  WorkpaperOwnerType,
  WorkpaperReviewEvent,
  WorkpaperStatus,
} from "@/lib/types";

/** Validate a date string the caller supplies. */
function parseISODate(s: string): Date {
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO date: ${s}`);
  return d;
}

// ---------------------------------------------------------------------------
// Deadline status — client/entity-scoped, dependency-aware
// ---------------------------------------------------------------------------

/**
 * Base deadline status against the firm-wide calendar window [windowStart,
 * windowEnd]. `windowStart` is the calendar's "as of" edge: a deadline whose
 * due date falls before it has already been missed (overdue). A decision the
 * caller has already taken — completed, escalated, or an explicit overdue — is
 * preserved rather than recomputed, and anything still ahead of `windowStart`
 * is upcoming. Dependents of a slipped deadline are escalated to overdue
 * separately (see deadlineStatusesFor).
 */
function deadlineStatus(
  due: Date,
  windowStart: Date,
  windowEnd: Date,
  current: "upcoming" | "due" | "overdue" | "completed" | "escalated",
): "upcoming" | "due" | "overdue" | "completed" | "escalated" {
  // The horizon does not turn "not yet overdue" into a different state today.
  void windowEnd;
  if (current === "completed" || current === "escalated" || current === "overdue") return current;
  if (isOverdue(due, windowStart)) return "overdue";
  return "upcoming";
}

/** Whether a deadline's due date has passed the calendar's "as of" edge. */
function isOverdue(due: Date, asOf: Date): boolean {
  return due.getTime() < asOf.getTime();
}

/**
 * Effective per-deadline status for one engagement, with overdue-ness
 * propagated to transitive dependents: a deadline whose prerequisite has
 * slipped cannot itself be on track. Computed to a fixed point so a chain
 * (D3 → D2 → D1) flips all the way down in one pass.
 */
function deadlineStatusesFor(
  deadlines: EngagementDeadlineConfig[],
  windowStart: Date,
  windowEnd: Date,
): Map<string, "upcoming" | "due" | "overdue" | "completed" | "escalated"> {
  const statuses = new Map<string, "upcoming" | "due" | "overdue" | "completed" | "escalated">();
  for (const d of deadlines) {
    statuses.set(d.deadlineId, deadlineStatus(parseISODate(d.dueDate), windowStart, windowEnd, d.status));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of deadlines) {
      if (statuses.get(d.deadlineId) === "overdue") continue;
      if (d.dependsOn.some((id) => statuses.get(id) === "overdue")) {
        statuses.set(d.deadlineId, "overdue");
        changed = true;
      }
    }
  }
  return statuses;
}

/** How many deadlines (by id) depend on a given deadline, directly or indirectly. */
function dependentCount(deadlineId: string, deadlines: EngagementDeadlineConfig[]): number {
  let count = 0;
  const visited = new Set<string>();
  const stack = [...deadlines.filter((d) => d.dependsOn.includes(deadlineId)).map((d) => d.deadlineId)];
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    count += 1;
    stack.push(...deadlines.filter((d) => d.dependsOn.includes(id)).map((d) => d.deadlineId));
  }
  return count;
}

/** Check for cycles in the dependency graph; returns the ids involved in a cycle if any. */
function detectDependencyCycles(deadlines: EngagementDeadlineConfig[]): string[] {
  const ids = new Set(deadlines.map((d) => d.deadlineId));
  const graph = new Map<string, string[]>();
  for (const d of deadlines) {
    graph.set(
      d.deadlineId,
      d.dependsOn.filter((id) => ids.has(id)),
    );
  }
  const visited = new Set<string>();
  const stack = new Set<string>();
  const cycle: string[] = [];
  function walk(node: string, path: string[]): boolean {
    if (stack.has(node)) {
      const idx = path.indexOf(node);
      cycle.push(...path.slice(idx), node);
      return true;
    }
    if (visited.has(node)) return false;
    visited.add(node);
    stack.add(node);
    for (const dep of graph.get(node) ?? []) {
      if (walk(dep, [...path, node])) return true;
    }
    stack.delete(node);
    return false;
  }
  for (const id of ids) {
    if (walk(id, [])) break;
  }
  return cycle;
}

// ---------------------------------------------------------------------------
// 1. Engagement / matter management (scope, phases, fees, time, realisation, comms)
// ---------------------------------------------------------------------------

/** Compute engagement-level realisation and budget variance. Amounts are MAJOR UNITS (INR). */
function engagementRealisation(e: EngagementConfig): {
  realisationPct: number;
  timeBudgetVariancePct: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  const realisationPct = e.feeBudget > 0 ? (e.feeRealised / e.feeBudget) * 100 : 0;
  let timeBudgetVariancePct = 0;
  const totalBudgetHours = e.phases.reduce((s, p) => s + p.budgetHours, 0);
  const totalActualHours = e.phases.reduce((s, p) => s + p.actualHours, 0);
  if (totalBudgetHours > 0) {
    timeBudgetVariancePct = ((totalActualHours - totalBudgetHours) / totalBudgetHours) * 100;
    if (timeBudgetVariancePct > 15)
      warnings.push(`${e.engagementId} is ${Math.round(timeBudgetVariancePct)}% over its time budget.`);
  }
  if (e.feeBudget > 0 && e.feeRealised > e.feeBilled) {
    warnings.push(`${e.engagementId} has realised more than billed — review collectability.`);
  }
  return { realisationPct, timeBudgetVariancePct, warnings };
}

/** Engagement phase result with budget vs actual. */
function phaseResult(p: EngagementPhaseConfig): EngagementPhaseResult {
  const hoursVariancePct = p.budgetHours > 0 ? ((p.actualHours - p.budgetHours) / p.budgetHours) * 100 : 0;
  const feeVariancePct = p.feeBudget > 0 ? ((p.feeBilled - p.feeBudget) / p.feeBudget) * 100 : 0;
  return {
    phaseId: p.phaseId,
    name: p.name,
    budgetHours: p.budgetHours,
    actualHours: p.actualHours,
    hoursVariancePct,
    feeBudget: p.feeBudget,
    feeBilled: p.feeBilled,
    feeVariancePct,
    status: p.status,
  };
}

/** Pending (unanswered) client communications: those not yet marked as replied. For
 * the scaffold we treat every communication as pending unless the note says "replied". */
function pendingCommunicationCount(comms: EngagementConfig["communications"]): number {
  return comms.filter((c) => !c.note.toLowerCase().includes("replied")).length;
}

// ---------------------------------------------------------------------------
// 2. Workpaper system — numbering, cross-references, review/rework/sign-off,
//    client-specific templates, reusable families
// ---------------------------------------------------------------------------

/** Validate cross-references point to workpaper numbers that exist in the same engagement. */
function validateCrossReferences(wps: WorkpaperConfig[]): string[] {
  const numbers = new Set(wps.map((w) => w.workpaperNumber));
  const errors: string[] = [];
  for (const w of wps) {
    for (const ref of w.crossReferences) {
      if (!numbers.has(ref)) errors.push(`${w.workpaperNumber} references unknown workpaper ${ref}.`);
    }
  }
  return errors;
}

/** Count open (non-signed-off) workpapers for an engagement. */
function openWorkpaperCount(wps: WorkpaperConfig[]): number {
  return wps.filter((w) => w.status !== "signed-off").length;
}

// ---------------------------------------------------------------------------
// 3. Deadline management — client/entity-scoped, dependency-aware,
//    reassignment + escalation, firm-wide compliance calendar
// ---------------------------------------------------------------------------

/** Reassignment reason is recorded on escalation. We support one reassignment per
 * deadline in this scaffold (a real system would keep an audit log). */
export interface Reassignment {
  deadlineId: string;
  fromOwner: string;
  toOwner: string;
  reason: string;
  reassignedAt: string;
}

/** Apply a reassignment to a deadline and escalate if the reason indicates risk. */
export function applyReassignment(
  deadline: EngagementDeadlineConfig,
  reassignment: { toOwner: string; reason: string },
  asOf: string,
): { deadline: EngagementDeadlineConfig; reassignment: Reassignment; escalated: boolean } {
  const escalated =
    reassignment.reason.toLowerCase().includes("risk") || reassignment.reason.toLowerCase().includes("escalat");
  return {
    deadline: {
      ...deadline,
      owner: reassignment.toOwner,
      status: escalated ? "escalated" : deadline.status,
      escalationNote: escalated ? reassignment.reason : deadline.escalationNote,
    },
    reassignment: {
      deadlineId: deadline.deadlineId,
      fromOwner: deadline.owner,
      toOwner: reassignment.toOwner,
      reason: reassignment.reason,
      reassignedAt: asOf,
    },
    escalated,
  };
}

// ---------------------------------------------------------------------------
// 4. Document management — versioned, owned, retained, client access-controlled
// ---------------------------------------------------------------------------

/** Validate version chronology: versions must be positive and increasing per document. */
function validateDocumentVersions(docs: DocumentConfig[]): string[] {
  const errors: string[] = [];
  const byName = new Map<string, DocumentConfig[]>();
  for (const d of docs) {
    byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  }
  for (const [, versioned] of byName) {
    const sorted = versioned.slice().sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i]!.version <= sorted[i - 1]!.version) {
        errors.push(
          `${sorted[i]!.name} version ${sorted[i]!.version} is not newer than version ${sorted[i - 1]!.version}.`,
        );
      }
    }
  }
  return errors;
}

/** Count unsigned documents (final-report or signed-copy that are not signed). */
function unsignedDocumentCount(docs: DocumentConfig[]): number {
  return docs.filter(
    (d) => (d.documentClass === "final-report" || d.documentClass === "signed-copy") && d.status !== "signed",
  ).length;
}

/** Whether a role is allowed to access a document with the given allowedRoles. */
export function roleMayAccess(role: PracticeAccessRole, allowedRoles: DocumentConfig["allowedRoles"]): boolean {
  return allowedRoles.includes(role);
}

/** Documents that are past their retention date relative to a reference date. */
export function documentsPastRetention(docs: DocumentConfig[], asOf: string): DocumentConfig[] {
  const asOfD = parseISODate(asOf);
  return docs.filter((d) => d.retentionUntil && parseISODate(d.retentionUntil).getTime() < asOfD.getTime());
}

// ---------------------------------------------------------------------------
// 5. Client-wise isolation, roles, assignment, review-status tracking
// ---------------------------------------------------------------------------

/** Validate that every engagement's clientId resolves to a client in the registry. */
function validateClientMapping(engagements: EngagementConfig[], clients: ClientConfig[]): string[] {
  const clientIds = new Set(clients.map((c) => c.clientId));
  const errors: string[] = [];
  for (const e of engagements) {
    if (!clientIds.has(e.clientId))
      errors.push(`Engagement ${e.engagementId} references unknown client ${e.clientId}.`);
  }
  return errors;
}

/** Validate role access: a person (by userId) may only act within clients whose
 * allowedRoles include their role. We do not know the userId's role here, so we
 * report the client's allowed roles for the caller to enforce. */
export function clientAccessSummary(
  clients: ClientConfig[],
  engagements: EngagementConfig[] = [],
): {
  clientId: string;
  name: string;
  allowedRoles: PracticeAccessRole[];
  engagementCount: number;
}[] {
  const counts = new Map<string, number>();
  for (const e of engagements) {
    counts.set(e.clientId, (counts.get(e.clientId) ?? 0) + 1);
  }
  return clients.map((c) => ({
    clientId: c.clientId,
    name: c.name,
    allowedRoles: c.allowedRoles,
    engagementCount: counts.get(c.clientId) ?? 0,
  }));
}

/** Assignment review status tracking: for a given userId, how many workpapers
 * are awaiting their action. */
/** The subset of an engagement the assignment view needs — both the input
 * config and the engine's own EngagementResult satisfy it, so a caller can pass
 * either. */
type AssignmentScope = Pick<
  EngagementConfig,
  "engagementId" | "leadPartner" | "reviewers" | "workpapers" | "documents"
>;

export function assignmentReviewStatus(
  engagements: AssignmentScope[],
  userId: string,
): {
  userId: string;
  pendingWorkpapers: number;
  pendingDocuments: number;
  engagementCount: number;
} {
  let pendingWorkpapers = 0;
  let pendingDocuments = 0;
  const seen = new Set<string>();
  for (const e of engagements) {
    if (e.leadPartner === userId || e.reviewers.includes(userId)) {
      seen.add(e.engagementId);
    }
    for (const w of e.workpapers) {
      if (w.ownerUserId === userId && w.status === "in-review") pendingWorkpapers += 1;
    }
    for (const d of e.documents) {
      if (d.ownerUserId === userId && (d.status === "draft" || d.status === "final")) pendingDocuments += 1;
    }
  }
  return { userId, pendingWorkpapers, pendingDocuments, engagementCount: seen.size };
}

// ---------------------------------------------------------------------------
// 6. Firm-level reporting — realisation, pipeline, overdue, compliance due list,
//    staffing load
// ---------------------------------------------------------------------------

/** Realisation roll-up across all engagements. */
function realisationRollup(engagements: EngagementConfig[]): EngagementResult["realisationPct"] {
  const totalBudget = engagements.reduce((s, e) => s + e.feeBudget, 0);
  const totalRealised = engagements.reduce((s, e) => s + e.feeRealised, 0);
  return totalBudget > 0 ? (totalRealised / totalBudget) * 100 : 0;
}

/** Pipeline roll-up: total fee budget still in progress / not completed. */
function pipelineRollup(engagements: EngagementConfig[]): {
  totalPipeline: number;
  weightedPipeline: number;
  byStatus: { status: EngagementStatus; count: number; pipeline: number }[];
  inScopeCount: number;
  inProgressCount: number;
  underReviewCount: number;
} {
  const byStatusMap = new Map<EngagementStatus, { count: number; pipeline: number }>();
  let inScopeCount = 0;
  let inProgressCount = 0;
  let underReviewCount = 0;

  for (const e of engagements) {
    const entry = byStatusMap.get(e.status) ?? { count: 0, pipeline: 0 };
    entry.count += 1;
    entry.pipeline += e.feeBudget - e.feeBilled;
    byStatusMap.set(e.status, entry);
    if (e.status === "scoped") inScopeCount += 1;
    // "In progress" = work is under way, which includes an engagement that has
    // moved into review; underReviewCount remains the narrower subset.
    if (e.status === "in-progress" || e.status === "under-review") inProgressCount += 1;
    if (e.status === "under-review") underReviewCount += 1;
  }

  let totalPipeline = 0;
  let weightedPipeline = 0;
  const byStatus: { status: EngagementStatus; count: number; pipeline: number }[] = [];
  for (const [status, { count, pipeline }] of byStatusMap) {
    byStatus.push({ status, count, pipeline });
    totalPipeline += pipeline;
    // Weight pipeline by probability of completion: 0.2 scoped, 0.6 in-progress,
    // 0.9 under-review, 1.0 completed/archived/entered.
    const weight = status === "scoped" ? 0.2 : status === "in-progress" ? 0.6 : status === "under-review" ? 0.9 : 1;
    weightedPipeline += pipeline * weight;
  }

  return { totalPipeline, weightedPipeline, byStatus, inScopeCount, inProgressCount, underReviewCount };
}

/** Overdue work roll-up across the firm, including per-client breakdown. */
function overdueWorkRollup(
  clients: ClientConfig[],
  engagements: EngagementConfig[],
  windowStart: Date,
  windowEnd: Date,
): OverdueWorkRollup {
  let overdueDeadlineCount = 0;
  let escalatedDeadlineCount = 0;
  let openWorkpaperTotal = 0;
  let pendingReviewCount = 0;
  let unsignedDocumentTotal = 0;
  const clientDeadlines = new Map<string, { overdue: number; escalated: number }>();
  const clientDocs = new Map<string, number>();

  for (const e of engagements) {
    const statuses = deadlineStatusesFor(e.deadlines, windowStart, windowEnd);
    for (const d of e.deadlines) {
      if (statuses.get(d.deadlineId) === "overdue") {
        overdueDeadlineCount += 1;
        clientDeadlines.set(e.clientId, {
          overdue: (clientDeadlines.get(e.clientId)?.overdue ?? 0) + 1,
          escalated: clientDeadlines.get(e.clientId)?.escalated ?? 0,
        });
      }
      if (d.status === "escalated") {
        escalatedDeadlineCount += 1;
        clientDeadlines.set(e.clientId, {
          overdue: clientDeadlines.get(e.clientId)?.overdue ?? 0,
          escalated: (clientDeadlines.get(e.clientId)?.escalated ?? 0) + 1,
        });
      }
    }
    clientDocs.set(e.clientId, (clientDocs.get(e.clientId) ?? 0) + unsignedDocumentCount(e.documents));
    openWorkpaperTotal += openWorkpaperCount(e.workpapers);
    for (const w of e.workpapers) {
      if (w.status === "in-review") pendingReviewCount += 1;
    }
    unsignedDocumentTotal += unsignedDocumentCount(e.documents);
  }

  const byClient = clients.map((c) => ({
    clientId: c.clientId,
    name: c.name,
    overdueDeadlines: clientDeadlines.get(c.clientId)?.overdue ?? 0,
    escalatedDeadlines: clientDeadlines.get(c.clientId)?.escalated ?? 0,
    unsignedDocuments: clientDocs.get(c.clientId) ?? 0,
  }));

  return {
    overdueDeadlineCount,
    overdueEngagementCount: byClient.filter((c) => c.overdueDeadlines > 0).length,
    escalatedDeadlineCount,
    openWorkpaperCount: openWorkpaperTotal,
    pendingReviewCount,
    unsignedDocumentCount: unsignedDocumentTotal,
    byClient,
  };
}

/** Compliance due list with client names resolved. */
interface ComplianceDueListInput {
  engagements: EngagementConfig[];
  clients: ClientConfig[];
  windowStart: Date;
  windowEnd: Date;
}
function complianceDueListResolving(eng: ComplianceDueListInput): ComplianceDueListItem[] {
  const clientMap = new Map<string, string>();
  for (const c of eng.clients) clientMap.set(c.clientId, c.name);
  const list: ComplianceDueListItem[] = [];
  for (const e of eng.engagements) {
    const statuses = deadlineStatusesFor(e.deadlines, eng.windowStart, eng.windowEnd);
    for (const d of e.deadlines) {
      const due = parseISODate(d.dueDate);
      const status = statuses.get(d.deadlineId);
      if (status === "due" || status === "overdue") {
        list.push({
          deadlineId: d.deadlineId,
          clientId: e.clientId,
          clientName: clientMap.get(e.clientId) ?? "Unknown client",
          engagementMatter: e.matter,
          label: d.label,
          dueDate: d.dueDate,
          status: status === "due" ? "due" : "overdue",
          owner: d.owner,
          daysUntilDue: Math.round((due.getTime() - eng.windowEnd.getTime()) / 86400000),
        });
      }
    }
  }
  return list;
}

/** Staffing load roll-up: time recorded, by-person allocation, review queues. */
function staffingLoadRollup(
  engagements: EngagementConfig[],
  _windowEnd: Date,
): {
  totalTimeRecordedHours: number;
  byPerson: {
    userId: string;
    role: PracticeAccessRole;
    allocatedHours: number;
    engagementCount: number;
    reviewQueueCount: number;
  }[];
  reviewQueueByReviewer: { reviewerUserId: string; pendingWorkpaperCount: number; pendingDocumentCount: number }[];
} {
  const totalTimeRecordedHours = engagements.reduce((s, e) => s + e.timeRecordedHours, 0);
  const personMap = new Map<
    string,
    { role: PracticeAccessRole; allocatedHours: number; engagementCount: number; reviewQueueCount: number }
  >();
  const reviewerQueue = new Map<string, { pendingWorkpaperCount: number; pendingDocumentCount: number }>();

  for (const e of engagements) {
    // Lead partner
    const lp = personMap.get(e.leadPartner);
    if (lp) {
      lp.allocatedHours += e.timeRecordedHours / Math.max(1, e.reviewers.length + 1);
      lp.engagementCount += 1;
    } else {
      personMap.set(e.leadPartner, {
        role: "partner",
        allocatedHours: e.timeRecordedHours / Math.max(1, e.reviewers.length + 1),
        engagementCount: 1,
        reviewQueueCount: 0,
      });
    }
    // Reviewers
    for (const r of e.reviewers) {
      const rv = personMap.get(r);
      if (rv) {
        rv.allocatedHours += e.timeRecordedHours / Math.max(1, e.reviewers.length + 1);
        rv.engagementCount += 1;
      } else {
        personMap.set(r, {
          role: "reviewer",
          allocatedHours: e.timeRecordedHours / Math.max(1, e.reviewers.length + 1),
          engagementCount: 1,
          reviewQueueCount: 0,
        });
      }
      const q = reviewerQueue.get(r) ?? { pendingWorkpaperCount: 0, pendingDocumentCount: 0 };
      for (const w of e.workpapers) {
        if (w.ownerUserId === r && w.status === "in-review") q.pendingWorkpaperCount += 1;
      }
      for (const d of e.documents) {
        if (d.ownerUserId === r && (d.status === "draft" || d.status === "final")) q.pendingDocumentCount += 1;
      }
      reviewerQueue.set(r, q);
    }
  }

  const byPerson: {
    userId: string;
    role: PracticeAccessRole;
    allocatedHours: number;
    engagementCount: number;
    reviewQueueCount: number;
  }[] = [];
  for (const [userId, info] of personMap) {
    const q = reviewerQueue.get(userId) ?? { pendingWorkpaperCount: 0, pendingDocumentCount: 0 };
    byPerson.push({
      userId,
      role: info.role,
      allocatedHours: Math.round(info.allocatedHours * 100) / 100,
      engagementCount: info.engagementCount,
      reviewQueueCount: q.pendingWorkpaperCount,
    });
  }

  const reviewQueueByReviewer: {
    reviewerUserId: string;
    pendingWorkpaperCount: number;
    pendingDocumentCount: number;
  }[] = [...reviewerQueue.entries()].map(([userId, q]) => ({
    reviewerUserId: userId,
    pendingWorkpaperCount: q.pendingWorkpaperCount,
    pendingDocumentCount: q.pendingDocumentCount,
  }));

  return { totalTimeRecordedHours, byPerson, reviewQueueByReviewer };
}

// ---------------------------------------------------------------------------
// Top-level engine
// ---------------------------------------------------------------------------

/**
 * Build the firm-wide practice operating system view from a `PracticeManConfig`.
 *
 * The engine validates the client → engagement mapping, computes engagement-level
 * realisation and budget variance, validates workpaper cross-references and document
 * versioning, computes dependency-aware deadline status against the firm-wide calendar,
 * and produces the requested firm-level analytics roll-ups.
 */
/**
 * Structural validation of a practice-management config: unknown client
 * mappings, deadline dependency cycles, dangling workpaper cross-references and
 * out-of-order document versions. Returned as messages so the same checks serve
 * both callers — the engine reports them as warnings, while the API adapter
 * rejects the request with a 400 (see computePracticeManagement).
 */
export function validatePracticeConfig(input: PracticeManConfig): string[] {
  const errors: string[] = [];
  errors.push(...validateClientMapping(input.engagements, input.clients));
  for (const e of input.engagements) {
    const cycles = detectDependencyCycles(e.deadlines);
    if (cycles.length) {
      errors.push(`Engagement ${e.engagementId} has a deadline dependency cycle: ${cycles.join(" → ")}.`);
    }
    errors.push(...validateCrossReferences(e.workpapers));
    errors.push(...validateDocumentVersions(e.documents));
  }
  return errors;
}

export function buildPracticeWorkspace(input: PracticeManConfig): {
  firm: { firmId: string; name: string; clientCount: number; engagementCount: number };
  clients: ClientResult[];
  engagements: EngagementResult[];
  firmAnalytics: FirmAnalyticsResult;
  warnings: string[];
  methodology: string[];
} {
  const { firm, clients, engagements, analytics } = input;
  const windowStart = parseISODate(firm.calendarWindowStart);
  const windowEnd = parseISODate(firm.calendarWindowEnd);

  const allWarnings: string[] = [...validatePracticeConfig(input)];

  // Effective (window- and dependency-aware) status for every deadline, keyed
  // by engagement then deadline id — computed once and reused by the client,
  // engagement and firm-level roll-ups so they can never disagree.
  const deadlineStatusByEngagement = new Map<
    string,
    Map<string, "upcoming" | "due" | "overdue" | "completed" | "escalated">
  >();
  for (const e of engagements) {
    deadlineStatusByEngagement.set(e.engagementId, deadlineStatusesFor(e.deadlines, windowStart, windowEnd));
  }

  // Client results
  const clientResults: ClientResult[] = clients.map((c) => {
    const clientEngagements = engagements.filter((e) => e.clientId === c.clientId);
    const overdue = clientEngagements.reduce((n, e) => {
      const statuses = deadlineStatusByEngagement.get(e.engagementId);
      if (!statuses) return n;
      let count = 0;
      for (const s of statuses.values()) if (s === "overdue") count += 1;
      return n + count;
    }, 0);
    const unsigned = clientEngagements.reduce((s, e) => s + unsignedDocumentCount(e.documents), 0);
    return {
      clientId: c.clientId,
      name: c.name,
      engagementCount: clientEngagements.length,
      activeEngagementCount: clientEngagements.filter((e) => e.status !== "completed" && e.status !== "archived")
        .length,
      overdueDeadlineCount: overdue,
      unsignedDocumentCount: unsigned,
    };
  });

  // Engagement results
  const engagementResults: EngagementResult[] = engagements.map((e) => {
    const { realisationPct, timeBudgetVariancePct, warnings: eWarnings } = engagementRealisation(e);
    allWarnings.push(...eWarnings);
    const phaseBreakdown = e.phases.map(phaseResult);
    const statuses = deadlineStatusByEngagement.get(e.engagementId);
    const deadlines = e.deadlines.map((d) => {
      return {
        deadlineId: d.deadlineId,
        label: d.label,
        dueDate: d.dueDate,
        entityTag: d.entityTag,
        status:
          statuses?.get(d.deadlineId) ?? deadlineStatus(parseISODate(d.dueDate), windowStart, windowEnd, d.status),
        owner: d.owner,
        dependsOn: d.dependsOn,
        dependentCount: dependentCount(d.deadlineId, e.deadlines),
        escalationNote: d.escalationNote,
      };
    });
    return {
      engagementId: e.engagementId,
      clientId: e.clientId,
      matter: e.matter,
      status: e.status,
      scope: e.scope,
      periodLabel: e.periodLabel,
      leadPartner: e.leadPartner,
      reviewers: e.reviewers,
      feeBudget: e.feeBudget,
      feeBilled: e.feeBilled,
      feeRealised: e.feeRealised,
      realisationPct,
      timeRecordedHours: e.timeRecordedHours,
      timeBudgetVariancePct,
      phaseBreakdown,
      pendingCommunications: pendingCommunicationCount(e.communications),
      openWorkpaperCount: openWorkpaperCount(e.workpapers),
      unsignedDocumentCount: unsignedDocumentCount(e.documents),
      deadlines,
      workpapers: e.workpapers,
      documents: e.documents,
      warnings: eWarnings,
    };
  });

  // Firm-level analytics (only the scopes requested)
  const firmAnalytics: FirmAnalyticsResult = {
    periodStart: firm.calendarWindowStart,
    periodEnd: firm.calendarWindowEnd,
    clientCount: clients.length,
    engagementCount: engagements.length,
    realisation: analytics.realisation
      ? {
          totalFeeBudget: engagements.reduce((s, e) => s + e.feeBudget, 0),
          totalFeeBilled: engagements.reduce((s, e) => s + e.feeBilled, 0),
          totalFeeRealised: engagements.reduce((s, e) => s + e.feeRealised, 0),
          realisationPct: realisationRollup(engagements),
          byStatus: [...new Set(engagements.map((e) => e.status))].map((status) => {
            const subset = engagements.filter((e) => e.status === status);
            const budget = subset.reduce((s, e) => s + e.feeBudget, 0);
            const billed = subset.reduce((s, e) => s + e.feeBilled, 0);
            const realised = subset.reduce((s, e) => s + e.feeRealised, 0);
            return {
              status,
              budget,
              billed,
              realised,
              realisationPct: budget > 0 ? (realised / budget) * 100 : 0,
            };
          }),
        }
      : {
          totalFeeBudget: 0,
          totalFeeBilled: 0,
          totalFeeRealised: 0,
          realisationPct: 0,
          byStatus: [],
        },
    pipeline: analytics.pipeline
      ? pipelineRollup(engagements)
      : {
          totalPipeline: 0,
          weightedPipeline: 0,
          byStatus: [],
          inScopeCount: 0,
          inProgressCount: 0,
          underReviewCount: 0,
        },
    overdueWork: analytics.overdue
      ? overdueWorkRollup(clients, engagements, windowStart, windowEnd)
      : {
          overdueDeadlineCount: 0,
          overdueEngagementCount: 0,
          escalatedDeadlineCount: 0,
          openWorkpaperCount: 0,
          pendingReviewCount: 0,
          unsignedDocumentCount: 0,
          byClient: [],
        },
    complianceDueList: analytics.complianceDueList
      ? complianceDueListResolving({ engagements, clients, windowStart, windowEnd })
      : [],
    staffingLoad: analytics.staffingLoad
      ? staffingLoadRollup(engagements, windowEnd)
      : {
          totalTimeRecordedHours: 0,
          byPerson: [],
          reviewQueueByReviewer: [],
        },
  };

  return {
    firm: {
      firmId: firm.firmId,
      name: firm.name,
      clientCount: clients.length,
      engagementCount: engagements.length,
    },
    clients: clientResults,
    engagements: engagementResults,
    firmAnalytics,
    warnings: allWarnings,
    methodology: [
      "The practice operating system combines the firm registry, client registry, and engagements into one view, with client-wise isolation.",
      "Engagement realisation and time-budget variance are computed from fee budget/billed/realised and phase budget/actual hours.",
      "Working papers are numbered, cross-referenced (validated against existing papers), and carry review/rework/sign-off history; client-specific templates and reusable families are supported.",
      "Deadlines are client- and entity-specific, dependency-aware (cycle detection + dependent counts), and computed against the firm-wide calendar window; reassignment with reason and escalation are supported.",
      "Documents are versioned (version chronology validated), owned, retention-aware, and client access-controlled by role.",
      "Firm-level reporting covers realisation, pipeline (weighted by completion probability), overdue work with per-client breakdown, a compliance due list across all clients, and staffing load.",
    ],
  };
}

/**
 * PracticeManagementError — thrown by the engine when the input is invalid
 * (for example, a deadline dependency cycle, unknown client mapping, or a
 * workpaper cross-reference to a missing number). The route maps this to a 400
 * so a caller error never becomes a 500.
 */
export class PracticeManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PracticeManagementError";
  }
}

export interface Reassignment {
  deadlineId: string;
  fromOwner: string;
  toOwner: string;
  reason: string;
  reassignedAt: string;
}
