import { GET } from "@/app/api/analytics/scenario-modeling/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/analytics/scenario-modeling?action=what-if&industry=saas&metric=revenue&horizon=30d
 * Runs predictive scenario modeling with what-if analysis, Monte Carlo simulation, and sensitivity analysis.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}