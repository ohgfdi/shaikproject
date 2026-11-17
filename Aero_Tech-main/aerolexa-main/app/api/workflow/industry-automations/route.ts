import { NextRequest } from "next/server";

import { GET } from "@/app/api/workflow/industry-automations/route";

export const dynamic = "force-dynamic";

/** GET /api/workflow/industry-automations?industry=saas
 * Returns workflow automation rules for the specified industry.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}