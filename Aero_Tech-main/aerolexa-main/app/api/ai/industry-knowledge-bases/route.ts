import { NextRequest } from "next/server";

import { GET } from "@/app/api/ai/industry-knowledge-bases/route";

export const dynamic = "force-dynamic";

/** GET /api/ai/industry-knowledge-bases?industry=saas&area=metric-definitions&question=what+is+NRR
 * Returns industry-specific knowledge base entries for AI Chat context.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}