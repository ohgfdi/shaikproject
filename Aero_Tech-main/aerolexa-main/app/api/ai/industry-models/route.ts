import { GET } from "@/app/api/ai/industry-models/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/ai/industry-models?industry=saas&model_type=churn_prediction
 * Returns an industry-specific AI/ML model prediction.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}