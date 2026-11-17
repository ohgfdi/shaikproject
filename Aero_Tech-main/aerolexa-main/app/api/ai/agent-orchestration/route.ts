import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/ai/agent-orchestration";

export const dynamic = "force-dynamic";

/** GET /api/ai/agent-orchestration?industry=saas&agent_types=research,analysis&task=Analyze+churn+rates
 * Orchestrates vertical-specific AI agents for the given task and returns coordinated responses.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}