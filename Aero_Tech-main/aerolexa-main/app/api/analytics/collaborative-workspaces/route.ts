import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/analytics/collaborative-workspaces";

export const dynamic = "force-dynamic";

/** GET /api/analytics/collaborative-workspaces?action=create&industry=saas&name=My+Workspace
 * Creates or lists collaborative analytics workspaces.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}