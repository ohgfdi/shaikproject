import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/streaming/real-time-integrations";

export const dynamic = "force-dynamic";

/** GET /api/streaming/real-time-integrations?action=available-types&industry=saas
 * Returns available stream types for the specified industry.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}