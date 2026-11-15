/**
 * GST notice repository — the persistence layer behind the notices workspace.
 *
 * The models (`GstNotice`, `GstNoticeResponse`) existed in the schema with no
 * writer, so a firm could compute a notice worklist in memory but could not
 * record a notice, its deadline or its reply. Everything here is workspace
 * scoped: a notice id is never trusted without its workspace, which is the
 * whole point of holding client tax disputes in one firm account.
 *
 * Money is stored in MINOR UNITS (paise) as integers, matching every CA engine.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import type { AuthorityLevel, GstNotice as EngineNotice, NoticeStatus, NoticeType } from "@/lib/engine/gst-notice-workflow";
import { parseJson, stringifyJson } from "@/lib/json";
import {
  AUTHORITY_LEVELS,
  NOTICE_PRIORITIES,
  NOTICE_STATUSES,
  NOTICE_TYPES,
} from "@/lib/notice-constants";
import { assertIsoDate, assertMinorUnits } from "@/lib/server/finance-validation";

// Re-exported for the API routes; the browser imports the same list from
// `@/lib/notice-constants` so Prisma never reaches a client bundle.
export { AUTHORITY_LEVELS, NOTICE_PRIORITIES, NOTICE_STATUSES, NOTICE_TYPES };

/** Notice priorities are a closed set. */
export type NoticePriority = (typeof NOTICE_PRIORITIES)[number];

export class GstNoticeError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "GstNoticeError";
  }
}

export interface NoticeInput {
  noticeNumber: string;
  noticeDate: string;
  noticeType: NoticeType;
  authorityLevel: AuthorityLevel;
  authorityName: string;
  authorityJurisdiction: string;
  gstin: string;
  entityName: string;
  period?: string | null;
  financialYear?: string | null;
  subject: string;
  description: string;
  sections: string[];
  rules: string[];
  /** Minor units. */
  demandedTax?: number;
  demandedInterest?: number;
  demandedPenalty?: number;
  responseDueDate: string;
  status?: NoticeStatus;
  assignedTo?: string | null;
  priority?: NoticePriority;
  tags?: string[];
  bookId?: string | null;
}

export interface NoticeResponseInput {
  responseNumber: string;
  responseDate: string;
  responseType: "reply" | "clarification" | "payment" | "appeal" | "rectification" | "hearing-request";
  status?: "draft" | "reviewed" | "approved" | "filed" | "withdrawn";
  content: {
    facts: string;
    legalArguments: string[];
    evidenceReferences: string[];
    computations: { head: string; demanded: number; admitted: number; disputed: number; basis: string }[];
    prayers: string[];
  };
  attachments?: { name: string; type: string; ref: string }[];
  filingMode?: "portal" | "physical" | "email";
  filedDate?: string | null;
  acknowledgmentRef?: string | null;
}

function requireText(value: string | undefined | null, label: string): string {
  const text = (value ?? "").trim();
  if (!text) throw new GstNoticeError(400, "VALIDATION", `${label} is required.`);
  return text;
}

function assertGstin(value: string): string {
  const gstin = value.trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    throw new GstNoticeError(400, "VALIDATION", "GSTIN must be a 15-character registration number.");
  }
  return gstin;
}

/** Load a notice, asserting it belongs to the caller's workspace. */
async function requireNotice(workspaceId: string, id: string) {
  const notice = await prisma.gstNotice.findFirst({ where: { id, workspaceId } });
  if (!notice) throw new GstNoticeError(404, "NOT_FOUND", "Notice not found.");
  return notice;
}

export async function createNotice(workspaceId: string, input: NoticeInput) {
  const gstin = assertGstin(requireText(input.gstin, "GSTIN"));
  assertIsoDate(input.noticeDate, "Notice date");
  assertIsoDate(input.responseDueDate, "Response due date");
  if (input.bookId) {
    const book = await prisma.book.findFirst({ where: { id: input.bookId, workspaceId }, select: { id: true } });
    if (!book) throw new GstNoticeError(404, "NOT_FOUND", "Book not found in this workspace.");
  }
  if (input.noticeType && !NOTICE_TYPES.includes(input.noticeType)) {
    throw new GstNoticeError(400, "VALIDATION", `Unknown notice type “${input.noticeType}”.`);
  }

  const demandedTax = input.demandedTax ?? 0;
  const demandedInterest = input.demandedInterest ?? 0;
  const demandedPenalty = input.demandedPenalty ?? 0;
  for (const [label, value] of [
    ["Demanded tax", demandedTax],
    ["Demanded interest", demandedInterest],
    ["Demanded penalty", demandedPenalty],
  ] as const) {
    assertMinorUnits(value, label);
    if (value < 0) throw new GstNoticeError(400, "VALIDATION", `${label} cannot be negative.`);
  }

  const duplicate = await prisma.gstNotice.findFirst({
    where: { workspaceId, gstin, noticeNumber: input.noticeNumber.trim() },
    select: { id: true },
  });
  if (duplicate) {
    throw new GstNoticeError(409, "DUPLICATE", `Notice ${input.noticeNumber} is already recorded for this GSTIN.`);
  }

  return prisma.gstNotice.create({
    data: {
      workspaceId,
      bookId: input.bookId ?? null,
      noticeNumber: requireText(input.noticeNumber, "Notice number"),
      noticeDate: input.noticeDate,
      noticeType: input.noticeType,
      authorityLevel: input.authorityLevel,
      authorityName: requireText(input.authorityName, "Authority name"),
      authorityJurisdiction: requireText(input.authorityJurisdiction, "Authority jurisdiction"),
      gstin,
      entityName: requireText(input.entityName, "Entity name"),
      period: input.period ?? null,
      financialYear: input.financialYear ?? null,
      subject: requireText(input.subject, "Subject"),
      description: requireText(input.description, "Description"),
      sections: stringifyJson(input.sections ?? []),
      rules: stringifyJson(input.rules ?? []),
      demandedTax,
      demandedInterest,
      demandedPenalty,
      responseDueDate: input.responseDueDate,
      status: input.status ?? "received",
      assignedTo: input.assignedTo ?? null,
      priority: input.priority ?? "medium",
      tags: stringifyJson(input.tags ?? []),
    },
  });
}

export async function listNotices(
  workspaceId: string,
  opts: { status?: string; gstin?: string; bookId?: string; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  return prisma.gstNotice.findMany({
    where: {
      workspaceId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.gstin ? { gstin: opts.gstin.toUpperCase() } : {}),
      ...(opts.bookId ? { bookId: opts.bookId } : {}),
    },
    orderBy: [{ responseDueDate: "asc" }, { noticeNumber: "asc" }],
    take: limit,
    include: { _count: { select: { responses: true } } },
  });
}

export async function getNotice(workspaceId: string, id: string) {
  const notice = await prisma.gstNotice.findFirst({
    where: { id, workspaceId },
    include: { responses: { orderBy: { createdAt: "desc" } } },
  });
  if (!notice) throw new GstNoticeError(404, "NOT_FOUND", "Notice not found.");
  return notice;
}

/** Advance the working state of a notice. */
export async function updateNotice(
  workspaceId: string,
  id: string,
  patch: { status?: NoticeStatus; priority?: NoticePriority; assignedTo?: string | null },
) {
  await requireNotice(workspaceId, id);
  const data: Record<string, unknown> = {};
  if (patch.status !== undefined) {
    if (!NOTICE_STATUSES.includes(patch.status)) {
      throw new GstNoticeError(400, "VALIDATION", `Unknown notice status “${patch.status}”.`);
    }
    data.status = patch.status;
  }
  if (patch.priority !== undefined) {
    if (!NOTICE_PRIORITIES.includes(patch.priority)) {
      throw new GstNoticeError(400, "VALIDATION", `Unknown priority “${patch.priority}”.`);
    }
    data.priority = patch.priority;
  }
  if (patch.assignedTo !== undefined) data.assignedTo = patch.assignedTo;
  if (Object.keys(data).length === 0) {
    throw new GstNoticeError(400, "VALIDATION", "Nothing to update.");
  }
  return prisma.gstNotice.update({ where: { id }, data });
}

/**
 * Save a response draft. Saving a draft moves a freshly received notice into
 * `response-drafting` so the worklist reflects that somebody has started the
 * reply; it never marks a notice filed — that is a separate, deliberate status.
 */
export async function saveResponse(workspaceId: string, noticeId: string, input: NoticeResponseInput, actorId: string) {
  const notice = await requireNotice(workspaceId, noticeId);
  assertIsoDate(input.responseDate, "Response date");
  const response = await prisma.gstNoticeResponse.create({
    data: {
      workspaceId,
      noticeId,
      responseNumber: requireText(input.responseNumber, "Response number"),
      responseDate: input.responseDate,
      responseType: input.responseType,
      draftedBy: actorId,
      status: input.status ?? "draft",
      content: stringifyJson(input.content),
      attachments: stringifyJson(input.attachments ?? []),
      filingMode: input.filingMode ?? "portal",
      filedDate: input.filedDate ?? null,
      acknowledgmentRef: input.acknowledgmentRef ?? null,
    },
  });

  if (notice.status === "received" || notice.status === "under-review") {
    await prisma.gstNotice.update({ where: { id: noticeId }, data: { status: "response-drafting" } });
  }
  return response;
}

/** Map a stored row to the engine's `GstNotice` shape. */
export function toEngineNotice(row: {
  id: string;
  noticeNumber: string;
  noticeDate: string;
  noticeType: string;
  authorityLevel: string;
  authorityName: string;
  authorityJurisdiction: string;
  gstin: string;
  entityName: string;
  period: string | null;
  financialYear: string | null;
  subject: string;
  description: string;
  sections: string;
  rules: string;
  demandedTax: number;
  demandedInterest: number;
  demandedPenalty: number;
  responseDueDate: string;
  status: string;
  assignedTo: string | null;
  priority: string;
  tags: string;
  createdAt: Date;
  updatedAt: Date;
}): EngineNotice {
  const total = row.demandedTax + row.demandedInterest + row.demandedPenalty;
  return {
    id: row.id,
    noticeNumber: row.noticeNumber,
    noticeDate: row.noticeDate,
    noticeType: row.noticeType as NoticeType,
    authorityLevel: row.authorityLevel as AuthorityLevel,
    authorityName: row.authorityName,
    authorityJurisdiction: row.authorityJurisdiction,
    gstin: row.gstin,
    entityName: row.entityName,
    period: row.period ?? undefined,
    financialYear: row.financialYear ?? undefined,
    subject: row.subject,
    description: row.description,
    sections: parseJson<string[]>(row.sections, []),
    rules: parseJson<string[]>(row.rules, []),
    demandedAmount:
      total > 0
        ? { tax: row.demandedTax, interest: row.demandedInterest, penalty: row.demandedPenalty, total }
        : undefined,
    responseDueDate: row.responseDueDate,
    status: row.status as NoticeStatus,
    assignedTo: row.assignedTo ?? undefined,
    priority: row.priority as EngineNotice["priority"],
    tags: parseJson<string[]>(row.tags, []),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
