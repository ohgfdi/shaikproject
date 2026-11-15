import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/server/api";
import { openApiSpec } from "@/lib/server/openapi-spec";

export const dynamic = "force-dynamic";

/**
 * GET /api/public/openapi.json
 *
 * OpenAPI 3.0 specification for the public API. The spec lives in
 * `lib/server/openapi-spec.ts` so the Swagger UI page (/api/docs) and the
 * contract test validate the exact same object this route serves.
 */
export async function GET() {
  try {
    return NextResponse.json(openApiSpec, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
