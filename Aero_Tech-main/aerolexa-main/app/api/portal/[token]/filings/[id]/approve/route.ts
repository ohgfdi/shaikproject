import { z } from "zod";

import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { approveFilingRunFromPortal } from "@/lib/server/client-portal";
import { readPortalSession } from "@/lib/server/portal-auth";

export const dynamic = "force-dynamic";

const schema = z.object({
  note: z.string().trim().max(1000).nullish(),
  /** Name the client types to sign the approval receipt. Optional. */
  approvedBy: z.string().trim().max(120).nullish(),
});

/** POST — the client approves a reviewed filing from their portal link. */
export async function POST(request: Request, props: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await props.params;
  try {
    // An empty body means "approve with no note" — the action itself is the
    // payload, so a client is never rejected for sending nothing.
    let body: { note?: string | null; approvedBy?: string | null } = {};
    try {
      body = schema.parse(await readJsonBody<unknown>(request));
    } catch {
      body = {};
    }
    // Identity comes from the signed-in session cookie, never from the body.
    // No session is fine: the approval is then recorded as link-based.
    const session = await readPortalSession();
    return ok({
      filing: await approveFilingRunFromPortal(token, id, body.note ?? null, body.approvedBy ?? null, session),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
