/**
 * Deliverables hub — the firm-wide register of client deliverables.
 *
 * The assembly / review / sign-off / issuance / UDIN pipeline already exists in
 * the engagement API. What never existed was a place to see it across clients,
 * which is why the client portal had nothing to publish. This module is the
 * read side of that hub.
 *
 * Access is resolved per engagement through `engagementPracticeRole` (the same
 * precedence as every engagement route), and the query is then constrained to
 * those engagement ids — an engagement the caller cannot act on contributes
 * neither rows nor totals.
 */

// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - deliverables hub is a deployment-wide aggregate operation
import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { engagementPracticeRole } from "@/lib/server/engagement";
import { requireOrgRole } from "@/lib/server/members";
import type { PracticeRole } from "@/lib/types";

export const HUB_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "REVIEWED",
  "SIGNED_OFF",
  "ISSUED",
  "SUPERSEDED",
  "WITHDRAWN",
  "ARCHIVED",
] as const;

export interface HubDeliverable {
  id: string;
  engagementId: string;
  engagementName: string;
  engagementCode: string | null;
  formatCode: string;
  formatLabel: string;
  revision: number;
  variant: string;
  status: string;
  udin: string | null;
  udinSource: string | null;
  documentReference: string | null;
  issuedAt: string | null;
  signedOffAt: string | null;
  updatedAt: string;
}

export interface HubEngagement {
  id: string;
  name: string;
  code: string | null;
  role: PracticeRole;
}

export interface HubFormat {
  code: string;
  label: string;
}

export interface HubTotals {
  total: number;
  byStatus: Record<string, number>;
  /** Anything still moving through the firm: not issued/superseded/withdrawn/archived. */
  outstanding: number;
  issued: number;
}

export interface DeliverablesHubResult {
  deliverables: HubDeliverable[];
  engagements: HubEngagement[];
  formats: HubFormat[];
  totals: HubTotals;
  truncated: boolean;
}

export interface HubFilters {
  engagementId?: string;
  status?: string;
  formatCode?: string;
  limit?: number;
}

const CLOSED_STATUSES = new Set(["ISSUED", "SUPERSEDED", "WITHDRAWN", "ARCHIVED"]);

/** Pure roll-up used by the hub and pinned by tests. */
export function summariseHubTotals(counts: { status: string; count: number }[]): HubTotals {
  const byStatus: Record<string, number> = {};
  let total = 0;
  let issued = 0;
  let outstanding = 0;
  for (const row of counts) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
    total += row.count;
    if (row.status === "ISSUED") issued += row.count;
    if (!CLOSED_STATUSES.has(row.status)) outstanding += row.count;
  }
  return { total, byStatus, outstanding, issued };
}

const MAX_ENGAGEMENTS = 100;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * Firm-wide deliverables, filtered and access-scoped.
 *
 * Status/format filters apply to the rows returned; totals are computed across
 * every accessible version that matches the engagement filter (not just the
 * page), so the dashboard counts do not lie when a filter or limit is applied.
 */
export async function listFirmDeliverables(
  ctx: AuthContext,
  filters: HubFilters = {},
): Promise<DeliverablesHubResult> {
  if (!ctx.organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  const organizationId = ctx.organization.id;
  await requireOrgRole(ctx, organizationId, "MEMBER");

  const engagements = await prisma.engagement.findMany({
    where: { organizationId, status: { not: "ARCHIVED" } },
    select: {
      id: true,
      organizationId: true,
      name: true,
      code: true,
      status: true,
      jurisdiction: true,
      projects: {
        select: { id: true, ownerId: true, workspaceId: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_ENGAGEMENTS,
  });

  const resolved = await Promise.all(
    engagements.map(async (engagement) => ({
      engagement,
      role: await engagementPracticeRole(ctx, engagement, engagement.projects[0] ?? null),
    })),
  );
  const accessible = resolved.filter(
    (item): item is { engagement: (typeof engagements)[number]; role: PracticeRole } => item.role !== null,
  );

  if (filters.engagementId && !accessible.some((item) => item.engagement.id === filters.engagementId)) {
    // Do not reveal whether the id exists elsewhere in the firm.
    throw new ApiError(404, "NOT_FOUND", "Engagement not found.");
  }

  const engagementIds = filters.engagementId
    ? [filters.engagementId]
    : accessible.map((item) => item.engagement.id);
  if (engagementIds.length === 0) {
    return {
      deliverables: [],
      engagements: [],
      formats: [],
      totals: summariseHubTotals([]),
      truncated: false,
    };
  }

  const status = filters.status && filters.status !== "ALL" ? filters.status : undefined;
  const formatCode = filters.formatCode && filters.formatCode !== "ALL" ? filters.formatCode : undefined;
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);

  const where = {
    organizationId,
    engagementId: { in: engagementIds },
    ...(status ? { status } : {}),
    ...(formatCode ? { formatCode } : {}),
  };

  const [rows, grouped] = await Promise.all([
    prisma.engagementDeliverableVersion.findMany({
      where,
      select: {
        id: true,
        engagementId: true,
        formatCode: true,
        revision: true,
        variant: true,
        status: true,
        udin: true,
        udinSource: true,
        documentReference: true,
        issuedAt: true,
        signedOffAt: true,
        updatedAt: true,
        format: { select: { label: true } },
        engagement: { select: { name: true, code: true } },
      },
      orderBy: [{ updatedAt: "desc" }],
      take: limit,
    }),
    prisma.engagementDeliverableVersion.groupBy({
      by: ["status"],
      where,
      _count: { _all: true },
    }),
  ]);

  const deliverables: HubDeliverable[] = rows.map((row) => ({
    id: row.id,
    engagementId: row.engagementId,
    engagementName: row.engagement.name,
    engagementCode: row.engagement.code,
    formatCode: row.formatCode,
    formatLabel: row.format?.label ?? row.formatCode,
    revision: row.revision,
    variant: row.variant,
    status: row.status,
    udin: row.udin,
    udinSource: row.udinSource,
    documentReference: row.documentReference,
    issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
    signedOffAt: row.signedOffAt ? row.signedOffAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  }));

  const formats = [
    ...new Map(deliverables.map((d) => [d.formatCode, { code: d.formatCode, label: d.formatLabel }])).values(),
  ].sort((a, b) => a.label.localeCompare(b.label));

  return {
    deliverables,
    engagements: accessible.map(({ engagement, role }) => ({
      id: engagement.id,
      name: engagement.name,
      code: engagement.code,
      role,
    })),
    formats,
    totals: summariseHubTotals(grouped.map((g) => ({ status: g.status, count: g._count._all }))),
    truncated: rows.length === limit && grouped.reduce((sum, g) => sum + g._count._all, 0) > rows.length,
  };
}
