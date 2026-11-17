import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/ai/enterprise-ai-governance";

export const dynamic = "force-dynamic";

/** GET /api/ai/enterprise-ai-governance?action=report&model_id=model_1
 * Returns AI governance report with compliance, drift, and recommendations.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}