import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { revokePortalLink } from "@/lib/server/client-portal";

export const dynamic = "force-dynamic";

/** Revoke a client link immediately. */
export async function DELETE(_request: Request, props: { params: Promise<{ id: string; tokenId: string }> }) {
  const { id, tokenId } = await props.params;
  try {
    const ctx = await requireAuth();
    const link = await revokePortalLink(ctx, id, tokenId);
    return ok({ link });
  } catch (err) {
    return toErrorResponse(err);
  }
}
