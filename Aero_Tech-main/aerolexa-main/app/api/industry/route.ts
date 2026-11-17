import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/industry/finance";

export const dynamic = "force-dynamic";

/** GET /api/industry?industry=finance
 * Returns the industry template for the specified sector.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}