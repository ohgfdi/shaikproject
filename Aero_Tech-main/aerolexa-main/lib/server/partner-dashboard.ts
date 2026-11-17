/**
 * Partner dashboard — the one screen that answers "is this firm healthy?".
 *
 * Every figure is computed from rows the firm already owns:
 *   - utilisation  = billable minutes ÷ recorded minutes (NOT attendance; the
 *                    app has no clock-in, and the screen says so),
 *   - realisation  = collected ÷ (collected + outstanding) on client invoices,
 *   - WIP aging    = unbilled time by age,
 *   - deadline risk= open filing runs due within 7 days or overdue.
 *
 * Nothing here is a score, a forecast or a benchmark. When there is no recorded
 * time, utilisation is `null` and the UI prints "not recorded" rather than 0%.
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

const withGlobalDb = <T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> => fn(prisma);
import { logActivity } from "@/lib/server/activity";
import { requireOrgRole } from "@/lib/server/members";
import {
  summarisePracticeEconomics,
  type ClientEconomics,
  type EconomicsEntry,
  type EconomicsInvoice,
  type PracticeEconomics,
} from "@/lib/server/practice-economics";
import type { PracticeRole } from "@/lib/types";

const DAY_MS = 86_400_000;

/** OrganizationRole → practice role, mirroring lib/server/engagement.ts. */
export const ORG_ROLE_TO_PRACTICE: Record<string, PracticeRole> = {
  OWNER: "PARTNER",
  ADMIN: "MANAGER",
  MEMBER: "ASSISTANT",
  AUDITOR: "AUDITOR",
};

export function practiceRoleForOrgRole(role: string | null | undefined): PracticeRole | null {
  return role ? (ORG_ROLE_TO_PRACTICE[role] ?? null) : null;
}

/** Billable share of recorded time, as a percentage with one decimal. */
export function utilisationPct(billableMinutes: number, recordedMinutes: number): number | null {
  if (recordedMinutes <= 0) return null;
  return Math.round((billableMinutes / recordedMinutes) * 1000) / 10;
}

/** Collected share of invoiced money that is either collected or still owed. */
export function realisationPct(collectedMinor: number, outstandingMinor: number): number | null {
  const base = collectedMinor + outstandingMinor;
  if (base <= 0) return null;
  return Math.round((collectedMinor / base) * 1000) / 10;
}

export interface DeadlineRiskRow {
  runId: string;
  engagementId: string;
  engagementName: string;
  title: string;
  dueDate: string;
  daysLate: number;
  stage: string;
  assigneeName: string | null;
  verificationStatus: string;
}

export interface PartnerWorkload {
  userId: string;
  name: string;
  role: string;
  practiceRole: PracticeRole | null;
  openRuns: number;
  overdueRuns: number;
  minutesThisWeek: number;
}

export interface PartnerTotals {
  recordedMinutes: number;
  billableMinutes: number;
  utilisationPct: number | null;
  invoicedMinor: number;
  collectedMinor: number;
  outstandingMinor: number;
  wipMinor: number;
  realisationPct: number | null;
  openRuns: number;
  overdueRuns: number;
  due7: number;
  due30: number;
}

export interface ClientEconomicsRow extends ClientEconomics {
  /** Invoiced money, collected or not. */
  billedMinor: number;
  /** Collected share of invoiced money; null when nothing was invoiced. */
  realisationPct: number | null;
}

/**
 * Per-client economics, ranked by money at risk (outstanding + unbilled WIP).
 *
 * This is the revenue side only: the app records billable value and what was
 * collected, not a cost rate, so calling it "profit" would be a claim the data
 * cannot support. The digest labels it accordingly.
 */
export function rankClientEconomics(clients: ClientEconomics[], limit = 5): ClientEconomicsRow[] {
  return clients
    .map((client) => ({
      ...client,
      billedMinor: client.invoicedMinor,
      realisationPct:
        client.invoicedMinor <= 0
          ? null
          : Math.round((client.collectedMinor / client.invoicedMinor) * 1000) / 10,
    }))
    .sort(
      (a, b) =>
        b.outstandingMinor + b.unbilledMinor - (a.outstandingMinor + a.unbilledMinor) ||
        b.overdueMinor - a.overdueMinor ||
        a.engagementName.localeCompare(b.engagementName),
    )
    .slice(0, Math.max(1, limit));
}

export interface PartnerDashboard {
  asOf: string;
  firmName: string;
  totals: PartnerTotals;
  risk: DeadlineRiskRow[];
  workload: PartnerWorkload[];
  economics: PracticeEconomics;
  clientEconomics: ClientEconomicsRow[];
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / DAY_MS);
}

/** Counts of open runs that are overdue, due within 7 days and within 30. */
export function deadlineBuckets(
  runs: { dueDate: string; stage: string }[],
  today: string,
): { overdue: number; due7: number; due30: number } {
  let overdue = 0;
  let due7 = 0;
  let due30 = 0;
  for (const run of runs) {
    if (run.stage === "acknowledged") continue;
    const days = daysBetween(today, run.dueDate);
    if (days < 0) overdue += 1;
    else if (days <= 7) due7 += 1;
    else if (days <= 30) due30 += 1;
  }
  return { overdue, due7, due30 };
}

const PRACTICE_RANK: Record<PracticeRole, number> = {
  ASSISTANT: 1,
  SENIOR: 2,
  REVIEWER: 3,
  MANAGER: 4,
  PARTNER: 5,
  AUDITOR: 9,
};

/**
 * Pick the least-loaded eligible member. AUDITOR can read but cannot own work;
 * ties break toward the more junior role (preparation work) and then user id, so
 * the result is deterministic and testable.
 */
export function suggestAssignee(
  candidates: { userId: string; practiceRole: PracticeRole | null }[],
  loadByUser: Record<string, number>,
): string | null {
  const eligible = candidates.filter(
    (candidate) => candidate.practiceRole !== null && candidate.practiceRole !== "AUDITOR",
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const loadDiff = (loadByUser[a.userId] ?? 0) - (loadByUser[b.userId] ?? 0);
    if (loadDiff !== 0) return loadDiff;
    const rankDiff =
      PRACTICE_RANK[a.practiceRole as PracticeRole] - PRACTICE_RANK[b.practiceRole as PracticeRole];
    if (rankDiff !== 0) return rankDiff;
    return a.userId.localeCompare(b.userId);
  });
  return eligible[0]?.userId ?? null;
}

/** Load the dashboard for one organization. Caller has already gated access. */
export async function loadPartnerDashboard(
  organizationId: string,
  asOf: string,
): Promise<PartnerDashboard> {
  const weekStart = new Date(Date.parse(`${asOf}T00:00:00Z`) - 7 * DAY_MS).toISOString().slice(0, 10);

  const [organization, entries, invoices, runs, members] = await Promise.all([
    withGlobalDb((db) => db.organization.findUnique({ where: { id: organizationId }, select: { name: true } })),
    withGlobalDb((db) => db.practiceTimeEntry.findMany({
      where: { organizationId },
      select: {
        engagementId: true,
        workDate: true,
        minutes: true,
        ratePerHourMinor: true,
        billable: true,
        invoiceId: true,
        userId: true,
        engagement: { select: { name: true } },
      },
      take: 20_000,
    })),
    withGlobalDb((db) => db.practiceInvoice.findMany({
      where: { organizationId },
      select: {
        id: true,
        engagementId: true,
        number: true,
        subtotalMinor: true,
        taxMinor: true,
        totalMinor: true,
        status: true,
        issuedOn: true,
        dueDate: true,
        paidOn: true,
        paymentReference: true,
        paymentMethod: true,
      },
      orderBy: { issuedOn: "desc" },
      take: 500,
    })),
    withGlobalDb((db) => db.complianceFilingRun.findMany({
      where: { organizationId, stage: { not: "acknowledged" } },
      select: {
        id: true,
        organizationId: true,
        engagementId: true,
        title: true,
        dueDate: true,
        stage: true,
        assigneeId: true,
        verificationStatus: true,
        engagement: { select: { name: true } },
      },
      take: 2000,
    })),
    withGlobalDb((db) => db.organizationMember.findMany({
      where: { organizationId },
      select: { userId: true, role: true, user: { select: { name: true, email: true } } },
      take: 200,
    })),
  ]);

  const economicsEntries: EconomicsEntry[] = entries.map((entry) => ({
    engagementId: entry.engagementId,
    engagementName: entry.engagement.name,
    workDate: entry.workDate,
    minutes: entry.minutes,
    ratePerHourMinor: entry.ratePerHourMinor,
    billable: entry.billable,
    invoiceId: entry.invoiceId,
  }));
  const economicsInvoices: EconomicsInvoice[] = invoices;
  const economics = summarisePracticeEconomics({ asOf, entries: economicsEntries, invoices: economicsInvoices });

  const recordedMinutes = entries.reduce((sum, entry) => sum + entry.minutes, 0);
  const billableMinutes = entries
    .filter((entry) => entry.billable)
    .reduce((sum, entry) => sum + entry.minutes, 0);
  const buckets = deadlineBuckets(runs, asOf);

  const nameByUser = new Map(members.map((member) => [member.userId, member.user.name || member.user.email]));
  const risk: DeadlineRiskRow[] = runs
    .filter((run) => daysBetween(asOf, run.dueDate) <= 7)
    .map((run) => ({
      runId: run.id,
      engagementId: run.engagementId,
      engagementName: run.engagement.name,
      title: run.title,
      dueDate: run.dueDate,
      daysLate: Math.max(0, daysBetween(run.dueDate, asOf)),
      stage: run.stage,
      assigneeName: run.assigneeId ? (nameByUser.get(run.assigneeId) ?? null) : null,
      verificationStatus: run.verificationStatus,
    }))
    .sort((a, b) => b.daysLate - a.daysLate || a.dueDate.localeCompare(b.dueDate));

  const workload: PartnerWorkload[] = members.map((member) => {
    const owned = runs.filter((run) => run.assigneeId === member.userId);
    return {
      userId: member.userId,
      name: member.user.name || member.user.email,
      role: member.role,
      practiceRole: practiceRoleForOrgRole(member.role),
      openRuns: owned.length,
      overdueRuns: owned.filter((run) => run.dueDate < asOf).length,
      minutesThisWeek: entries
        .filter((entry) => entry.userId === member.userId && entry.workDate > weekStart)
        .reduce((sum, entry) => sum + entry.minutes, 0),
    };
  });
  workload.sort((a, b) => b.overdueRuns - a.overdueRuns || b.openRuns - a.openRuns);

  return {
    asOf,
    firmName: organization?.name ?? "Your firm",
    totals: {
      recordedMinutes,
      billableMinutes,
      utilisationPct: utilisationPct(billableMinutes, recordedMinutes),
      invoicedMinor: economics.totals.invoicedMinor,
      collectedMinor: economics.totals.collectedMinor,
      outstandingMinor: economics.totals.outstandingMinor,
      wipMinor: economics.totals.unbilledMinor,
      realisationPct: realisationPct(economics.totals.collectedMinor, economics.totals.outstandingMinor),
      openRuns: runs.length,
      overdueRuns: buckets.overdue,
      due7: buckets.due7,
      due30: buckets.due30,
    },
    risk,
    workload,
    economics,
    clientEconomics: rankClientEconomics(economics.clients, 5),
  };
}

export async function getPartnerDashboard(
  ctx: AuthContext,
  opts: { today?: string } = {},
): Promise<PartnerDashboard> {
  if (!ctx.organization) {
    throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  }
  await requireOrgRole(ctx, ctx.organization.id, "MEMBER");
  const asOf =
    opts.today && /^\d{4}-\d{2}-\d{2}$/.test(opts.today)
      ? opts.today
      : new Date().toISOString().slice(0, 10);
  return loadPartnerDashboard(ctx.organization.id, asOf);
}

export interface AutoAssignResult {
  assigned: number;
  skipped: number;
  byUser: { userId: string; name: string; assigned: number }[];
}

/**
 * Assign every unassigned `computed` run to the least-loaded eligible member.
 * Explicit and idempotent: it only touches runs with no assignee, and each
 * claim is a conditional update so two partners clicking at once cannot both
 * assign the same run.
 */
export async function autoAssignPreparers(
  ctx: AuthContext,
  opts: { limit?: number } = {},
): Promise<AutoAssignResult> {
  if (!ctx.organization) {
    throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  }
  const organizationId = ctx.organization.id;
  // Firm-wide assignment is an admin action; practice managers reach it through
  // the ADMIN organization role (ORG_ROLE_TO_PRACTICE: ADMIN → MANAGER).
  await requireOrgRole(ctx, organizationId, "ADMIN");
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 25), 1), 100);

  const [unassigned, openRuns, members] = await Promise.all([
    withGlobalDb((db) =>
      db.complianceFilingRun.findMany({
        where: { organizationId, stage: "computed", assigneeId: null },
        select: { id: true, engagementId: true, title: true },
        orderBy: { dueDate: "asc" },
        take: limit,
      }),
    ),
    withGlobalDb((db) =>
      db.complianceFilingRun.findMany({
        where: { organizationId, stage: { not: "acknowledged" }, assigneeId: { not: null } },
        select: { assigneeId: true },
        take: 5000,
      }),
    ),
    withGlobalDb((db) =>
      db.organizationMember.findMany({
        where: { organizationId },
        select: { userId: true, role: true, user: { select: { name: true, email: true } } },
        take: 200,
      }),
    )],
  );

  const candidates = members
    .map((member) => ({ userId: member.userId, practiceRole: practiceRoleForOrgRole(member.role) }))
    .filter((candidate) => candidate.practiceRole !== null && candidate.practiceRole !== "AUDITOR");
  if (candidates.length === 0) {
    throw new ApiError(
      409,
      "NO_ELIGIBLE_ASSIGNEE",
      "No member can own preparation work. Add a member with an assistant role or above.",
    );
  }

  const loadByUser: Record<string, number> = {};
  for (const run of openRuns) {
    if (run.assigneeId) loadByUser[run.assigneeId] = (loadByUser[run.assigneeId] ?? 0) + 1;
  }
  const nameByUser = new Map(members.map((member) => [member.userId, member.user.name || member.user.email]));

  let assigned = 0;
  let skipped = 0;
  const assignedByUser: Record<string, number> = {};

  for (const run of unassigned) {
    const userId = suggestAssignee(candidates, loadByUser);
    if (!userId) {
      skipped += 1;
      continue;
    }
    const claim = await prisma.$transaction(async (tx) => {
      const update = await tx.complianceFilingRun.updateMany({
        where: { id: run.id, assigneeId: null, stage: "computed" },
        data: { assigneeId: userId, updatedById: ctx.user.id },
      });
      if (update.count !== 1) return false;
      await tx.complianceFilingEvent.create({
        data: {
          runId: run.id,
          organizationId,
          fromStage: "computed",
          toStage: "computed",
          note: `Auto-assigned to ${nameByUser.get(userId) ?? userId} by workload.`,
          actorId: ctx.user.id,
        },
      });
      return true;
    });
    if (!claim) {
      skipped += 1;
      continue;
    }
    assigned += 1;
    loadByUser[userId] = (loadByUser[userId] ?? 0) + 1;
    assignedByUser[userId] = (assignedByUser[userId] ?? 0) + 1;
  }

  if (assigned > 0) {
    await logActivity(ctx, "PRACTICE_AUTO_ASSIGNED", `Auto-assigned ${assigned} filing run(s) by workload`, null, {
      assigned,
      skipped,
    });
  }

  return {
    assigned,
    skipped,
    byUser: Object.entries(assignedByUser).map(([userId, count]) => ({
      userId,
      name: nameByUser.get(userId) ?? userId,
      assigned: count,
    })),
  };
}
