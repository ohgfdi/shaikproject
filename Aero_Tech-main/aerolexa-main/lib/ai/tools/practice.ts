/**
 * Practice READ tools: visible books and engagement/working-paper status.
 *
 * Book ids are returned only so the UI can offer a selection. No tool accepts
 * a book id from the model — the server fixes the book for the run after
 * validating it with assertBookTenant.
 *
 * Engagement access goes through the existing requireEngagementRole, so a
 * caller can never learn whether another firm's engagement exists (404).
 */

import { z } from "zod";

import { clip } from "@/lib/ai/format";
import { maskGstin, maskPan } from "@/lib/ai/redact";
import { objectSchema } from "@/lib/ai/tools/schema";
import type { ToolData, ToolDefinition } from "@/lib/ai/tools/types";
import { prisma } from "@/lib/db";
import { listBooks } from "@/lib/server/books";
import { requireEngagementRole } from "@/lib/server/engagement";

/* -------------------------------------------------------------------------- */
/* 14. Visible books                                                           */
/* -------------------------------------------------------------------------- */

const listBooksSchema = objectSchema({});

export const listVisibleBooks: ToolDefinition<z.infer<typeof listBooksSchema>> = {
  name: "list_books",
  module: "books",
  tier: "READ",
  requiresBook: false,
  description:
    "List the books visible to this user in the active organization/workspace. IDs are for the UI's book picker only. " +
    "Use when the user has not selected a book or asks which clients are available. " +
    "You cannot change the selected book with this tool; ask the user to choose in the UI.",
  schema: listBooksSchema,
  execute: async (_input, ctx): Promise<ToolData> => {
    const books = await listBooks(ctx.auth.workspace.id, ctx.auth.organization?.id ?? null);
    return {
      books: books.slice(0, 50).map((b) => ({
        bookId: b.id,
        name: clip(b.name, 100),
        legalName: clip(b.legalName, 120),
        entityType: b.entityType,
        fiscalYearEnd: b.fiscalYearEnd,
        gstin: maskGstin(b.gstin),
        pan: maskPan(b.pan),
        isDemo: b.isDemo,
      })),
      rowCount: Math.min(books.length, 50),
      total: books.length,
      truncated: books.length > 50,
      selectedBookId: ctx.bookId,
      note: ctx.bookId
        ? "A book is already selected for this run; tools operate only on it."
        : "No book is selected. Ask the user to pick one in the UI before asking for figures.",
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 15. Engagement + working paper status                                       */
/* -------------------------------------------------------------------------- */

const engagementSchema = objectSchema({});

export const engagementStatus: ToolDefinition<z.infer<typeof engagementSchema>> = {
  name: "engagement_status",
  module: "engagements",
  tier: "READ",
  requiresBook: false,
  description:
    "Status of the engagement selected for this run: client name/code, status, caller's practice role, working-paper counts by status and recent working papers. " +
    "Use for engagement progress and review-status questions. " +
    "It is scoped to ONE engagement chosen in the UI; it cannot list or cross into another firm's engagement. " +
    "It does not sign off, review or issue anything.",
  schema: engagementSchema,
  execute: async (_input, ctx): Promise<ToolData> => {
    if (!ctx.engagementId) {
      throw new Error(
        "No engagement is selected for this run. Ask the user to open an engagement in the UI; do not guess an engagement id.",
      );
    }
    const { role, engagement, project } = await requireEngagementRole(ctx.auth, ctx.engagementId, "ASSISTANT");

    const [statusGroups, papers, deliverableCount] = await Promise.all([
      prisma.workingPaper.groupBy({
        by: ["status"],
        where: { engagementId: engagement.id, organizationId: engagement.organizationId },
        _count: { _all: true },
      }),
      prisma.workingPaper.findMany({
        where: { engagementId: engagement.id, organizationId: engagement.organizationId },
        orderBy: [{ updatedAt: "desc" }],
        take: 15,
        select: {
          id: true,
          indexRef: true,
          title: true,
          section: true,
          status: true,
          saReference: true,
          classification: true,
          version: true,
          updatedAt: true,
        },
      }),
      prisma.engagementDeliverableVersion.count({ where: { engagementId: engagement.id } }),
    ]);

    return {
      engagement: {
        engagementId: engagement.id,
        name: clip(engagement.name, 120),
        code: engagement.code ?? null,
        status: engagement.status ?? null,
        jurisdiction: engagement.jurisdiction ?? null,
        dataClassification: engagement.dataClassification ?? null,
        legalHold: engagement.legalHold ?? false,
        retentionUntil: engagement.retentionUntil?.toISOString() ?? null,
        projectId: project?.id ?? null,
      },
      callerRole: role,
      workingPapers: {
        total: statusGroups.reduce((s, g) => s + g._count._all, 0),
        byStatus: statusGroups
          .map((g) => ({ status: g.status, count: g._count._all }))
          .sort((a, b) => a.status.localeCompare(b.status)),
        recent: papers.map((p) => ({
          workingPaperId: p.id,
          indexRef: p.indexRef,
          title: clip(p.title, 120),
          section: p.section,
          saReference: p.saReference,
          status: p.status,
          classification: p.classification,
          version: p.version,
          updatedAt: p.updatedAt.toISOString(),
        })),
        truncated: papers.length === 15,
      },
      deliverableVersionCount: deliverableCount,
      note: "Status is presented as recorded; this tool does not assert audit sufficiency or sign-off.",
    };
  },
};
