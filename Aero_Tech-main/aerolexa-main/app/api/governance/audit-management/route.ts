import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/governance/audit-management";

export const dynamic = "force-dynamic";

/** GET /api/governance/audit-management?action=audit-events
 * Returns audit events and governance policy status.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}