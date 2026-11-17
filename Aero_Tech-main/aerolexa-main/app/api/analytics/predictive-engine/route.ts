import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/analytics/predictive-engine";

export const dynamic = "force-dynamic";

/** GET /api/analytics/predictive-engine?industry=saas&metric=revenue&horizon=30d
 * Returns predictive analytics scores and anomaly detection for the specified metric.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}