import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { issuePracticeInvoice } from "@/lib/server/practice-economics";

export const dynamic = "force-dynamic";

const schema = z.object({
  engagementId: z.string().min(1),
  issuedOn: z.string().trim().optional(),
  creditDays: z.number().int().min(0).max(180).optional(),
  gstRatePct: z.number().min(0).max(28).optional(),
  notes: z.string().trim().max(1000).nullish(),
});

/** POST — freeze every unbilled billable hour for a client into one invoice. */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody<unknown>(request));
    return ok({ invoice: await issuePracticeInvoice(ctx, body) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
