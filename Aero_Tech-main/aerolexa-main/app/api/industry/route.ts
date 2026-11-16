import { GET } from "@/app/api/industry/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/industry?industry=finance
 * Returns the industry template for the specified sector.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}