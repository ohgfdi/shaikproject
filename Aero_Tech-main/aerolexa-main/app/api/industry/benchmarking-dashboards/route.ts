import { GET } from "@/app/api/industry/benchmarking-dashboards/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/industry/benchmarking-dashboards?industry=saas
 * Returns industry benchmarking data for comparison with peers.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}