import { NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { CA_SOURCE_KINDS } from "@/lib/engine/ca-source";
import { ok, toErrorResponse } from "@/lib/server/api";
import { createCaSource, listCaSources } from "@/lib/server/ca-source";

export const dynamic = "force-dynamic";

const createBody = z
  .object({
    sourceKind: z.enum([...CA_SOURCE_KINDS]),
    sourceLabel: z.string().min(1).max(200),
    displayName: z.string().max(140).nullable().optional(),
    engagementId: z.string().min(1).nullable().optional(),
    sourceColumns: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * GET /api/ca/sources
 *
 * List CA sources visible to the caller.
 *
 * Query params:
 *   engagementId — optional; when set, only sources on that engagement are returned
 *                  (the engagement must be in the caller's firm and the caller must
 *                  have at least ASSISTANT access).
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireAuth();
    const url = new URL(request.url);
    const engagementId = url.searchParams.has("engagementId")
      ? (url.searchParams.get("engagementId") ?? null)
      : undefined;

    const sources = await listCaSources(ctx, { engagementId });
    return ok({ sources });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/ca/sources
 *
 * Create a CA source — the pipeline a firm runs repeatedly against one client
 * source system. Engagement-scoped when an engagementId is supplied; otherwise
 * firm-level. The default (auto-detected) mapping profile is seeded so the first
 * ingest can proceed before a reviewer saves a custom mapping.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await requireAuth();
    const body = createBody.parse(await request.json());
    const source = await createCaSource(ctx, {
      sourceKind: body.sourceKind,
      sourceLabel: body.sourceLabel,
      displayName: body.displayName ?? null,
      engagementId: body.engagementId ?? null,
      sourceColumns: body.sourceColumns,
    });
    return ok({ source }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
