import { ok, toErrorResponse } from "@/lib/server/api";
import { getPortalMonthlyComplianceReport } from "@/lib/server/compliance-report";

export const dynamic = "force-dynamic";

/** GET — the client's own monthly compliance report (scoped by their link). */
export async function GET(
  request: Request,
  props: { params: Promise<{ token: string }> },
) {
  const { token } = await props.params;
  try {
    const month = new URL(request.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
    return ok({ report: await getPortalMonthlyComplianceReport(token, month) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
