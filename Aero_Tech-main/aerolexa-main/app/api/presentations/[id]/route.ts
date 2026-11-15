import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

const schema = z.object({
  title: z.string().min(2).max(200).optional(),
  slides: z.array(z.record(z.string(), z.unknown())).optional(),
});

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const presentation = await prisma.presentation.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, presentation, "EDITOR");
    const data: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title) data.title = body.title;
    if (body.slides) data.slides = stringifyJson(body.slides);
    const updated = await prisma.presentation.update({ where: { id: presentation!.id }, data });
    await logActivity(ctx, "PRESENTATION_UPDATED", `Presentation “${updated.title}” saved`, presentation!.projectId, {
      presentationId: presentation!.id,
    });
    return ok({ id: presentation!.id });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const presentation = await prisma.presentation.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, presentation, "EDITOR");
    await prisma.presentation.delete({ where: { id: presentation!.id } });
    await logActivity(ctx, "ARTIFACT_DELETED", `Presentation deleted`, presentation!.projectId);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
