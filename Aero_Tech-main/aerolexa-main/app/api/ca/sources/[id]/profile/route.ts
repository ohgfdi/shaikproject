import { NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { CA_SOURCE_KINDS, type CaMappingProfile } from "@/lib/engine/ca-source";
import { ok, toErrorResponse } from "@/lib/server/api";
import { saveCaSourceProfile } from "@/lib/server/ca-source";

export const dynamic = "force-dynamic";

/** A single column reference. Transforms are code and never travel over the wire. */
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

const profileBody = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).max(140),
    sourceKind: z.enum([...CA_SOURCE_KINDS]),
    sourceLabel: z.string().min(1).max(200),
    sourceColumns: z.array(z.string().min(1)).min(1),
    mapping: mappingSchema,
    firstUsedAt: z.string().min(1).optional(),
    note: z.string().max(2000).nullish(),
  })
  .strict();

/**
 * PUT /api/ca/sources/[id]/profile
 *
 * Save (upsert) the mapping profile on a CA source. This is the "column X means
 * canonical field Y" artifact a firm saves once and reuses across repeat syncs,
 * so ingestion is a pipeline rather than a one-time upload-and-pick-columns flow.
 */
export async function PUT(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = profileBody.parse(await request.json());

    const profile: CaMappingProfile = {
      id: body.id ?? crypto.randomUUID(),
      name: body.name,
      sourceKind: body.sourceKind,
      sourceLabel: body.sourceLabel,
      sourceColumns: body.sourceColumns,
      mapping: body.mapping,
      firstUsedAt: body.firstUsedAt ?? new Date().toISOString(),
      note: body.note ?? null,
    };

    const source = await saveCaSourceProfile(ctx, params.id, profile);
    return ok({ source });
  } catch (err) {
    return toErrorResponse(err);
  }
}
