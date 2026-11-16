import { GET } from "@/app/api/ai/ab-test-integration/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/ai/ab-test-integration?action=assign&testId=test_1&userId=user_1
 * Assigns a user to an A/B test variant deterministically.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}