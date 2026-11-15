import { z } from "zod";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { invitePortalAccount, listPortalAccounts, revokePortalAccount } from "@/lib/server/portal-auth";

export const dynamic = "force-dynamic";

const inviteSchema = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().max(120).nullish(),
});

/** GET — the client people invited to this engagement's portal. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireAuth();
    const { id } = await props.params;
    return ok({ accounts: await listPortalAccounts(ctx, id) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST — invite (or re-invite) a client person and email them a sign-in link. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireAuth();
    const { id } = await props.params;
    const body = inviteSchema.parse(await readJsonBody<unknown>(request));
    return ok(await invitePortalAccount(ctx, id, body));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** DELETE — revoke one account (?accountId=…). The link access is unaffected. */
export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireAuth();
    const { id } = await props.params;
    const accountId = new URL(request.url).searchParams.get("accountId");
    if (!accountId) {
      throw new ApiError(400, "VALIDATION", "Pass accountId.");
    }
    return ok({ account: await revokePortalAccount(ctx, id, accountId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
