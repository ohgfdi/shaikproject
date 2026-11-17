import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/industry/data-models";

export const dynamic = "force-dynamic";

/** GET /api/industry/data-models?industry=saas
 * Returns the data model schema for the specified industry.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}