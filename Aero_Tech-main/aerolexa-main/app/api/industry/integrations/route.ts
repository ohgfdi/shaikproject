import { NextRequest } from "next/server";

import { GET } from "@/app/api/industry/integrations/route";

export const dynamic = "force-dynamic";

/** GET /api/industry/integrations?type=salesforce
 * Returns integration configuration for the specified type.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}