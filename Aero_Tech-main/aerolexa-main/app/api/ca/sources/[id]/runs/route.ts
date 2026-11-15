import { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { listCaSourceRuns } from "@/lib/server/ca-source";

export const dynamic = "force-dynamic";

/**
 * GET /api/ca/sources/[id]/runs
 *
 * List the ingest runs recorded against a CA source, newest first. Every sync is
 * a versioned run, so the prior state stays retrievable after a repeat sync.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const runs = await listCaSourceRuns(ctx, params.id);
    return ok({ runs });
  } catch (err) {
    return toErrorResponse(err);
  }
}
