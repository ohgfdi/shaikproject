import { NextRequest } from "next/server";

import { GET } from "@/app/api/vertical-extensions/route";

export const dynamic = "force-dynamic";

/** GET /api/vertical-extensions?industry=saas&language=saas_query&filter[plan_type]=pro
 * Executes a domain-specific query for the specified industry vertical.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}