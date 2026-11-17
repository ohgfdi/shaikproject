import { NextRequest } from "next/server";

import { GET } from "@/app/api/industry/data-templates/route";

export const dynamic = "force-dynamic";

/** GET /api/industry/data-templates?industry=saas
 * Returns report templates for the specified industry.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}