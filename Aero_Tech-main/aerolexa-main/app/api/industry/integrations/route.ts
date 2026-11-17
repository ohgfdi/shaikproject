import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/industry/integrations";

export const dynamic = "force-dynamic";

/** GET /api/industry/integrations?type=salesforce
 * Returns integration configuration for the specified type.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}