import { requireAuth } from "@/lib/auth/guard";
import type { AccountType } from "@/lib/engine/accounting";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import { addAccount, getBookSnapshot } from "@/lib/server/books";

export const dynamic = "force-dynamic";

// Origin/CSRF guard for cookie-authenticated POST mutations.
function originGuard(request: Request, allowedOrigins?: string[]): void {
  const origin = request.headers.get("origin");
  if (!origin) return; // no origin (same-origin or null) is acceptable
  if (!allowedOrigins || allowedOrigins.includes(origin)) return;
  throw new Error(`CSRF: origin ${origin} not in allowed list`);
}

/** GET /api/books/[id]/accounts — the chart of accounts. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const snapshot = await getBookSnapshot(ctx.workspace.id, params.id);
    return ok({ accounts: snapshot.accounts });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST /api/books/[id]/accounts — add an account to the chart. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    originGuard(request, [process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"]);
    const body = await readJsonBody<{
      code: string;
      name: string;
      type: AccountType;
      category: string;
      description?: string;
      openingBalance?: number;
    }>(request);
    const account = await addAccount(ctx.workspace.id, params.id, body);
    return ok({ account }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
