import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const { title } = z.object({ title: z.string().min(1).max(200) }).parse(await readJsonBody(request));
    const analysis = await prisma.analysis.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, analysis, "EDITOR");
    await prisma.analysis.update({ where: { id: analysis!.id }, data: { title } });
    return ok({ id: analysis!.id, title });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const analysis = await prisma.analysis.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, analysis, "EDITOR");
    await prisma.$transaction([
      prisma.insight.deleteMany({ where: { analysisId: analysis!.id } }),
      prisma.analysis.delete({ where: { id: analysis!.id } }),
    ]);
    await logActivity(ctx, "ARTIFACT_DELETED", `Analysis deleted`, analysis!.projectId);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
