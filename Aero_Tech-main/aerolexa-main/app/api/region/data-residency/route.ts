import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/region/data-residency";

export const dynamic = "force-dynamic";

/** GET /api/region/data-residency?action=list
 * Returns region configurations and allowed regions per plan.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}