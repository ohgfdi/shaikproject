import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { readFilingProof } from "@/lib/server/filing-runs";

export const dynamic = "force-dynamic";

/** GET — the immutable evidence bundle for one filing attempt. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    return ok(await readFilingProof(ctx, id));
  } catch (err) {
    return toErrorResponse(err);
  }
}
