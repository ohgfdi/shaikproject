import { NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { CA_SOURCE_KINDS } from "@/lib/engine/ca-source";
import { fail, ok, toErrorResponse } from "@/lib/server/api";
import { createMappingProfile, listMappingProfiles } from "@/lib/server/ca-source";

export const dynamic = "force-dynamic";

const columnRef = z.object({ column: z.string().min(1) }).strict();

const metadataMapping = z
  .object({
    igst: columnRef.nullish(),
    cgst: columnRef.nullish(),
    sgst: columnRef.nullish(),
    cess: columnRef.nullish(),
    section: columnRef.nullish(),
    head: columnRef.nullish(),
    netPay: columnRef.nullish(),
    rate: columnRef.nullish(),
    hsn: columnRef.nullish(),
    sac: columnRef.nullish(),
    status: columnRef.nullish(),
  })
  .strict()
  .nullish();

const mappingSchema = z
  .object({
    fingerprint: columnRef.nullish(),
    traceLabel: columnRef.nullish(),
    date: columnRef.nullish(),
    party: columnRef.nullish(),
    account: columnRef.nullish(),
    debit: columnRef.nullish(),
    credit: columnRef.nullish(),
    sourceAmount: columnRef.nullish(),
    sourceId: columnRef.nullish(),
    metadata: metadataMapping,
  })
  .strict();

const createBody = z
  .object({
    sourceKind: z.enum([...CA_SOURCE_KINDS]),
    name: z.string().min(1).max(140),
    sourceLabel: z.string().min(1).max(200),
    sourceColumns: z.array(z.string().min(1)).min(1),
    mapping: mappingSchema,
    note: z.string().max(2000).nullish(),
  })
  .strict();

/**
 * GET /api/ca/mapping-profiles?sourceKind=…
 *
 * List the firm's saved mapping profiles for one source kind.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireAuth();
    const sourceKind = new URL(request.url).searchParams.get("sourceKind");
    if (!sourceKind || !CA_SOURCE_KINDS.includes(sourceKind as (typeof CA_SOURCE_KINDS)[number])) {
      return fail(400, "VALIDATION", "sourceKind must be one of the registered CA source kinds.");
    }
    const profiles = await listMappingProfiles(ctx, sourceKind as (typeof CA_SOURCE_KINDS)[number]);
    return ok({ profiles });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/ca/mapping-profiles
 *
 * Save a reusable mapping profile for one source kind, independent of any single
 * source — the library a practice picks from when onboarding a new client.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await requireAuth();
    const body = createBody.parse(await request.json());
    const profile = await createMappingProfile(ctx, {
      sourceKind: body.sourceKind,
      name: body.name,
      sourceLabel: body.sourceLabel,
      sourceColumns: body.sourceColumns,
      mapping: body.mapping,
      note: body.note ?? null,
    });
    return ok({ profile }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
