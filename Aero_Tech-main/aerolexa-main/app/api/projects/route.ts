import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";

const schema = z.object({
  name: z.string().min(2).max(200),
  description: z.string().max(1000).optional(),
  company: z.string().max(200).optional(),
  industry: z.string().max(200).optional(),
  status: z.enum(["ACTIVE", "DRAFT", "COMPLETED", "ARCHIVED"]).optional(),
});

/** Lightweight project list (used by the connector REST import target picker). */
export async function GET() {
  try {
    const ctx = await requireAuth();
    const projects = await prisma.project.findMany({
      where: { workspaceId: ctx.workspace.id, status: { not: "ARCHIVED" } },
      select: { id: true, name: true, status: true },
      orderBy: { updatedAt: "desc" },
    });
    return ok({ projects });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const project = await prisma.project.create({
      data: {
        workspaceId: ctx.workspace.id,
        ownerId: ctx.user.id,
        name: body.name.trim(),
        description: body.description?.trim() || null,
        company: body.company?.trim() || null,
        industry: body.industry?.trim() || null,
        status: body.status ?? "ACTIVE",
      },
    });
    await logActivity(ctx, "PROJECT_CREATED", `Project “${project.name}” created`, project.id);
    return ok({ project }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
