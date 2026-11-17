import { NextRequest } from "next/server";

import { GET } from "@/app/api/governance/audit-management/route";

export const dynamic = "force-dynamic";

/** GET /api/governance/audit-management?action=audit-events
 * Returns audit events and governance policy status.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}