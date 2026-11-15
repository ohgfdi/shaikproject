import { ok, toErrorResponse } from "@/lib/server/api";
import { getPortalSnapshot } from "@/lib/server/client-portal";

export const dynamic = "force-dynamic";

/**
 * Public, token-addressed client portal snapshot. No session: the unguessable,
 * expiring token IS the capability. Only issued CLIENT-variant deliverables are
 * listed; nothing from the firm's internal file is reachable from here.
 */
export async function GET(_request: Request, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  try {
    return ok({ portal: await getPortalSnapshot(token) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
