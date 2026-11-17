import { NextRequest } from "next/server";

import { GET as upstreamGET, POST as upstreamPOST } from "@/lib/ai/agent-marketplace";

export const dynamic = "force-dynamic";

/** GET /api/ai/agent-marketplace?action=list&industry=saas
 * Returns agent marketplace listings.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}

/** POST /api/ai/agent-marketplace/purchase
 * Purchase or install an agent from the marketplace.
 */
export async function POST(request: Request) {
  return upstreamPOST(request);
}