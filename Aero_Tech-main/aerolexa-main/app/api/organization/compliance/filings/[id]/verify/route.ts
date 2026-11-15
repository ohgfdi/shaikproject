import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { verifyFilingRunNow } from "@/lib/server/filing-reconciliation";

export const dynamic = "force-dynamic";

/** POST — reconcile one filed run with the active portal, now. */
export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    return ok({ verification: await verifyFilingRunNow(ctx, id) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
