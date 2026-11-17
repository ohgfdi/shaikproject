import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/mobile/native-features";

export const dynamic = "force-dynamic";

/** GET /api/mobile/native-features?action=device-info&platform=ios
 * Returns mobile native feature configuration and device info.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}