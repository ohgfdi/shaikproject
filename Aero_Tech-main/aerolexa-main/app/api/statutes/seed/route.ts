import { ApiError, requireAuth } from "@/lib/auth/guard";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse } from "@/lib/server/api";
import { canAuthorRegistry, prismaStatutesRepository, seedBuiltInRuleVersions } from "@/lib/server/statutes";

export const dynamic = "force-dynamic";

/**
 * Materialise the built-in Finance Act defaults (AY 2025-26) as PUBLISHED,
 * dated versions, so the starting point of every rate/slab is visible in the
 * registry rather than living only inside the engine. Idempotent: running it
 * again publishes nothing new.
 */
export async function POST() {
  try {
    const ctx = await requireAuth();
    if (!canAuthorRegistry(ctx)) {
      throw new ApiError(403, "FORBIDDEN", "Only a firm partner, manager or administrator can seed the registry.");
    }
    const repo = await prismaStatutesRepository();
    const result = await seedBuiltInRuleVersions(repo, ctx.workspace.id, ctx.user.id);
    if (result.published > 0) {
      await logActivity(
        ctx,
        "STATUTE_REGISTRY_SEEDED",
        `Seeded ${result.published} built-in rule version${result.published === 1 ? "" : "s"} (AY 2025-26 defaults)`,
        null,
        { published: result.published, skipped: result.skipped },
      );
    }
    return ok({ result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
