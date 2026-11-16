import { GET } from "@/app/api/analytics/collaborative-workspaces/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/analytics/collaborative-workspaces?action=create&industry=saas&name=My+Workspace
 * Creates or lists collaborative analytics workspaces.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}