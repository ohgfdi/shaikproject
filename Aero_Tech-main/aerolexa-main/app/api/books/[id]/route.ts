import { requireAuth } from "@/lib/auth/guard";
import { defineRoute, ok, toErrorResponse } from "@/lib/server/api";
import { getBookSnapshot } from "@/lib/server/books";

export const dynamic = "force-dynamic";

export const GET = defineRoute(async (ctx) => {
  try {
    const auth = await requireAuth();
    return ok(await getBookSnapshot(auth.workspace.id, ctx.params.bookId!));
  } catch (err) {
    return toErrorResponse(err);
  }
});
