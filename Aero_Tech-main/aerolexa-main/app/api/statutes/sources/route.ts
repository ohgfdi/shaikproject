import { z } from "zod";

import { ApiError, requireAuth, type AuthContext } from "@/lib/auth/guard";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireEntitlement } from "@/lib/server/entitlements";
import {
  canAuthorRegistry,
  prismaStatutesRepository,
  registerSource,
  type StatuteSourceInput,
} from "@/lib/server/statutes";

export const dynamic = "force-dynamic";

const sourceSchema = z.object({
  key: z.string().min(2).max(61),
  name: z.string().min(1).max(140),
  authority: z.enum(["cbdt", "cbic", "mca", "rbi", "epfo", "gst-council", "state", "other"]),
  url: z.string().min(8),
  format: z.string().max(20).optional(),
  kind: z.string().max(40).optional(),
  active: z.boolean().optional(),
  checkCron: z.string().max(120).nullish(),
});

function requireAuthor(ctx: AuthContext): void {
  if (!canAuthorRegistry(ctx)) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Only a firm partner, manager or administrator can change the rule registry. Ask a partner to add the source.",
    );
  }
}

/** List this workspace's ingestion sources. */
export async function GET() {
  try {
    const ctx = await requireAuth();
    const repo = await prismaStatutesRepository();
    return ok({ sources: await repo.listSources(ctx.workspace.id), canAuthor: canAuthorRegistry(ctx) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Register an ingestion source. Fetching an external authority feed is the same
 * outbound rail (and the same plan gate) as an external data connector.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    requireAuthor(ctx);
    await requireEntitlement(ctx.workspace.id, "externalConnectors", { feature: "Statute feed ingestion" });
    const body = sourceSchema.parse(await readJsonBody<Record<string, unknown>>(request));
    const repo = await prismaStatutesRepository();
    const source = await registerSource(repo, ctx.workspace.id, ctx.user.id, body as StatuteSourceInput);
    await logActivity(
      ctx,
      "STATUTE_SOURCE_ADDED",
      `Registered statute source “${source.name}” (${source.authority})`,
      null,
      {
        sourceKey: source.key,
        authority: source.authority,
      },
    );
    return ok({ source });
  } catch (err) {
    return toErrorResponse(err);
  }
}
