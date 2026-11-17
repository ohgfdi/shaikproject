import { NextRequest } from "next/server";

import { GET } from "@/app/api/ai/autonomous-decision-engine/route";

export const dynamic = "force-dynamic";

/** GET /api/ai/autonomous-decision-engine?action=propose&title=Revenue+Optimization&industry=saas&risk_level=medium
 * Proposes an autonomous decision with risk-based approval workflow.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}