import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/guard";
import { isBrowserHealthy, getBrowserInfo } from "@/lib/export/pdf";

export const dynamic = "force-dynamic";

/**
 * GET /api/export/browser-health
 *
 * Health check for the Playwright Chromium browser instance.
 * Requires authenticated user.
 */
export async function GET() {
  try {
    const _ctx = await requireAuth();

    const healthy = await isBrowserHealthy();
    const info = await getBrowserInfo();

    return NextResponse.json({
      ok: true,
      healthy,
      info,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // Keep the response leak-free; the operator signal goes to stderr.
    console.error("[browser-health] probe failed:", err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL_ERROR", message: "Health check failed." } },
      { status: 500 },
    );
  }
}
