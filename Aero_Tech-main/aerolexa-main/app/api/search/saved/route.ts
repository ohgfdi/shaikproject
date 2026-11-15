import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { serializeSavedSearch, validateSavedSearch } from "@/lib/search/facets";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

/**
 * Saved searches (search upgrade).
 *
 * GET  /api/search/saved — the caller's saved searches, newest first.
 * POST /api/search/saved — save { query, type?, sort?, name? }.
 *
 * A saved search is a reproducible (query, type facet, sort) triple stored
 * as normalized JSON (lib/search/facets.ts) and re-run through the same
 * ranking code as a manual search. Scoped to workspace + user; the
 * (userId, name) unique index makes re-saving with the same label an
 * explicit client-side replace, not a silent dup.
 */
export async function GET() {
  try {
    const ctx = await requireAuth();
    const rows = await prisma.savedSearch.findMany({
      where: { workspaceId: ctx.workspace.id, userId: ctx.user.id },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    return ok({
      saved: rows.map((r) => ({
        id: r.id,
        name: r.name,
        query: r.query,
        filter: r.filter,
        href: `/search?q=${encodeURIComponent(r.query)}`,
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{ query?: unknown; type?: unknown; sort?: unknown; name?: unknown }>(request);

    const validation = validateSavedSearch({
      query: typeof body.query === "string" ? body.query : "",
      type: typeof body.type === "string" ? body.type : null,
      sort: body.sort === "recent" ? "recent" : "relevance",
    });
    if (!validation.ok || !validation.value) {
      throw new ApiError(400, "VALIDATION", validation.reason ?? "Invalid saved search.");
    }
    const value = validation.value;

    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : value.query.slice(0, 80);

    const existing = await prisma.savedSearch.findUnique({
      where: { userId_name: { userId: ctx.user.id, name } },
      select: { id: true },
    });

    const row = existing
      ? await prisma.savedSearch.update({
          where: { id: existing.id },
          data: { query: value.query, filter: serializeSavedSearch(value) },
        })
      : await prisma.savedSearch.create({
          data: {
            workspaceId: ctx.workspace.id,
            userId: ctx.user.id,
            name,
            query: value.query,
            filter: serializeSavedSearch(value),
          },
        });

    return ok({
      id: row.id,
      name: row.name,
      query: row.query,
      filter: row.filter,
      href: `/search?q=${encodeURIComponent(row.query)}`,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/search/saved?name=… — remove one saved search by label
 * (the (userId, name) pair is the natural key the client holds).
 */
export async function DELETE(request: Request) {
  try {
    const ctx = await requireAuth();
    const name = new URL(request.url).searchParams.get("name") ?? "";
    if (!name) throw new ApiError(400, "VALIDATION", "A saved-search name is required.");
    const existing = await prisma.savedSearch.findUnique({
      where: { userId_name: { userId: ctx.user.id, name } },
      select: { id: true, workspaceId: true },
    });
    if (!existing || existing.workspaceId !== ctx.workspace.id) {
      throw new ApiError(404, "NOT_FOUND", "Saved search not found.");
    }
    await prisma.savedSearch.delete({ where: { id: existing.id } });
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
