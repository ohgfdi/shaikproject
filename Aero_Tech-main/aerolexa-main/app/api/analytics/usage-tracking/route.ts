import { NextRequest } from "next/server";

import { GET } from "@/app/api/analytics/usage-tracking/route";

export const dynamic = "force-dynamic";

/** GET /api/analytics/usage-tracking?action=tenant-metrics&tenantId=tenant_1&plan=pro&industry=saas
 * Returns privacy-safe tenant usage metrics and feature adoption rates.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}