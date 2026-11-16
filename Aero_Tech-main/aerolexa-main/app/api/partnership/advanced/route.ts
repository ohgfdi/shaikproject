import { GET, POST } from "@/app/api/partnership/advanced/route";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/partnership/advanced?action=list
 * Returns advanced partnership program data including partners and deals.
 */
export async function GET(request: Request) {
  return GET(new NextRequest(request.url));
}

/** POST /api/partnership/advanced/register-deal
 * Register a new deal for revenue sharing and pipeline tracking.
 */
export async function POST(request: Request) {
  return POST(request);
}