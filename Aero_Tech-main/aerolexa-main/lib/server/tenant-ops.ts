/**
 * Per-tenant operational posture.
 *
 * A deployment-wide queue depth hides the failure that matters: one firm's
 * filings are overdue while every other firm is healthy. This module derives a
 * per-organization view from stored rows and ranks it, so an operator can see
 * which tenant needs attention first. It reads only; it never moves another
 * tenant's work and never exposes tenant data through the public health probe
 * (the metrics route is token-guarded).
 */

import { prisma } from "@/lib/db";

export type TenantAttention = "ok" | "watch" | "critical";

export interface TenantOpsInput {
  organizationId: string;
  organizationName: string;
  overdueFilings: number;
  openFilings: number;
  pendingMail: number;
  failedMail: number;
}

export interface TenantOpsRow extends TenantOpsInput {
  attention: TenantAttention;
  score: number;
}

export interface TenantOpsPosture {
  tenants: TenantOpsRow[];
  totals: { tenants: number; overdueFilings: number; openFilings: number; pendingMail: number; failedMail: number };
  summary: string;
}

function attentionOf(row: TenantOpsInput): TenantAttention {
  if (row.overdueFilings > 0 || row.failedMail > 0) return "critical";
  if (row.openFilings > 0 || row.pendingMail > 0) return "watch";
  return "ok";
}

/** Score is for ordering only: overdue work dominates, failed mail next. */
function scoreOf(row: TenantOpsInput): number {
  return row.overdueFilings * 100 + row.failedMail * 25 + row.pendingMail + Math.min(row.openFilings, 50);
}

export function summarizeTenantOps(rows: TenantOpsInput[]): TenantOpsPosture {
  const tenants = rows
    .map((row) => ({ ...row, attention: attentionOf(row), score: scoreOf(row) }))
    .sort((a, b) => b.score - a.score || a.organizationName.localeCompare(b.organizationName));

  const totals = rows.reduce(
    (acc, row) => ({
      tenants: acc.tenants + 1,
      overdueFilings: acc.overdueFilings + row.overdueFilings,
      openFilings: acc.openFilings + row.openFilings,
      pendingMail: acc.pendingMail + row.pendingMail,
      failedMail: acc.failedMail + row.failedMail,
    }),
    { tenants: 0, overdueFilings: 0, openFilings: 0, pendingMail: 0, failedMail: 0 },
  );

  const critical = tenants.filter((tenant) => tenant.attention === "critical").length;
  const summary =
    tenants.length === 0
      ? "No tenant has operational work recorded."
      : `${critical} of ${tenants.length} tenant${tenants.length === 1 ? "" : "s"} need attention; ${totals.overdueFilings} overdue filing${totals.overdueFilings === 1 ? "" : "s"} and ${totals.failedMail} failed message${totals.failedMail === 1 ? "" : "s"} are the leading causes.`;

  return { tenants, totals, summary };
}

/** Read the posture for every organization that has work in this deployment. */
export async function collectTenantOps(today: string = new Date().toISOString().slice(0, 10)): Promise<TenantOpsPosture> {
  const [overdue, open, mail, organizations] = await Promise.all([
    prisma.complianceFilingRun.groupBy({
      by: ["organizationId"],
      where: { filedAt: null, dueDate: { lt: today } },
      _count: { _all: true },
    }),
    prisma.complianceFilingRun.groupBy({
      by: ["organizationId"],
      where: { filedAt: null },
      _count: { _all: true },
    }),
    prisma.mailOutbox.groupBy({
      by: ["organizationId", "status"],
      where: { status: { in: ["pending", "failed"] } },
      _count: { _all: true },
    }),
    prisma.organization.findMany({ select: { id: true, name: true } }),
  ]);

  const rows = new Map<string, TenantOpsInput>();
  const ensure = (organizationId: string): TenantOpsInput => {
    const existing = rows.get(organizationId);
    if (existing) return existing;
    const created: TenantOpsInput = {
      organizationId,
      organizationName: organizations.find((org) => org.id === organizationId)?.name ?? organizationId,
      overdueFilings: 0,
      openFilings: 0,
      pendingMail: 0,
      failedMail: 0,
    };
    rows.set(organizationId, created);
    return created;
  };

  for (const row of overdue) ensure(row.organizationId).overdueFilings = row._count._all;
  for (const row of open) ensure(row.organizationId).openFilings = row._count._all;
  for (const row of mail) {
    if (!row.organizationId) continue;
    const target = ensure(row.organizationId);
    if (row.status === "failed") target.failedMail += row._count._all;
    else target.pendingMail += row._count._all;
  }

  return summarizeTenantOps([...rows.values()]);
}

/** Prometheus lines for the tenant view (appended by /api/metrics). */
export function renderTenantOpsMetrics(posture: TenantOpsPosture): string {
  const lines = [
    "# HELP ledgerly_tenant_attention Tenants by attention level.",
    "# TYPE ledgerly_tenant_attention gauge",
    `ledgerly_tenant_attention{level="ok"} ${posture.tenants.filter((t) => t.attention === "ok").length}`,
    `ledgerly_tenant_attention{level="watch"} ${posture.tenants.filter((t) => t.attention === "watch").length}`,
    `ledgerly_tenant_attention{level="critical"} ${posture.tenants.filter((t) => t.attention === "critical").length}`,
    ...posture.tenants.map(
      (tenant) =>
        `ledgerly_tenant_outstanding{organization="${tenant.organizationId.slice(0, 12)}",kind="overdue_filings"} ${tenant.overdueFilings}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
