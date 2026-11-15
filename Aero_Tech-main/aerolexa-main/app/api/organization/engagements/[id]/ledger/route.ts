import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireEngagementRole } from "@/lib/server/engagement";
import { listEngagementChangeLog, verifyEngagementLedger } from "@/lib/server/governance";

export const dynamic = "force-dynamic";

/**
 * The engagement's immutable change ledger (newest first), plus a chain
 * verification so a reviewer can confirm nothing was edited or removed.
 */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const { engagement } = await requireEngagementRole(ctx, id, "ASSISTANT");
    const search = new URL(request.url).searchParams;
    const limit = Number(search.get("limit") ?? "200");
    const after = search.get("after") ?? undefined;

    const [entries, verification] = await Promise.all([
      listEngagementChangeLog(engagement.organizationId, engagement.id, {
        after,
        limit: Number.isFinite(limit) ? limit : 200,
      }),
      verifyEngagementLedger(engagement.organizationId, engagement.id),
    ]);
    return ok({ entries, verification });
  } catch (err) {
    return toErrorResponse(err);
  }
}
