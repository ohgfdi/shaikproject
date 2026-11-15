import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

const schema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  industry: z.string().max(200).nullable().optional(),
  status: z.enum(["ACTIVE", "DRAFT", "COMPLETED", "ARCHIVED"]).optional(),
});

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, project, "EDITOR");
    const updated = await prisma.project.update({
      where: { id: project!.id },
      data: { ...body, updatedAt: new Date() },
    });
    await logActivity(
      ctx,
      body.status === "ARCHIVED" ? "PROJECT_ARCHIVED" : "PROJECT_UPDATED",
      `Project “${updated.name}” updated`,
      project!.id,
    );
    return ok({ project: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({
      where: { id: params.id },
      include: { datasets: { select: { id: true, filePath: true } } },
    });
    await requireRowRole(ctx, project, "OWNER");
    await prisma.project.delete({ where: { id: project!.id } }); // cascades workspace artifacts
    // Best-effort file cleanup for datasets that belonged to the project.
    const { rm } = await import("node:fs/promises");
    const { dataDir } = await import("@/lib/engine/dataset");
    await Promise.allSettled(
      project!.datasets.map(async (d) => {
        await rm(dataDir() + `/parsed/${d.id}.ndjson`, { force: true }).catch(() => undefined);
        if (d.filePath) await rm(d.filePath, { force: true }).catch(() => undefined);
      }),
    );
    await logActivity(ctx, "ARTIFACT_DELETED", `Project “${project!.name}” deleted`, project!.id);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
