/**
 * Statute review queue.
 *
 * The registry already ingests notifications and drafts rule versions, but a
 * reviewer had to know where to look. This read-only queue lists every
 * notification still needing a decision, with its source, proposed effective
 * date, matched rule slots and parser warnings. Publishing stays on the
 * existing draft/publish endpoints.
 */

import { prisma } from "@/lib/db";
import { parseJson } from "@/lib/json";

export interface StatuteReviewRow {
  id: string;
  title: string;
  authority: string;
  status: string;
  publishedAt: string | null;
  effectiveFrom: string | null;
  warningCount: number;
  impactedRuleKeys: string[];
  sourceName: string;
  url: string;
  fetchedAt: string;
}

export interface StatuteReviewSummary {
  pending: number;
  reviewing: number;
  applied: number;
  ignored: number;
  /** New rows with no proposed effective date or with parser warnings. */
  needsAttention: number;
  summary: string;
}

export function summarizeStatuteReview(
  rows: Array<{ status: string; warningCount: number; effectiveFrom: string | null }>,
): StatuteReviewSummary {
  const counts = { new: 0, reviewing: 0, applied: 0, ignored: 0 };
  let needsAttention = 0;
  for (const row of rows) {
    if (row.status === "new" || row.status === "reviewing" || row.status === "applied" || row.status === "ignored") {
      counts[row.status] += 1;
    }
    if (row.status !== "applied" && row.status !== "ignored" && (!row.effectiveFrom || row.warningCount > 0)) {
      needsAttention += 1;
    }
  }
  const pending = counts.new + counts.reviewing;
  return {
    pending,
    reviewing: counts.reviewing,
    applied: counts.applied,
    ignored: counts.ignored,
    needsAttention,
    summary:
      pending === 0
        ? counts.applied + counts.ignored === 0
          ? "No statute notifications have been ingested."
          : "No notification is awaiting review."
        : `${pending} notification(s) await a decision; ${needsAttention} need a missing date or parser warning resolved first.`,
  };
}

export async function getStatuteReviewQueue(
  workspaceId: string,
  limit = 50,
): Promise<{ items: StatuteReviewRow[]; summary: StatuteReviewSummary }> {
  const rows = await prisma.statuteNotification.findMany({
    where: { workspaceId, status: { in: ["new", "reviewing"] } },
    orderBy: { fetchedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    include: { source: { select: { name: true } } },
  });

  const items: StatuteReviewRow[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    authority: row.authority,
    status: row.status,
    publishedAt: row.publishedAt,
    effectiveFrom: row.effectiveFrom,
    warningCount: parseJson<string[]>(row.warnings, []).length,
    impactedRuleKeys: parseJson<string[]>(row.impactedRuleKeys, []),
    sourceName: row.source.name,
    url: row.url,
    fetchedAt: row.fetchedAt.toISOString(),
  }));

  return {
    items,
    summary: summarizeStatuteReview(
      items.map((item) => ({
        status: item.status,
        warningCount: item.warningCount,
        effectiveFrom: item.effectiveFrom,
      })),
    ),
  };
}
