import { ok, toErrorResponse } from "@/lib/server/api";
import { payPortalInvoice } from "@/lib/server/client-portal";

export const dynamic = "force-dynamic";

/** POST — create the Razorpay order for one of this client's issued invoices. */
export async function POST(_request: Request, props: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await props.params;
  try {
    return ok({ payment: await payPortalInvoice(token, id) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
