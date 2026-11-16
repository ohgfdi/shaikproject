import { GET } from "@/app/api/analytics/predictive-engine/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/analytics/predictive-engine?industry=saas&metric=revenue&horizon=30d
 * Returns predictive analytics scores and anomaly detection for the specified metric.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}