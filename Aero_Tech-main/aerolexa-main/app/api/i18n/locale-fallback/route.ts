import { NextRequest } from "next/server";

import { GET as upstreamGET } from "@/lib/i18n/locale-fallback";

export const dynamic = "force-dynamic";

/** GET /api/i18n/locale-fallback?action=fallback-chain&locale=ar
 * Returns locale fallback chain for the specified locale.
 */
export async function GET(request: Request) {
  return upstreamGET(new NextRequest(request.url));
}