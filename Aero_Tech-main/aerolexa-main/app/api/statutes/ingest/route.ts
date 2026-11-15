import { z } from "zod";

import { ApiError, requireAuth, type AuthContext } from "@/lib/auth/guard";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireEntitlement } from "@/lib/server/entitlements";
import { canAuthorRegistry, ingestSource, prismaStatutesRepository } from "@/lib/server/statutes";

export const dynamic = "force-dynamic";

const ingestSchema = z.object({ sourceId: z.string().min(1) });

function requireAuthor(ctx: AuthContext): void {
  if (!canAuthorRegistry(ctx)) {
    throw new ApiError(403, "FORBIDDEN", "Only a firm partner, manager or administrator can ingest statute feeds.");
  }
}

/**
 * Fetch a source and store every NEW item. Idempotent: running it twice against
 * an unchanged feed inserts nothing. Ingestion never publishes a rule — an item
 * is evidence, and a reviewer turns it into a dated version.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    requireAuthor(ctx);
    await requireEntitlement(ctx.workspace.id, "externalConnectors", { feature: "Statute feed ingestion" });
    const { sourceId } = ingestSchema.parse(await readJsonBody<Record<string, unknown>>(request));
    const repo = await prismaStatutesRepository();
    const result = await ingestSource(repo, ctx.workspace.id, sourceId);
    if (result.inserted > 0) {
      await logActivity(
        ctx,
        "STATUTE_INGESTED",
        `Ingested ${result.inserted} new notification${result.inserted === 1 ? "" : "s"} from “${result.sourceId}”`,
        null,
        { sourceId, inserted: result.inserted, duplicates: result.duplicates, skipped: result.skipped },
      );
    }
    return ok({ result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
