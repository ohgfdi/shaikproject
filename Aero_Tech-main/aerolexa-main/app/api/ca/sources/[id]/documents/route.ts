import { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth/guard";
import { fail, ok, toErrorResponse } from "@/lib/server/api";
import { listCaSourceDocuments } from "@/lib/server/ca-source";

export const dynamic = "force-dynamic";

/**
 * GET /api/ca/sources/[id]/documents?runId=…
 *
 * List the canonical documents captured by one ingest run, so a reviewer can
 * trace every figure back to the source row that produced it.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const url = new URL(request.url);
    const runId = url.searchParams.get("runId");
    if (!runId) return fail(400, "VALIDATION", "runId is required.");

    const documents = await listCaSourceDocuments(ctx, params.id, runId);
    return ok({ documents });
  } catch (err) {
    return toErrorResponse(err);
  }
}
