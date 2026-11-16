/**
 * Growth funnel (Phase 2 of the GTM plan) — the metrics that decide whether
 * the product is working, computed from data the app ALREADY records.
 *
 * Definitions (the weekly review reads exactly these):
 *
 *   signup        — a User row exists (created this period)
 *   activated     — the user uploaded a dataset AND ran ≥1 analysis
 *                   (DATASET_UPLOADED + ANALYSIS_RUN on their workspace)
 *   collaborated  — the workspace shows multi-user signal (an org member
 *                   added or a share link published)
 *   paid          — an active paid subscription (BILLING_PAID / Subscription)
 *
 * The funnel is deliberately STRICT about honesty: numbers come from real
 * rows; empty cohorts render as 0/0 — never a fabricated rate. Percentages
 * are null (not 0) when the denominator is 0, so "no data" is distinguishable
 * from "nobody converted".
 */

// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - growth funnel is a deployment-wide aggregate operation
import { prisma } from "@/lib/db";

export interface StageCount {
  count: number;
  /** count / previous-stage count, null when the denominator is 0. */
  rate: number | null;
}

export interface FunnelSnapshot {
  periodStart: Date;
  periodEnd: Date;
  signups: StageCount;
  activated: StageCount;
  collaborated: StageCount;
  paid: StageCount;
  /** Workspaces that exist only for the demo account are excluded upstream. */
  excludedDemo: boolean;
}

function rateOf(count: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return count / denominator;
}

/**
 * Compute the funnel for one period window.
 *
 * Activation/collaboration/paid are attributed to the SIGNUP's period
 * (cohort semantics), so the funnel answers "of the users who signed up this
 * week, how many got value?" — not "who happened to activate this week".
 */
export async function computeFunnel(periodStart: Date, periodEnd: Date): Promise<FunnelSnapshot> {
  const users = await prisma.user.findMany({
    where: { createdAt: { gte: periodStart, lt: periodEnd }, email: { not: { endsWith: "@aerolexa.local" } } },
    select: { id: true, workspaceId: true, createdAt: true },
  });
  const signupCount = users.length;

  if (signupCount === 0) {
    return {
      periodStart,
      periodEnd,
      signups: { count: 0, rate: 1 },
      activated: { count: 0, rate: null },
      collaborated: { count: 0, rate: null },
      paid: { count: 0, rate: null },
      excludedDemo: true,
    };
  }

  const workspaceIds = [...new Set(users.map((u) => u.workspaceId).filter((v): v is string => Boolean(v)))];
  // Activated: the workspace uploaded AND ran an analysis.
  const activatedWorkspaces = new Set<string>();
  if (workspaceIds.length > 0) {
    const [uploaded, analyzed] = await Promise.all([
      prisma.activity.findMany({
        where: { workspaceId: { in: workspaceIds }, type: "DATASET_UPLOADED" },
        select: { workspaceId: true },
        distinct: ["workspaceId"],
      }),
      prisma.activity.findMany({
        where: { workspaceId: { in: workspaceIds }, type: "ANALYSIS_RUN" },
        select: { workspaceId: true },
        distinct: ["workspaceId"],
      }),
    ]);
    const uploadedSet = new Set(uploaded.map((r) => r.workspaceId));
    for (const r of analyzed) {
      if (uploadedSet.has(r.workspaceId)) activatedWorkspaces.add(r.workspaceId);
    }
  }
  const activatedCount = users.filter((u) => u.workspaceId && activatedWorkspaces.has(u.workspaceId)).length;

  // Collaborated: org member added OR a public share link was published.
  const collabWorkspaces = new Set<string>();
  if (workspaceIds.length > 0) {
    const [membersAdded, published] = await Promise.all([
      prisma.activity.findMany({
        where: { workspaceId: { in: workspaceIds }, type: { in: ["ORGANIZATION_MEMBER_ADDED", "MEMBER_ADDED"] } },
        select: { workspaceId: true },
        distinct: ["workspaceId"],
      }),
      prisma.activity.findMany({
        where: { workspaceId: { in: workspaceIds }, type: "PUBLICATION_PUBLIC_LINK" },
        select: { workspaceId: true },
        distinct: ["workspaceId"],
      }),
    ]);
    for (const r of [...membersAdded, ...published]) collabWorkspaces.add(r.workspaceId);
  }
  const collaboratedCount = users.filter((u) => u.workspaceId && collabWorkspaces.has(u.workspaceId)).length;

  // Paid: an ACTIVE non-free subscription on the signup's workspace.
  const paidWorkspaces = new Set<string>();
  if (workspaceIds.length > 0) {
    const subs = await prisma.subscription.findMany({
      where: { workspaceId: { in: workspaceIds }, status: "active", planId: { not: "free" } },
      select: { workspaceId: true },
      distinct: ["workspaceId"],
    });
    for (const s of subs) paidWorkspaces.add(s.workspaceId);
  }
  const paidCount = users.filter((u) => u.workspaceId && paidWorkspaces.has(u.workspaceId)).length;

  return {
    periodStart,
    periodEnd,
    signups: { count: signupCount, rate: 1 },
    activated: { count: activatedCount, rate: rateOf(activatedCount, signupCount) },
    collaborated: { count: collaboratedCount, rate: rateOf(collaboratedCount, signupCount) },
    paid: { count: paidCount, rate: rateOf(paidCount, signupCount) },
    excludedDemo: true,
  };
}

export interface WeeklyFunnelRow {
  /** ISO date of the week's Monday (the cohort label). */
  weekOf: string;
  signups: number;
  activated: number;
  collaborated: number;
  paid: number;
  activationRate: number | null;
  paidRate: number | null;
}

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  const day = (out.getUTCDay() + 6) % 7; // Monday = 0
  out.setUTCDate(out.getUTCDate() - day);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function addWeeks(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n * 7);
  return out;
}

/**
 * Weekly cohort rows for the last `weeks` weeks (oldest first).
 * Each row is computed by computeFunnel over that signup week.
 */
export async function weeklyFunnel(weeks = 12, now = new Date()): Promise<WeeklyFunnelRow[]> {
  const thisWeek = startOfWeek(now);
  const rows: WeeklyFunnelRow[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addWeeks(thisWeek, -i);
    const end = addWeeks(start, 1);
    const snap = await computeFunnel(start, end);
    rows.push({
      weekOf: start.toISOString().slice(0, 10),
      signups: snap.signups.count,
      activated: snap.activated.count,
      collaborated: snap.collaborated.count,
      paid: snap.paid.count,
      activationRate: snap.activated.rate,
      paidRate: snap.paid.rate,
    });
  }
  return rows;
}

/** The operator guidance threshold from the GTM plan. */
export function activationVerdict(
  activationRate: number | null,
): "excellent" | "healthy" | "fix-onboarding" | "no-data" {
  if (activationRate === null) return "no-data";
  if (activationRate >= 0.6) return "excellent";
  if (activationRate >= 0.4) return "healthy";
  return "fix-onboarding";
}
