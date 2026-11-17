import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/ai/industry-models";

export const dynamic = "force-dynamic";

/** GET /api/ai/industry-models?industry=saas&model_type=churn_prediction
 * Returns an industry-specific AI/ML model prediction.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}