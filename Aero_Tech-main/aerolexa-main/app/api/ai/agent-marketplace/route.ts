import { GET, POST } from "@/app/api/ai/agent-marketplace/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/ai/agent-marketplace?action=list&industry=saas
 * Returns agent marketplace listings.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}

/** POST /api/ai/agent-marketplace/purchase
 * Purchase or install an agent from the marketplace.
 */
export async function POST(request: Request) {
  return POST(request);
}