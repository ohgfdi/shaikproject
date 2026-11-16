import { GET } from "@/app/api/compliance/continuous-monitoring/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/compliance/continuous-monitoring?industry=saas
 * Returns continuous compliance monitoring status for all frameworks.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}