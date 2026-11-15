import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ENTITY_KINDS, GST_FREQUENCIES } from "@/lib/engine/compliance-calendar";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { upsertComplianceProfile } from "@/lib/server/compliance-calendar";

export const dynamic = "force-dynamic";

const profileSchema = z.object({
  entityKind: z.enum(ENTITY_KINDS as unknown as [string, ...string[]]),
  financialYear: z.string().regex(/^\d{4}-\d{2}$/),
  gstRegistered: z.boolean(),
  gstFrequency: z.enum(GST_FREQUENCIES as unknown as [string, ...string[]]),
  tdsDeductor: z.boolean(),
  taxAuditApplicable: z.boolean(),
  transferPricingApplicable: z.boolean(),
  listedCompany: z.boolean(),
  state: z.string().trim().max(60).nullable(),
  employsStaff: z.boolean(),
});

/** PUT /api/organization/engagements/[id]/compliance — save the client's registration profile. */
export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = profileSchema.parse(await readJsonBody<unknown>(request));
    return ok(
      await upsertComplianceProfile(ctx, id, {
        ...body,
        entityKind: body.entityKind as (typeof ENTITY_KINDS)[number],
        gstFrequency: body.gstFrequency as (typeof GST_FREQUENCIES)[number],
      }),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
