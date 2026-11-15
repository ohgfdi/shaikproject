import { ok, toErrorResponse } from "@/lib/server/api";
import { getPortalFilingApprovalReceipt } from "@/lib/server/client-portal";

export const dynamic = "force-dynamic";

/** GET — the client's own approval receipt, scoped by their portal token. */
export async function GET(
  _request: Request,
  props: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id } = await props.params;
  try {
    return ok({ approval: await getPortalFilingApprovalReceipt(token, id) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
