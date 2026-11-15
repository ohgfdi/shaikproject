import { readFile } from "node:fs/promises";
import path from "node:path";

import { toErrorResponse } from "@/lib/server/api";

/**
 * GET /api/docs — Swagger UI for the public API.
 *
 * Serves a static HTML shell from public/vendor/swagger-ui/index.html
 * (vendored assets, no CDN calls at runtime — self-hosted like everything
 * else). Renders the spec served at /api/public/openapi.json, which is the
 * same object defined in lib/server/openapi-spec.ts and validated by the
 * contract test. Read once per cold start, cached in module scope.
 */
export async function GET() {
  try {
    const html = await getDocsHtml();
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    // A missing vendored asset (partial deploy, skipped `npm run copy:vendor`)
    // used to reject into an opaque 500. Return the standard envelope with a
    // remedy instead.
    return toErrorResponse(err);
  }
}

let cached: string | null = null;

async function getDocsHtml(): Promise<string> {
  if (cached) return cached;
  const filePath = path.join(process.cwd(), "public", "vendor", "swagger-ui", "index.html");
  cached = await readFile(filePath, "utf8");
  return cached;
}
