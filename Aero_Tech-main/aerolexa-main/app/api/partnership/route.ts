import { GET, POST } from "@/app/api/partnership/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/partnership?action=list
 * Returns partner program information and partner list.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}

/** POST /api/partnership/track-referral
 * Track a referral for revenue sharing.
 */
export async function POST(request: Request) {
  return POST(request);
}