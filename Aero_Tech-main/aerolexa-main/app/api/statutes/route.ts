import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { canAuthorRegistry, prismaStatutesRepository, registryOverview } from "@/lib/server/statutes";

export const dynamic = "force-dynamic";

/**
 * The registry desk view: every catalogue slot, the version in force on the
 * requested date, the notifications waiting for review, and the counters that
 * answer "is this firm current?".
 *
 * `asOn` is explicit and reproducible: a reviewer looking at a 2024 engagement
 * passes asOn=2024-07-31 and sees the rules that were in force then, not today's.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const sp = new URL(request.url).searchParams;
    const repo = await prismaStatutesRepository();
    const registry = await registryOverview(repo, ctx.workspace.id, {
      asOn: sp.get("asOn") ?? undefined,
      ay: sp.get("ay"),
      entityType: sp.get("entityType"),
      state: sp.get("state"),
    });
    return ok({ registry, canAuthor: canAuthorRegistry(ctx) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
