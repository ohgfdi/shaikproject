/**
 * Book Audit Trail — immutable log of every change to books data.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";

export class BookAuditStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "BookAuditStoreError";
  }
}

export interface AuditEntryFilter {
  entityType?: string;
  entityId?: string;
  action?: string;
  actorId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function requireBookAccess(ctx: { workspaceId: string }, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId: ctx.workspaceId } });
  if (!book) throw new BookAuditStoreError(404, "NOT_FOUND", "Book not found in this workspace.");
  return book;
}

export async function listAuditEntries(workspaceId: string, bookId: string, filter: AuditEntryFilter = {}) {
  await requireBookAccess({ workspaceId }, bookId);

  const where: Record<string, unknown> = { bookId };
  if (filter.entityType) where.entityType = filter.entityType;
  if (filter.entityId) where.entityId = filter.entityId;
  if (filter.action) where.action = filter.action;
  if (filter.actorId) where.actorId = filter.actorId;
  if (filter.from || filter.to) {
    where.createdAt = {};
    if (filter.from) (where.createdAt as Record<string, string>).gte = filter.from;
    if (filter.to) (where.createdAt as Record<string, string>).lte = filter.to;
  }

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);

  const [entries, total] = await Promise.all([
    prisma.bookAuditEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.bookAuditEntry.count({ where }),
  ]);

  return { entries, total, limit, offset };
}

export async function getAuditEntry(workspaceId: string, bookId: string, entryId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const entry = await prisma.bookAuditEntry.findFirst({ where: { id: entryId, bookId } });
  if (!entry) throw new BookAuditStoreError(404, "NOT_FOUND", "Audit entry not found.");
  return entry;
}

export async function getEntityAuditHistory(workspaceId: string, bookId: string, entityType: string, entityId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  return prisma.bookAuditEntry.findMany({
    where: { bookId, entityType, entityId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Write an audit entry. Call this from all create/update/delete operations.
 */
export async function writeAuditEntry(
  workspaceId: string,
  bookId: string,
  entityType: string,
  entityId: string,
  action: string,
  actorId: string,
  fieldChanges?: Record<string, { old: unknown; new: unknown }>,
  before?: unknown,
  after?: unknown,
  actorName?: string,
  ipAddress?: string,
  userAgent?: string,
) {
  await requireBookAccess({ workspaceId }, bookId);

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType,
      entityId,
      action,
      fieldChanges: fieldChanges ? stringifyJson(fieldChanges) : null,
      before: before ? stringifyJson(before) : null,
      after: after ? stringifyJson(after) : null,
      actorId,
      actorName,
      ipAddress,
      userAgent,
    },
  });
}

/**
 * Write multiple audit entries in a single transaction.
 */
export async function writeAuditEntries(
  workspaceId: string,
  bookId: string,
  entries: Array<{
    entityType: string;
    entityId: string;
    action: string;
    fieldChanges?: Record<string, { old: unknown; new: unknown }>;
    before?: unknown;
    after?: unknown;
  }>,
  actorId: string,
  actorName?: string,
  ipAddress?: string,
  userAgent?: string,
) {
  await requireBookAccess({ workspaceId }, bookId);

  await prisma.bookAuditEntry.createMany({
    data: entries.map((e) => ({
      bookId,
      entityType: e.entityType,
      entityId: e.entityId,
      action: e.action,
      fieldChanges: e.fieldChanges ? stringifyJson(e.fieldChanges) : null,
      before: e.before ? stringifyJson(e.before) : null,
      after: e.after ? stringifyJson(e.after) : null,
      actorId,
      actorName,
      ipAddress,
      userAgent,
    })),
  });
}

/**
 * Generate a human-readable audit report for a book over a date range.
 */
export async function generateAuditReport(workspaceId: string, bookId: string, from: string, to: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const entries = await prisma.bookAuditEntry.findMany({
    where: { bookId, createdAt: { gte: from, lte: to } },
    orderBy: { createdAt: "asc" },
  });

  // Group by entity type and action
  const byEntity = new Map<string, Map<string, number>>();
  const byActor = new Map<string, number>();

  for (const e of entries) {
    const entityMap = byEntity.get(e.entityType) ?? new Map();
    entityMap.set(e.action, (entityMap.get(e.action) ?? 0) + 1);
    byEntity.set(e.entityType, entityMap);

    byActor.set(e.actorId, (byActor.get(e.actorId) ?? 0) + 1);
  }

  return {
    period: { from, to },
    totalEntries: entries.length,
    byEntityType: Object.fromEntries(
      Array.from(byEntity.entries()).map(([type, actions]) => [type, Object.fromEntries(actions)]),
    ),
    byActor: Object.fromEntries(byActor),
    entries: entries.map((e) => ({
      id: e.id,
      entityType: e.entityType,
      entityId: e.entityId,
      action: e.action,
      actorId: e.actorId,
      actorName: e.actorName,
      createdAt: e.createdAt,
      fieldChanges: e.fieldChanges ? JSON.parse(e.fieldChanges) : null,
    })),
  };
}
