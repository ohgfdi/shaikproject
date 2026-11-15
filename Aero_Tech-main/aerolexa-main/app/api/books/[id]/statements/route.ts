import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import { getStatements } from "@/lib/server/books";

export const dynamic = "force-dynamic";

/** GET /api/books/[id]/statements?from&to — trial balance, P&L, balance sheet, cash flow. */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const range = {
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    };
    return ok(await getStatements(ctx.workspace.id, params.id, range));
  } catch (err) {
    return toErrorResponse(err);
  }
}
