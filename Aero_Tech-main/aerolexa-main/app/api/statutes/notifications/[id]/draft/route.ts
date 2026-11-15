import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { canAuthorRegistry, draftVersionsFromNotification, prismaStatutesRepository } from "@/lib/server/statutes";

export const dynamic = "force-dynamic";

/**
 * Turn an ingested notification into DRAFT rule versions. The draft carries the
 * value in force forward — it never invents a number — and flags a missing
 * effective date. Publishing is a separate, deliberate step.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    if (!canAuthorRegistry(ctx)) {
      throw new ApiError(403, "FORBIDDEN", "Only a firm partner, manager or administrator can draft rule changes.");
    }
    const body = await readJsonBody<{ ruleKeys?: string[]; ay?: string | null }>(request);
    const repo = await prismaStatutesRepository();
    const drafts = await draftVersionsFromNotification(repo, ctx.workspace.id, params.id, {
      ruleKeys: Array.isArray(body.ruleKeys) ? body.ruleKeys : undefined,
      ay: body.ay ?? null,
    });
    return ok({ drafts });
  } catch (err) {
    return toErrorResponse(err);
  }
}
