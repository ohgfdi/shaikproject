import { GET } from "@/app/api/region/data-residency/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/region/data-residency?action=list
 * Returns region configurations and allowed regions per plan.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}