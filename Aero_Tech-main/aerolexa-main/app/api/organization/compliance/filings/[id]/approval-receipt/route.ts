import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { readFilingApprovalReceipt } from "@/lib/server/filing-runs";

export const dynamic = "force-dynamic";

/** GET — the client's stored approval receipt for one filing run. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    return ok(await readFilingApprovalReceipt(ctx, id));
  } catch (err) {
    return toErrorResponse(err);
  }
}
