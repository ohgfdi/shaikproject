import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/industry/data-templates";

export const dynamic = "force-dynamic";

/** GET /api/industry/data-templates?industry=saas
 * Returns report templates for the specified industry.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}