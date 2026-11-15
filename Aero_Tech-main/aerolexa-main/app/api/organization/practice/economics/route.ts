import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getPracticeEconomics } from "@/lib/server/practice-economics";

export const dynamic = "force-dynamic";

/** GET — unbilled WIP, invoice book and per-client economics. */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const asOf = new URL(request.url).searchParams.get("asOf") ?? undefined;
    return ok({ economics: await getPracticeEconomics(ctx, { asOf }) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
