import { NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { ingestCaSource } from "@/lib/server/ca-source";

export const dynamic = "force-dynamic";

const sourceRowsSchema = z
  .object({
    columns: z
      .array(
        z.object({
          name: z.string().min(1),
          type: z.enum(["string", "number", "date", "boolean"]),
        }),
      )
      .min(1),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1),
  })
  .strict();

const ingestBody = z
  .object({
    trigger: z.enum(["manual", "schedule", "reingest"]).optional(),
    reconcileAgainstPrior: z.boolean().optional(),
    sourceRows: sourceRowsSchema.optional(),
  })
  .strict();

/**
 * POST /api/ca/sources/[id]/ingest
 *
 * Ingest a CA source: canonicalise the pulled rows through the saved mapping
 * profile, dedup by fingerprint, record an append-only ingest run, and (when
 * requested) reconcile against the prior canonical documents.
 *
 * Body:
 *   trigger            — optional; manual | schedule | reingest (default: manual)
 *   reconcileAgainstPrior — optional; when true and a prior successful ingest exists,
 *                          reconcile the new documents against the prior ones (default: false)
 *   sourceRows         — required; columns + rows from the source (the same shape the
 *                          connector/parser layer produces)
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireAuth();
    const body = ingestBody.parse(await request.json());

    const { id } = await params;
    const result = await ingestCaSource(ctx, id, {
      trigger: body.trigger ?? "manual",
      reconcileAgainstPrior: body.reconcileAgainstPrior ?? false,
      sourceRows: body.sourceRows,
    });

    return ok({
      run: result.run,
      documents: result.documents,
      reconciliation: result.reconciliation,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
