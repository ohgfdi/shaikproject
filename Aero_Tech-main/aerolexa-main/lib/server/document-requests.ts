/**
 * Client document requests — the "chase" half of document collection.
 *
 * A firm's most common beginner pain is not receiving a document; it is
 * remembering which client owes which document, since when, and how many times
 * they have been asked. Each request therefore stores its deadline, status and
 * a reminder trail, and every reminder is recorded even when no email goes out
 * (a request without a client address is still chased in-app).
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { sendMail } from "@/lib/auth/mail";
import { prisma } from "@/lib/db";
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "@/lib/engine/ca-documents";
import { requireEngagementRole } from "@/lib/server/engagement";
import { assertIsoDate } from "@/lib/server/finance-validation";

export const DOCUMENT_REQUEST_STATUSES = ["requested", "received", "waived"] as const;
export type DocumentRequestStatus = (typeof DOCUMENT_REQUEST_STATUSES)[number];

export class DocumentRequestError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "DocumentRequestError";
  }
}

export interface DocumentRequestInput {
  clientName: string;
  clientEmail?: string | null;
  title: string;
  category: DocumentCategory;
  period?: string | null;
  dueDate: string;
  notes?: string | null;
  bookId?: string | null;
}

function requireText(value: string | null | undefined, label: string): string {
  const text = (value ?? "").trim();
  if (!text) throw new DocumentRequestError(400, "VALIDATION", `${label} is required.`);
  return text;
}

async function requireRequest(workspaceId: string, id: string) {
  const request = await prisma.clientDocumentRequest.findFirst({ where: { id, workspaceId } });
  if (!request) throw new DocumentRequestError(404, "NOT_FOUND", "Document request not found.");
  return request;
}

export async function createDocumentRequest(
  workspaceId: string,
  input: DocumentRequestInput,
  actorId: string,
) {
  const category = input.category;
  if (!DOCUMENT_CATEGORIES.includes(category)) {
    throw new DocumentRequestError(400, "VALIDATION", `Unknown document category “${String(category)}”.`);
  }
  assertIsoDate(input.dueDate, "Due date");
  const email = input.clientEmail?.trim() ?? "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new DocumentRequestError(400, "VALIDATION", "Client email is not a valid address.");
  }
  if (input.bookId) {
    const book = await prisma.book.findFirst({ where: { id: input.bookId, workspaceId }, select: { id: true } });
    if (!book) throw new DocumentRequestError(404, "NOT_FOUND", "Book not found in this workspace.");
  }

  return prisma.clientDocumentRequest.create({
    data: {
      workspaceId,
      bookId: input.bookId ?? null,
      clientName: requireText(input.clientName, "Client name"),
      clientEmail: email || null,
      title: requireText(input.title, "Document title"),
      category,
      period: input.period?.trim() || null,
      dueDate: input.dueDate,
      status: "requested",
      notes: input.notes?.trim() || null,
      requestedById: actorId,
    },
  });
}

export async function listDocumentRequests(
  workspaceId: string,
  opts: { status?: string; bookId?: string; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 500);
  return prisma.clientDocumentRequest.findMany({
    where: {
      workspaceId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.bookId ? { bookId: opts.bookId } : {}),
    },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
}

/** Move a request between requested / received / waived. */
export async function setDocumentRequestStatus(workspaceId: string, id: string, status: DocumentRequestStatus) {
  if (!DOCUMENT_REQUEST_STATUSES.includes(status)) {
    throw new DocumentRequestError(400, "VALIDATION", `Unknown status “${String(status)}”.`);
  }
  await requireRequest(workspaceId, id);
  return prisma.clientDocumentRequest.update({
    where: { id },
    data: {
      status,
      receivedAt: status === "received" ? new Date() : null,
    },
  });
}

// ---------------------------------------------------------------------------
// Engagement-scoped requests (the client portal)
// ---------------------------------------------------------------------------

export interface EngagementDocumentRequestInput {
  title: string;
  category: DocumentCategory;
  period?: string | null;
  dueDate: string;
  notes?: string | null;
}

/** Create a document request that the client can see and answer in their portal. */
export async function createEngagementDocumentRequest(
  ctx: AuthContext,
  engagementId: string,
  input: EngagementDocumentRequestInput,
) {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  if (!DOCUMENT_CATEGORIES.includes(input.category)) {
    throw new DocumentRequestError(400, "VALIDATION", `Unknown document category “${String(input.category)}”.`);
  }
  assertIsoDate(input.dueDate, "Due date");

  return prisma.clientDocumentRequest.create({
    data: {
      workspaceId: ctx.workspace.id,
      engagementId: engagement.id,
      clientName: engagement.name ?? "Client",
      title: requireText(input.title, "Document title"),
      category: input.category,
      period: input.period?.trim() || null,
      dueDate: input.dueDate,
      status: "requested",
      notes: input.notes?.trim() || null,
      requestedById: ctx.user.id,
    },
  });
}

/** Requests for one engagement, open first. Used by the portal panel and the client portal. */
export async function listEngagementDocumentRequests(ctx: AuthContext, engagementId: string) {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  return prisma.clientDocumentRequest.findMany({
    where: { engagementId: engagement.id },
    orderBy: [{ status: "asc" }, { dueDate: "asc" }],
    take: 100,
  });
}

export interface ReminderResult {
  requestId: string;
  reminderCount: number;
  lastRemindedAt: Date;
  emailDelivered: boolean;
  /** Present when delivery was attempted and failed; the reminder still counts. */
  emailError: string | null;
}

/**
 * Record a chase. The reminder is always recorded; email delivery is attempted
 * only when the client has an address, and a delivery failure is reported to
 * the caller rather than swallowed — a silently unsent reminder is the exact
 * failure mode this feature exists to prevent.
 */
export async function recordReminder(workspaceId: string, id: string): Promise<ReminderResult> {
  const request = await requireRequest(workspaceId, id);
  if (request.status !== "requested") {
    throw new DocumentRequestError(409, "NOT_OPEN", "Only an open request can be reminded.");
  }

  let emailDelivered = false;
  let emailError: string | null = null;
  if (request.clientEmail) {
    try {
      await sendMail({
        to: request.clientEmail,
        subject: `Reminder: ${request.title}${request.period ? ` (${request.period})` : ""}`,
        text: [
          `Dear ${request.clientName},`,
          "",
          `We are still waiting for: ${request.title}${request.period ? ` for ${request.period}` : ""}.`,
          `It was requested by our office and is due on ${request.dueDate}.`,
          request.notes ? `\nNote: ${request.notes}` : "",
          "",
          "Please share it at your earliest convenience so the filing is not delayed.",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      emailDelivered = true;
    } catch (err) {
      emailError = err instanceof Error ? err.message : "Mail transport failed.";
    }
  }

  const updated = await prisma.clientDocumentRequest.update({
    where: { id },
    data: { reminderCount: { increment: 1 }, lastRemindedAt: new Date() },
  });

  return {
    requestId: updated.id,
    reminderCount: updated.reminderCount,
    lastRemindedAt: updated.lastRemindedAt ?? new Date(),
    emailDelivered,
    emailError,
  };
}
