import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

const schema = z.object({
  title: z.string().min(2).max(200).optional(),
  sections: z.array(z.record(z.string(), z.unknown())).optional(),
  saveVersion: z.boolean().optional(),
});

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const report = await prisma.report.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, report, "EDITOR");

    let version = report!.version;
    if (body.saveVersion) {
      // snapshot the previous version into a new row
      await prisma.report.create({
        data: {
          workspaceId: ctx.workspace.id,
          projectId: report!.projectId,
          title: `${report!.title} (v${report!.version})`,
          sections: report!.sections,
          createdById: ctx.user.id,
        },
      });
      version = report!.version + 1;
    }
    const data: Record<string, unknown> = { version, updatedAt: new Date() };
    if (body.title) data.title = body.title;
    if (body.sections) data.sections = stringifyJson(body.sections);
    const updated = await prisma.report.update({ where: { id: report!.id }, data });
    await logActivity(ctx, "REPORT_UPDATED", `Report “${updated.title}” saved (v${version})`, report!.projectId, {
      reportId: report!.id,
    });
    return ok({ id: report!.id, version });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const report = await prisma.report.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, report, "EDITOR");
    await prisma.report.delete({ where: { id: report!.id } });
    await logActivity(ctx, "ARTIFACT_DELETED", `Report deleted`, report!.projectId);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
