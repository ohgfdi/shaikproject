import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/components/industry/benchmarking-dashboards";

export const dynamic = "force-dynamic";

/** GET /api/industry/benchmarking-dashboards?industry=saas
 * Returns industry benchmarking data for comparison with peers.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}