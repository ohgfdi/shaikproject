import { z } from "zod";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { promoteFilingClient } from "@/lib/server/filing-golive";
import { getFilingRollout, setFilingRollout } from "@/lib/server/filing-rollout";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  mode: z.enum(["shadow", "live"]),
  note: z.string().trim().max(1000).nullish(),
  override: z.boolean().optional(),
});

/** GET — this client's current mode and whether the gate is enforced. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    if (!ctx.organization) {
      throw new ApiError(400, "NO_ORGANIZATION", "This account is not attached to a firm organization.");
    }
    return ok(await getFilingRollout(ctx, id));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PATCH — promote a client to live filing, or return it to shadow. */
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = patchSchema.parse(await readJsonBody<unknown>(request));
    // Promotion always goes through the evidence gate, whichever endpoint the
    // caller uses. Demotion to shadow is immediate.
    if (body.mode === "live") {
      return ok(
        await promoteFilingClient(ctx, id, {
          note: body.note ?? null,
          override: body.override === true,
        }),
      );
    }
    return ok(await setFilingRollout(ctx, id, { mode: "shadow", note: body.note ?? null }));
  } catch (err) {
    return toErrorResponse(err);
  }
}
