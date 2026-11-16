import { GET } from "@/app/api/streaming/real-time-integrations/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/streaming/real-time-integrations?action=available-types&industry=saas
 * Returns available stream types for the specified industry.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}