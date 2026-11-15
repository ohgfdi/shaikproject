import { NextResponse } from "next/server";

import { collectOpsMetrics, renderOpsMetrics } from "@/lib/server/ops-metrics";
import { collectOpsAlerts, renderOpsAlertsMetrics } from "@/lib/server/slo";
import { collectTenantOps, renderTenantOpsMetrics } from "@/lib/server/tenant-ops";

export const dynamic = "force-dynamic";

/**
 * GET — Prometheus metrics for the operator's scrape target.
 *
 * Guarded by a bearer token, not a session: a scraper has no cookie, and these
 * numbers describe the deployment (queue depth, backup age, filing readiness),
 * not a tenant. With METRICS_TOKEN unset the route is indistinguishable from a
 * missing route — exposing deployment posture by default is not acceptable.
 */
export async function GET(request: Request) {
  const expected = process.env.METRICS_TOKEN;
  const provided = request.headers.get("authorization");
  if (!expected || provided !== `Bearer ${expected}`) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const [ops, tenants, alerts] = await Promise.all([
      collectOpsMetrics(),
      collectTenantOps(),
      collectOpsAlerts(),
    ]);
    const body = `${renderOpsMetrics(ops)}${renderTenantOpsMetrics(tenants)}${renderOpsAlertsMetrics(alerts)}`;
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    // A scrape must never see a 200 with fabricated numbers.
    return new NextResponse("metrics unavailable\n", { status: 503 });
  }
}
