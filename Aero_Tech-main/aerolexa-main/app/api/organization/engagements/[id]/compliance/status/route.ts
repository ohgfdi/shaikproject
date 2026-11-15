import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { setComplianceTaskStatus } from "@/lib/server/compliance-calendar";

export const dynamic = "force-dynamic";

const statusSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["filed", "waived", "pending"]),
  filedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  reference: z.string().trim().max(120).nullish(),
});

/** POST /api/organization/engagements/[id]/compliance/status — mark filed/waived. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = statusSchema.parse(await readJsonBody<unknown>(request));
    return ok(await setComplianceTaskStatus(ctx, id, body));
  } catch (err) {
    return toErrorResponse(err);
  }
}
