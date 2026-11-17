import { NextRequest } from "next/server";

import { GET as upstreamGET, POST as upstreamPOST } from "@/lib/partnership/partnership-program";

export const dynamic = "force-dynamic";

/** GET /api/partnership?action=list
 * Returns partner program information and partner list.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}

/** POST /api/partnership/track-referral
 * Track a referral for revenue sharing.
 */
export async function POST(request: Request) {
  return upstreamPOST(request);
}