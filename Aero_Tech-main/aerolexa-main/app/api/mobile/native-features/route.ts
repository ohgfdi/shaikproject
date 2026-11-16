import { GET } from "@/app/api/mobile/native-features/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/mobile/native-features?action=device-info&platform=ios
 * Returns mobile native feature configuration and device info.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}