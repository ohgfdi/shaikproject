import { NextRequest } from "next/server";

import { GET } from "@/app/api/ai/enterprise-ai-governance/route";

export const dynamic = "force-dynamic";

/** GET /api/ai/enterprise-ai-governance?action=report&model_id=model_1
 * Returns AI governance report with compliance, drift, and recommendations.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}