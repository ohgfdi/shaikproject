import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { prismaStatutesRepository, resolveRegistryRule } from "@/lib/server/statutes";

export const dynamic = "force-dynamic";

/**
 * What was genuinely in force for a rule on a given date, for an entity and
 * state — the audit answer to "why did we compute that number?". A null
 * resolution means nothing is registered for that rule: the caller must not
 * guess a value.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const sp = new URL(request.url).searchParams;
    const ruleKey = sp.get("ruleKey");
    const asOn = sp.get("asOn");
    if (!ruleKey) throw new ApiError(400, "VALIDATION", "ruleKey is required.");
    if (!asOn)
      throw new ApiError(400, "VALIDATION", "asOn (yyyy-mm-dd) is required — a resolution is always as-on a date.");
    const repo = await prismaStatutesRepository();
    const resolution = await resolveRegistryRule(repo, ctx.workspace.id, {
      ruleKey,
      asOn,
      ay: sp.get("ay"),
      entityType: sp.get("entityType"),
      state: sp.get("state"),
    });
    return ok({ ruleKey, asOn, resolution });
  } catch (err) {
    return toErrorResponse(err);
  }
}
