import { z } from "zod";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";

const schema = z.object({
  name: z.string().min(2).max(120).optional(),
  profileRole: z.string().max(80).optional(),
  organization: z.string().max(160).nullable().optional(),
  industry: z.string().max(120).nullable().optional(),
  experience: z.enum(["Beginner", "Intermediate", "Advanced"]).nullable().optional(),
  goals: z.array(z.string()).max(8).optional(),
  /**
   * Admin mode. Privilege escalation guard: only a caller who is ALREADY an
   * admin may change this field. A non-admin sending `isAdmin` is rejected
   * rather than silently ignored, so a tampered request is visible. Bootstrap
   * an initial admin through the database/seed, never through this route.
   */
  isAdmin: z.boolean().optional(),
});

export async function PATCH(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const data: Record<string, unknown> = { ...body };
    if (body.goals) data.goals = stringifyJson(body.goals);
    else delete data.goals;

    if (body.isAdmin !== undefined) {
      if (!ctx.isAdmin) {
        throw new ApiError(403, "FORBIDDEN", "Only an admin can change admin access.");
      }
      data.isAdmin = body.isAdmin;
    }

    const user = await prisma.user.update({ where: { id: ctx.user.id }, data });
    return ok({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        profileRole: user.profileRole,
        organization: user.organization,
        industry: user.industry,
        experience: user.experience,
        isAdmin: user.isAdmin,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
