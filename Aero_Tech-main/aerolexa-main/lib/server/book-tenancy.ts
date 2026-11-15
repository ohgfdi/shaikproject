/**
 * Book tenancy.
 *
 * A `Book` may belong to an Organization (a CA firm sharing a client) or, for
 * legacy/personal books, only to a Workspace. Workspace access alone is not
 * sufficient once a book is organization-owned: every book route asserts the
 * active organization before the store is called.
 *
 * The store layer keeps its workspace check as defence in depth. This guard is
 * deliberately centralized so a new route cannot silently omit the org check
 * by forgetting to pass an extra argument through five layers.
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

export interface BookTenant {
  id: string;
  organizationId: string | null;
}

/** Load a book the caller may touch, or throw 404/403. */
export async function assertBookTenant(ctx: AuthContext, bookId: string): Promise<BookTenant> {
  const book = await prisma.book.findFirst({
    where: { id: bookId, workspaceId: ctx.workspace.id },
    select: { id: true, organizationId: true },
  });
  if (!book) throw new ApiError(404, "NOT_FOUND", "Book not found.");
  // Fail closed. An organization-owned book is visible only while that exact
  // organization is active. Previously the check ran only when an active org
  // happened to be present, so a caller between organization switches (or one
  // who never selected an org) could read another client's book.
  if (book.organizationId && book.organizationId !== ctx.organization?.id) {
    throw new ApiError(403, "FORBIDDEN", "This book belongs to a different organization.");
  }
  return book;
}

/** Prisma `where` fragment for listing books visible to the active tenant. */
export function visibleBooksWhere(ctx: AuthContext): {
  workspaceId: string;
  OR?: Array<{ organizationId: string | null }>;
} {
  const organizationId = ctx.organization?.id;
  return {
    workspaceId: ctx.workspace.id,
    OR: organizationId ? [{ organizationId: null }, { organizationId }] : [{ organizationId: null }],
  };
}
