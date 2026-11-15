import { NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getCaSource, deleteCaSource, updateCaSource } from "@/lib/server/ca-source";

export const dynamic = "force-dynamic";

const updateBody = z
  .object({
    displayName: z.string().max(140).nullable().optional(),
    sourceLabel: z.string().max(200).nullable().optional(),
  })
  .strict();

/**
 * GET /api/ca/sources/[id]
 *
 * Retrieve one CA source by id (workspace + engagement scoped).
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const source = await getCaSource(ctx, params.id);
    return ok({ source });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH /api/ca/sources/[id]
 *
 * Update display metadata on a CA source (not the mapping profile).
 */
export async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = updateBody.parse(await request.json());
    const source = await updateCaSource(ctx, params.id, body);
    return ok({ source });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/ca/sources/[id]
 *
 * Delete a CA source and its runs + snapshots.
 */
export async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await deleteCaSource(ctx, params.id);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
