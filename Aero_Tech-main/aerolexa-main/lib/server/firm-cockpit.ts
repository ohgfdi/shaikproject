/**
 * Firm cockpit — one queue for everything a partner has to act on today.
 *
 * The practice already records the facts in separate modules: filing runs,
 * deliverable versions, client invoices, document requests and GST exceptions.
 * Each page is useful on its own, but a partner should not have to open five
 * screens to answer "what is late, what is waiting on me, and what is waiting
 * on the client". This module merges those rows into a single ranked list.
 *
 * Rules kept honest here:
 *  - every item comes from a real row; nothing is generated or estimated;
 *  - severity is a function of the stored due date and stage, not of a score;
 *  - an overdue item keeps its real due date and age (no rounding to "today");
 *  - hrefs point at the page that owns the fix, so the queue never dead-ends.
 */

import type { AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

export type CockpitSeverity = "critical" | "warning" | "info";

export type CockpitKind = "filing" | "deliverable" | "invoice" | "document-request" | "gst";

export interface CockpitItem {
  id: string;
  kind: CockpitKind;
  title: string;
  detail: string;
  dueDate: string | null;
  href: string;
  severity: CockpitSeverity;
  /** Days past the due date (negative = days remaining), or null without one. */
  ageDays: number | null;
}

export interface CockpitSummary {
  items: CockpitItem[];
  total: number;
  counts: Record<CockpitSeverity, number>;
}

export interface CockpitFiling {
  id: string;
  title: string;
  engagementName: string;
  dueDate: string;
  stage: string;
}

export interface CockpitDeliverable {
  id: string;
  label: string;
  engagementName: string;
  status: string;
  updatedAt: string;
}

export interface CockpitInvoice {
  id: string;
  number: string;
  engagementName: string;
  dueDate: string;
  totalMinor: number;
  status: string;
}

export interface CockpitDocumentRequest {
  id: string;
  title: string;
  clientName: string;
  dueDate: string;
}

export interface CockpitInput {
  /** ISO yyyy-mm-dd. Injected so the ranking is testable without a clock. */
  today: string;
  filings: CockpitFiling[];
  deliverables: CockpitDeliverable[];
  invoices: CockpitInvoice[];
  requests: CockpitDocumentRequest[];
  /** GST invoices in the workspace not yet matched to GSTR-2A/2B. */
  unmatchedGstInvoices: number;
}

const SEVERITY_ORDER: Record<CockpitSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Whole days from `fromIso` to `toIso`, or null when either is not a date. */
export function daysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor((to - from) / 86_400_000);
}

function money(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function dueDetail(label: string, dueDate: string, today: string): { severity: CockpitSeverity; detail: string; ageDays: number } {
  const age = daysBetween(dueDate, today) ?? 0;
  if (age > 0) {
    return { severity: "critical", detail: `${label} · overdue by ${age} day${age === 1 ? "" : "s"}`, ageDays: age };
  }
  if (age === 0) {
    return { severity: "critical", detail: `${label} · due today`, ageDays: 0 };
  }
  return { severity: age >= -7 ? "warning" : "info", detail: `${label} · due in ${Math.abs(age)} day${age === -1 ? "" : "s"}`, ageDays: age };
}

/**
 * Rank the queue: critical first, then warning, then info; inside a severity,
 * the earliest due date wins and undated items come last. Pure and testable.
 */
export function buildCockpit(input: CockpitInput): CockpitSummary {
  const items: CockpitItem[] = [];

  for (const filing of input.filings) {
    if (filing.stage === "filed" || filing.stage === "acknowledged") continue;
    const age = daysBetween(filing.dueDate, input.today);
    if (age === null) continue;
    // Only surface obligations that are due within 30 days or already late.
    if (age < -30) continue;
    const ranked = dueDetail(`Stage: ${filing.stage.replace(/-/g, " ")}`, filing.dueDate, input.today);
    items.push({
      id: `filing:${filing.id}`,
      kind: "filing",
      title: `${filing.title} — ${filing.engagementName}`,
      detail: ranked.detail,
      dueDate: filing.dueDate,
      href: "/compliance/filings",
      severity: ranked.severity,
      ageDays: ranked.ageDays,
    });
  }

  for (const deliverable of input.deliverables) {
    const updatedOn = deliverable.updatedAt.slice(0, 10);
    const age = daysBetween(updatedOn, input.today);
    if (deliverable.status === "REVIEWED") {
      items.push({
        id: `deliverable:${deliverable.id}`,
        kind: "deliverable",
        title: `${deliverable.label} — ${deliverable.engagementName}`,
        detail: `Reviewed · awaiting partner sign-off${age && age > 0 ? ` (${age} day${age === 1 ? "" : "s"})` : ""}`,
        dueDate: null,
        href: "/deliverables",
        severity: age !== null && age > 3 ? "warning" : "info",
        ageDays: age,
      });
    } else if (deliverable.status === "IN_REVIEW" && age !== null && age > 14) {
      items.push({
        id: `deliverable:${deliverable.id}`,
        kind: "deliverable",
        title: `${deliverable.label} — ${deliverable.engagementName}`,
        detail: `In review for ${age} days`,
        dueDate: null,
        href: "/deliverables",
        severity: "warning",
        ageDays: age,
      });
    }
  }

  for (const invoice of input.invoices) {
    if (invoice.status !== "issued") continue;
    const ranked = dueDetail(`Invoice ${invoice.number} · ${money(invoice.totalMinor)}`, invoice.dueDate, input.today);
    // A not-yet-due invoice is informational; it only becomes work when late.
    if (ranked.ageDays < 0) continue;
    items.push({
      id: `invoice:${invoice.id}`,
      kind: "invoice",
      title: `${invoice.engagementName} — ${invoice.number}`,
      detail: ranked.detail,
      dueDate: invoice.dueDate,
      href: "/operations",
      severity: ranked.severity,
      ageDays: ranked.ageDays,
    });
  }

  for (const request of input.requests) {
    if (!request.dueDate) continue;
    const ranked = dueDetail(`Waiting on client · ${request.clientName}`, request.dueDate, input.today);
    if (ranked.ageDays < -3) continue;
    items.push({
      id: `request:${request.id}`,
      kind: "document-request",
      title: request.title,
      detail: ranked.detail,
      dueDate: request.dueDate,
      href: "/document-requests",
      severity: ranked.severity,
      ageDays: ranked.ageDays,
    });
  }

  if (input.unmatchedGstInvoices > 0) {
    items.push({
      id: "gst:unmatched",
      kind: "gst",
      title: "GST invoices not matched to GSTR-2A/2B",
      detail: `${input.unmatchedGstInvoices} invoice${input.unmatchedGstInvoices === 1 ? "" : "s"} need ITC reconciliation`,
      dueDate: null,
      href: "/gst-recon",
      severity: "info",
      ageDays: null,
    });
  }

  items.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;
    return a.title.localeCompare(b.title);
  });

  return {
    items,
    total: items.length,
    counts: {
      critical: items.filter((item) => item.severity === "critical").length,
      warning: items.filter((item) => item.severity === "warning").length,
      info: items.filter((item) => item.severity === "info").length,
    },
  };
}

export function emptyCockpit(): CockpitSummary {
  return { items: [], total: 0, counts: { critical: 0, warning: 0, info: 0 } };
}

/**
 * Read the firm's queue. Scoped by organization; a workspace with no firm yet
 * still gets the workspace GST exception count, and nothing else is invented.
 */
export async function getFirmCockpit(ctx: AuthContext): Promise<CockpitSummary> {
  const organizationId = ctx.organization?.id ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  const [filings, deliverables, invoices, requests, unmatchedGstInvoices] = await Promise.all([
    organizationId
      ? prisma.complianceFilingRun.findMany({
          where: {
            organizationId,
            stage: { notIn: ["filed", "acknowledged"] },
            dueDate: { lte: horizon },
          },
          select: {
            id: true,
            title: true,
            dueDate: true,
            stage: true,
            engagement: { select: { name: true } },
          },
          orderBy: { dueDate: "asc" },
          take: 50,
        })
      : Promise.resolve([]),
    organizationId
      ? prisma.engagementDeliverableVersion.findMany({
          where: {
            organizationId,
            variant: "CLIENT",
            status: { in: ["IN_REVIEW", "REVIEWED"] },
          },
          select: {
            id: true,
            status: true,
            updatedAt: true,
            format: { select: { label: true } },
            engagement: { select: { name: true } },
          },
          orderBy: { updatedAt: "asc" },
          take: 50,
        })
      : Promise.resolve([]),
    organizationId
      ? prisma.practiceInvoice.findMany({
          where: { organizationId, status: "issued" },
          select: {
            id: true,
            number: true,
            dueDate: true,
            totalMinor: true,
            status: true,
            engagement: { select: { name: true } },
          },
          orderBy: { dueDate: "asc" },
          take: 50,
        })
      : Promise.resolve([]),
    organizationId
      ? prisma.clientDocumentRequest.findMany({
          where: {
            engagement: { is: { organizationId } },
            status: "requested",
          },
          select: { id: true, title: true, clientName: true, dueDate: true },
          orderBy: { dueDate: "asc" },
          take: 50,
        })
      : Promise.resolve([]),
    prisma.gstInvoice.count({
      where: { book: { workspaceId: ctx.workspace.id }, matched2a2b: false },
    }),
  ]);

  return buildCockpit({
    today,
    filings: filings.map((row) => ({
      id: row.id,
      title: row.title,
      engagementName: row.engagement.name,
      dueDate: row.dueDate,
      stage: row.stage,
    })),
    deliverables: deliverables.map((row) => ({
      id: row.id,
      label: row.format?.label ?? "Deliverable",
      engagementName: row.engagement.name,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
    })),
    invoices: invoices.map((row) => ({
      id: row.id,
      number: row.number,
      engagementName: row.engagement.name,
      dueDate: row.dueDate,
      totalMinor: row.totalMinor,
      status: row.status,
    })),
    requests,
    unmatchedGstInvoices,
  });
}
