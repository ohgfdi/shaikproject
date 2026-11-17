import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/industry/compliance-mappings";

export const dynamic = "force-dynamic";

/** GET /api/industry/compliance?industry=saas&framework=SOC2
 * Returns compliance requirements for the specified industry and framework.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}