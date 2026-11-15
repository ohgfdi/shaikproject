import { NextResponse } from "next/server";

import { collectOpsAlerts } from "@/lib/server/slo";

export const dynamic = "force-dynamic";

/**
 * GET — operator alert list. Token-guarded like /api/metrics: these alerts
 * describe the deployment and tenant names/counts, not a signed-in user's data.
 */
export async function GET(request: Request) {
  const expected = process.env.METRICS_TOKEN;
  if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) {
    return new NextResponse("Not found", { status: 404 });
  }
  try {
    return NextResponse.json(await collectOpsAlerts(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ ok: false, alerts: [], summary: "Alert evaluation failed." }, { status: 503 });
  }
}
