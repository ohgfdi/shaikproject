import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/ai/autonomous-decision-engine";

export const dynamic = "force-dynamic";

/** GET /api/ai/autonomous-decision-engine?action=propose&title=Revenue+Optimization&industry=saas&risk_level=medium
 * Proposes an autonomous decision with risk-based approval workflow.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}