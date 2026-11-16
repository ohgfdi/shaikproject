/**
 * Practice overview — the partner's cross-client view over the firm's
 * engagements.
 *
 * Everything the practice actually needs to run a Monday morning review lives
 * in models that already exist (Engagement, EngagementMember, WorkingPaper,
 * EngagementChangeRequest, EngagementDeliverableVersion/-SignOff). What was
 * missing was one place that puts a *client* — not an engine — at the centre:
 * who is on it, what is waiting for review, what is signed, what has gone
 * quiet.
 *
 * Design rules:
 *  - The summary maths is a pure function (`summarisePractice`) so the health
 *    rules are oracle-tested without a database.
 *  - The DB layer only loads counts and the newest timestamps; it never loads
 *    client artifact contents into the dashboard.
 *  - Firm isolation is enforced once, via `requireOrgRole` on the organization
 *    and `requireEngagementRole` on a single engagement.
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - practice overview is a deployment-wide aggregate operation
import { prisma } from "@/lib/db";
import { requireEngagementRole } from "@/lib/server/engagement";
import { requireOrgRole } from "@/lib/server/members";
import type { PracticeRole } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaperStatusCounts {
  draft: number;
  inReview: number;
  reviewed: number;
  signedOff: number;
  archived: number;
  total: number;
}

export type EngagementFlag =
  | "no-team"
  | "review-backlog"
  | "draft-backlog"
  | "open-changes"
  | "stale"
  | "legal-hold";

/** The facts a health call is made from — all caller/user supplied data. */
export interface EngagementHealthInput {
  id: string;
  name: string;
  code: string | null;
  status: string;
  jurisdiction: string;
  dataClassification: string;
  legalHold: boolean;
  retentionUntil: string | null;
  teamSize: number;
  papers: PaperStatusCounts;
  deliverablesTotal: number;
  deliverablesAwaitingReview: number;
  deliverablesSigned: number;
  openChanges: number;
  lastActivityAt: string;
  createdAt: string;
}

export interface EngagementHealth extends EngagementHealthInput {
  flags: EngagementFlag[];
  attentionScore: number;
}

export interface PracticeTotals {
  /** Non-archived engagements — the working client list. */
  clients: number;
  active: number;
  paused: number;
  archived: number;
  teamAssignments: number;
  papersAwaitingReview: number;
  papersDraft: number;
  papersSignedOff: number;
  deliverablesAwaitingReview: number;
  deliverablesSigned: number;
  openChanges: number;
  engagementsWithoutTeam: number;
  staleEngagements: number;
  legalHolds: number;
  needsAttention: number;
}

export interface PracticeOverview {
  totals: PracticeTotals;
  engagements: EngagementHealth[];
  generatedAt: string;
}

export const DEFAULT_STALE_AFTER_DAYS = 30;
/** A draft pile this large is worth a partner's attention even when fresh. */
export const DRAFT_BACKLOG_THRESHOLD = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyPaperCounts(): PaperStatusCounts {
  return { draft: 0, inReview: 0, reviewed: 0, signedOff: 0, archived: 0, total: 0 };
}

// ---------------------------------------------------------------------------
// Pure summary — oracle-tested
// ---------------------------------------------------------------------------

function daysBetween(fromIso: string, now: Date): number {
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from)) return 0;
  return (now.getTime() - from) / DAY_MS;
}

/**
 * Derive flags + attention ordering from raw per-client facts.
 *
 * Health rules (deliberately simple and explainable to a partner):
 *  - no-team            — an active client with nobody assigned.
 *  - review-backlog     — at least one working paper is sitting in review.
 *  - draft-backlog      — five or more unprepared papers.
 *  - open-changes       — a change request is awaiting review/approval.
 *  - stale              — no activity for more than `staleAfterDays`.
 *  - legal-hold         — retention is frozen by a live matter.
 *
 * Archived engagements are counted in totals but never raised as attention
 * items, and are returned last so the working list stays on top.
 */
export function summarisePractice(
  rows: EngagementHealthInput[],
  now: Date = new Date(),
  opts: { staleAfterDays?: number } = {},
): PracticeOverview {
  const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const totals: PracticeTotals = {
    clients: 0,
    active: 0,
    paused: 0,
    archived: 0,
    teamAssignments: 0,
    papersAwaitingReview: 0,
    papersDraft: 0,
    papersSignedOff: 0,
    deliverablesAwaitingReview: 0,
    deliverablesSigned: 0,
    openChanges: 0,
    engagementsWithoutTeam: 0,
    staleEngagements: 0,
    legalHolds: 0,
    needsAttention: 0,
  };

  const engagements: EngagementHealth[] = rows.map((row) => {
    const archived = row.status === "ARCHIVED";
    const flags: EngagementFlag[] = [];

    if (!archived && row.teamSize === 0) flags.push("no-team");
    if (!archived && row.papers.inReview > 0) flags.push("review-backlog");
    if (!archived && row.papers.draft >= DRAFT_BACKLOG_THRESHOLD) flags.push("draft-backlog");
    if (!archived && row.openChanges > 0) flags.push("open-changes");
    if (!archived && daysBetween(row.lastActivityAt, now) > staleAfterDays) flags.push("stale");
    if (row.legalHold) flags.push("legal-hold");

    const attentionScore = archived
      ? 0
      : row.papers.inReview * 3 +
        row.openChanges * 2 +
        row.papers.draft +
        (flags.includes("no-team") ? 5 : 0) +
        (flags.includes("stale") ? 4 : 0) +
        (row.legalHold ? 2 : 0) +
        row.deliverablesAwaitingReview * 2;

    totals.archived += archived ? 1 : 0;
    if (!archived) {
      totals.clients += 1;
      if (row.status === "PAUSED") totals.paused += 1;
      else totals.active += 1;
      totals.teamAssignments += row.teamSize;
      totals.papersAwaitingReview += row.papers.inReview;
      totals.papersDraft += row.papers.draft;
      totals.papersSignedOff += row.papers.signedOff;
      totals.deliverablesAwaitingReview += row.deliverablesAwaitingReview;
      totals.deliverablesSigned += row.deliverablesSigned;
      totals.openChanges += row.openChanges;
      if (row.teamSize === 0) totals.engagementsWithoutTeam += 1;
      if (flags.includes("stale")) totals.staleEngagements += 1;
      if (flags.length > 0) totals.needsAttention += 1;
    }
    if (row.legalHold) totals.legalHolds += 1;

    return { ...row, flags, attentionScore };
  });

  engagements.sort((a, b) => {
    if (a.status === "ARCHIVED" && b.status !== "ARCHIVED") return 1;
    if (b.status === "ARCHIVED" && a.status !== "ARCHIVED") return -1;
    if (b.attentionScore !== a.attentionScore) return b.attentionScore - a.attentionScore;
    return a.name.localeCompare(b.name);
  });

  return { totals, engagements, generatedAt: now.toISOString() };
}

// ---------------------------------------------------------------------------
// DB aggregation
// ---------------------------------------------------------------------------

const OPEN_CHANGE_STATES = ["REQUESTED", "IN_REVIEW", "CHANGES_REQUESTED"];
const SIGNED_DELIVERABLE_STEPS = ["SIGN_OFF", "ISSUANCE"];

function maxIso(...values: (Date | string | null | undefined)[]): string {
  let best = 0;
  for (const value of values) {
    if (!value) continue;
    const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (Number.isFinite(t) && t > best) best = t;
  }
  return new Date(best || Date.now()).toISOString();
}

/** Partner dashboard data for the caller's firm. */
export async function getPracticeOverview(ctx: AuthContext): Promise<PracticeOverview> {
  if (!ctx.organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  const organizationId = ctx.organization.id;
  await requireOrgRole(ctx, organizationId, "MEMBER");

  const engagements = await prisma.engagement.findMany({
    where: { organizationId },
    include: { _count: { select: { members: true } } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  if (engagements.length === 0) return summarisePractice([]);

  const ids = engagements.map((e) => e.id);

  const [paperGroups, lastPaper, changeGroups, deliverableGroups, lastDeliverable, signoffGroups] =
    await Promise.all([
      prisma.workingPaper.groupBy({
        by: ["engagementId", "status"],
        where: { engagementId: { in: ids } },
        _count: { _all: true },
      }),
      prisma.workingPaper.groupBy({
        by: ["engagementId"],
        where: { engagementId: { in: ids } },
        _max: { updatedAt: true },
      }),
      prisma.engagementChangeRequest.groupBy({
        by: ["engagementId"],
        where: { engagementId: { in: ids }, state: { in: OPEN_CHANGE_STATES } },
        _count: { _all: true },
      }),
      prisma.engagementDeliverableVersion.groupBy({
        by: ["engagementId", "status"],
        where: { engagementId: { in: ids } },
        _count: { _all: true },
      }),
      prisma.engagementDeliverableVersion.groupBy({
        by: ["engagementId"],
        where: { engagementId: { in: ids } },
        _max: { createdAt: true },
      }),
      prisma.engagementDeliverableSignOff.groupBy({
        by: ["engagementId"],
        where: { engagementId: { in: ids }, step: { in: SIGNED_DELIVERABLE_STEPS } },
        _count: { _all: true },
      }),
    ]);

  const papers = new Map<string, PaperStatusCounts>();
  for (const group of paperGroups) {
    const entry = papers.get(group.engagementId) ?? emptyPaperCounts();
    const n = group._count._all;
    const status = group.status;
    if (status === "DRAFT") entry.draft += n;
    else if (status === "IN_REVIEW") entry.inReview += n;
    else if (status === "REVIEWED") entry.reviewed += n;
    else if (status === "SIGNED_OFF") entry.signedOff += n;
    else entry.archived += n;
    entry.total += n;
    papers.set(group.engagementId, entry);
  }

  const lastPaperAt = new Map(lastPaper.map((g) => [g.engagementId, g._max.updatedAt]));
  const openChanges = new Map(changeGroups.map((g) => [g.engagementId, g._count._all]));
  const lastDeliverableAt = new Map(lastDeliverable.map((g) => [g.engagementId, g._max.createdAt]));
  const signedDeliverables = new Map(signoffGroups.map((g) => [g.engagementId, g._count._all]));

  const deliverables = new Map<string, { total: number; awaitingReview: number }>();
  for (const group of deliverableGroups) {
    const entry = deliverables.get(group.engagementId) ?? { total: 0, awaitingReview: 0 };
    const n = group._count._all;
    entry.total += n;
    if (group.status === "IN_REVIEW") entry.awaitingReview += n;
    deliverables.set(group.engagementId, entry);
  }

  const rows: EngagementHealthInput[] = engagements.map((engagement) => {
    const counts = papers.get(engagement.id) ?? emptyPaperCounts();
    const deliverable = deliverables.get(engagement.id) ?? { total: 0, awaitingReview: 0 };
    return {
      id: engagement.id,
      name: engagement.name,
      code: engagement.code,
      status: engagement.status,
      jurisdiction: engagement.jurisdiction,
      dataClassification: engagement.dataClassification,
      legalHold: engagement.legalHold,
      retentionUntil: engagement.retentionUntil ? engagement.retentionUntil.toISOString() : null,
      teamSize: engagement._count.members,
      papers: counts,
      deliverablesTotal: deliverable.total,
      deliverablesAwaitingReview: deliverable.awaitingReview,
      deliverablesSigned: signedDeliverables.get(engagement.id) ?? 0,
      openChanges: openChanges.get(engagement.id) ?? 0,
      lastActivityAt: maxIso(
        engagement.updatedAt,
        lastPaperAt.get(engagement.id),
        lastDeliverableAt.get(engagement.id),
      ),
      createdAt: engagement.createdAt.toISOString(),
    };
  });

  return summarisePractice(rows);
}

// ---------------------------------------------------------------------------
// Single-engagement overview (the row a partner expands)
// ---------------------------------------------------------------------------

export interface EngagementTeamMemberView {
  userId: string;
  name: string;
  email: string;
  practiceRole: PracticeRole;
}

export interface EngagementPaperView {
  id: string;
  indexRef: string;
  title: string;
  saReference: string | null;
  status: string;
  updatedAt: string;
}

export interface EngagementChangeView {
  id: string;
  title: string;
  state: string;
  rationale: string | null;
  updatedAt: string;
}

export interface EngagementDeliverableView {
  id: string;
  status: string;
  label: string;
  createdAt: string;
}

export interface EngagementOverviewDetail {
  engagement: {
    id: string;
    name: string;
    code: string | null;
    gstin: string | null;
    status: string;
    description: string | null;
    jurisdiction: string;
    dataClassification: string;
    legalHold: boolean;
    retentionUntil: string | null;
    createdAt: string;
    updatedAt: string;
  };
  role: PracticeRole;
  team: EngagementTeamMemberView[];
  papers: EngagementPaperView[];
  paperCounts: PaperStatusCounts;
  changeRequests: EngagementChangeView[];
  deliverables: {
    total: number;
    awaitingReview: number;
    recent: EngagementDeliverableView[];
  };
  retentionReason: string;
}

/** One client's operational picture: team, review queue, open changes, deliverables. */
export async function getEngagementOverview(
  ctx: AuthContext,
  engagementId: string,
): Promise<EngagementOverviewDetail> {
  const { role, engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");

  const [members, papers, changes, deliverableTotal, deliverableAwaiting, recentDeliverables, full] =
    await Promise.all([
      prisma.engagementMember.findMany({
        where: { engagementId: engagement.id },
        orderBy: { practiceRole: "asc" },
      }),
      prisma.workingPaper.findMany({
        where: { engagementId: engagement.id },
        select: {
          id: true,
          indexRef: true,
          title: true,
          saReference: true,
          status: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: "desc" }],
        take: 500,
      }),
      prisma.engagementChangeRequest.findMany({
        where: { engagementId: engagement.id, state: { in: OPEN_CHANGE_STATES } },
        select: { id: true, title: true, state: true, rationale: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 25,
      }),
      prisma.engagementDeliverableVersion.count({ where: { engagementId: engagement.id } }),
      prisma.engagementDeliverableVersion.count({
        where: { engagementId: engagement.id, status: "IN_REVIEW" },
      }),
      prisma.engagementDeliverableVersion.findMany({
        where: { engagementId: engagement.id },
        select: { id: true, status: true, createdAt: true, format: { select: { label: true } } },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
      prisma.engagement.findUnique({
        where: { id: engagement.id },
        select: { gstin: true, description: true, createdAt: true, updatedAt: true },
      }),
    ]);

  const userIds = [...new Set(members.map((m) => m.userId))];
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  const paperCounts = emptyPaperCounts();
  for (const paper of papers) {
    paperCounts.total += 1;
    if (paper.status === "DRAFT") paperCounts.draft += 1;
    else if (paper.status === "IN_REVIEW") paperCounts.inReview += 1;
    else if (paper.status === "REVIEWED") paperCounts.reviewed += 1;
    else if (paper.status === "SIGNED_OFF") paperCounts.signedOff += 1;
    else paperCounts.archived += 1;
  }

  const retentionBits: string[] = [`jurisdiction ${engagement.jurisdiction ?? "IN"}`];
  if (engagement.legalHold) retentionBits.push("legal hold — erasure frozen");
  if (engagement.retentionUntil) {
    retentionBits.push(`retained until ${engagement.retentionUntil.toISOString().slice(0, 10)}`);
  }

  return {
    engagement: {
      id: engagement.id,
      name: engagement.name ?? "Client engagement",
      code: engagement.code ?? null,
      gstin: full?.gstin ?? null,
      status: engagement.status ?? "ACTIVE",
      description: full?.description ?? null,
      jurisdiction: engagement.jurisdiction ?? "IN",
      dataClassification: engagement.dataClassification ?? "CONFIDENTIAL",
      legalHold: engagement.legalHold ?? false,
      retentionUntil: engagement.retentionUntil ? engagement.retentionUntil.toISOString() : null,
      createdAt: (full?.createdAt ?? engagement.createdAt ?? new Date()).toISOString(),
      updatedAt: (full?.updatedAt ?? new Date()).toISOString(),
    },
    role,
    team: members.map((member) => {
      const user = byId.get(member.userId);
      return {
        userId: member.userId,
        name: user?.name ?? user?.email ?? "Firm member",
        email: user?.email ?? "",
        practiceRole: member.practiceRole as PracticeRole,
      };
    }),
    papers: papers.map((paper) => ({
      id: paper.id,
      indexRef: paper.indexRef,
      title: paper.title,
      saReference: paper.saReference,
      status: paper.status,
      updatedAt: paper.updatedAt.toISOString(),
    })),
    paperCounts,
    changeRequests: changes.map((change) => ({
      id: change.id,
      title: change.title,
      state: change.state,
      rationale: change.rationale,
      updatedAt: change.updatedAt.toISOString(),
    })),
    deliverables: {
      total: deliverableTotal,
      awaitingReview: deliverableAwaiting,
      recent: recentDeliverables.map((deliverable) => ({
        id: deliverable.id,
        status: deliverable.status,
        label: deliverable.format?.label ?? "Deliverable",
        createdAt: deliverable.createdAt.toISOString(),
      })),
    },
    retentionReason: retentionBits.join(" · "),
  };
}
