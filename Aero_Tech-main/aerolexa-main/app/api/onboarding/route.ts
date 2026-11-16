// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - onboarding flow is a deployment-wide aggregate operation
import { z } from "zod";

import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse } from "@/lib/server/api";
import { completeOnboarding, ROLE_ALLOWED } from "@/lib/server/auth-service";

const schema = z.object({
  profileRole: z.string().min(1),
  goals: z.array(z.string()).max(8).default([]),
  organization: z.string().max(160).optional(),
  industry: z.string().max(120).optional(),
  experience: z.enum(["Beginner", "Intermediate", "Advanced"]).optional(),
  workspaceName: z.string().max(160).optional(),
});

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    if (ctx.user.onboardedAt) {
      throw new ApiError(409, "ALREADY_ONBOARDED", "You have already completed onboarding.");
    }
    const body = schema.parse(await request.json());
    if (!ROLE_ALLOWED.has(body.profileRole)) {
      throw new ApiError(400, "VALIDATION", "Please choose a valid role.");
    }
    await completeOnboarding(ctx.user.id, body);

    // Create a first project so the onboarding upload step has a home.
    const projectName = body.organization
      ? `${body.organization}`
      : ctx.user.name.split(" ")[0]
        ? `${ctx.user.name.split(" ")[0]}'s project`
        : "First project";
    const project = await prisma.project.create({
      data: {
        workspaceId: ctx.workspace.id,
        ownerId: ctx.user.id,
        name: projectName,
        description: "Primary project created during onboarding.",
        company: body.organization ?? null,
        industry: body.industry ?? null,
      },
    });
    await logActivity(ctx, "PROJECT_CREATED", `Project “${project.name}” created`, project.id);

    return ok({ projectId: project.id, projectName: project.name });
  } catch (err) {
    return toErrorResponse(err);
  }
}
