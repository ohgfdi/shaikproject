import { NextRequest } from "next/server";

import { GET } from "@/app/api/industry/data-models/route";

export const dynamic = "force-dynamic";

/** GET /api/industry/data-models?industry=saas
 * Returns the data model schema for the specified industry.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}