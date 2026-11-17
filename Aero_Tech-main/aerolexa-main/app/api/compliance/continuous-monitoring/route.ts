import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/compliance/continuous-monitoring";

export const dynamic = "force-dynamic";

/** GET /api/compliance/continuous-monitoring?action=dashboard&industry=saas&model_id=model_1
 * Returns continuous compliance dashboard across all 5 frameworks (SOC2, HIPAA, PCI-DSS, GDPR, SOX).
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}