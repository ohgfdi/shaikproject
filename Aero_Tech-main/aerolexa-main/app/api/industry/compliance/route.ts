import { GET } from "@/app/api/industry/compliance/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/industry/compliance?industry=saas&framework=SOC2
 * Returns compliance requirements for the specified industry and framework.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}