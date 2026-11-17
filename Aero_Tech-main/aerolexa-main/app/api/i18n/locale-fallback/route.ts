import { NextRequest } from "next/server";

import { GET } from "@/app/api/i18n/locale-fallback/route";

export const dynamic = "force-dynamic";

/** GET /api/i18n/locale-fallback?action=fallback-chain&locale=ar
 * Returns locale fallback chain for the specified locale.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}