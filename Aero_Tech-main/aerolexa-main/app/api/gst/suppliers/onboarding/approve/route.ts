import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { approveOnboarding } from "@/lib/engine/gst-supplier-onboarding";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/gst/suppliers/onboarding/approve — approve onboarding workflow
 */
export async function POST(request: Request) {
  try {
    await requireAuth();

    const body = z
      .object({
        workflow: z.object({
          supplierId: z.string(),
          steps: z.array(
            z.object({
              step: z.number(),
              name: z.string(),
              description: z.string(),
              required: z.boolean(),
              completed: z.boolean(),
              completedAt: z.string().optional(),
              data: z.any().optional(),
            }),
          ),
          currentStep: z.number(),
          status: z.enum(["initiated", "in-progress", "pending-approval", "completed", "rejected"]),
          startedAt: z.string(),
          completedAt: z.string().optional(),
          approvedBy: z.string().optional(),
          rejectedBy: z.string().optional(),
          rejectionReason: z.string().optional(),
        }),
        actorId: z.string(),
      })
      .parse(await readJsonBody(request));

    const workflow = approveOnboarding(body.workflow, body.actorId);

    return ok({ workflow });
  } catch (err) {
    return toErrorResponse(err);
  }
}
