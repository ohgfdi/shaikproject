import { ok, toErrorResponse } from "@/lib/server/api";
import { getPortalDeliverable } from "@/lib/server/client-portal";

export const dynamic = "force-dynamic";

/** A single issued client deliverable, rendered with the same pipeline the firm previews. */
export async function GET(
  _request: Request,
  props: { params: Promise<{ token: string; versionId: string }> },
) {
  const { token, versionId } = await props.params;
  try {
    return ok({ deliverable: await getPortalDeliverable(token, versionId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
