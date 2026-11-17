import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/workflow/industry-automations";

export const dynamic = "force-dynamic";

/** GET /api/workflow/industry-automations?industry=saas
 * Returns workflow automation rules for the specified industry.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}