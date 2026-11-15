import { randomUUID } from "node:crypto";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJsonArray } from "@/lib/json";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireProjectRole } from "@/lib/server/members";
import type { NotebookCell } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    await requireProjectRole(ctx, project, "VIEWER");
    const notebooks = await prisma.notebook.findMany({
      where: { projectId: project!.id },
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: { dataset: { select: { name: true } } },
    });
    return ok({
      notebooks: notebooks.map((n) => ({
        id: n.id,
        title: n.title,
        datasetName: n.dataset?.name ?? null,
        cellCount: parseJsonArray<NotebookCell>(n.cells, []).length,
        updatedAt: n.updatedAt.toISOString(),
        createdAt: n.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    await requireProjectRole(ctx, project, "EDITOR");

    const body = await readJsonBody<{ title?: string; datasetId?: string }>(request);
    let datasetId: string | null = body.datasetId ?? null;
    if (datasetId) {
      const ds = await prisma.dataset.findUnique({ where: { id: datasetId } });
      if (!ds || ds.projectId !== project!.id) {
        throw new ApiError(400, "VALIDATION", "The chosen dataset does not belong to this project.");
      }
    } else {
      const first = await prisma.dataset.findFirst({
        where: { projectId: project!.id },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      datasetId = first?.id ?? null;
    }

    const title = (body.title ?? "").trim().slice(0, 120) || "Untitled notebook";
    const starter: NotebookCell[] = [
      {
        id: randomUUID(),
        kind: "markdown",
        content:
          "# Project notebook\n\nCells run against the selected dataset. Start with `%help`, or try `%profile` and `%trend revenue`.\n\n```text\n%kpi revenue\n```",
      },
      { id: randomUUID(), kind: "code", content: "%help", output: null, ranAt: null },
    ];

    const notebook = await prisma.notebook.create({
      data: {
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        projectId: project!.id,
        datasetId,
        title,
        cells: stringifyJson(starter),
        createdById: ctx.user.id,
      },
    });
    await logActivity(
      ctx,
      "NOTEBOOK_CREATED",
      `Notebook “${notebook.title}” created in “${project!.name}”`,
      project!.id,
      {
        notebookId: notebook.id,
      },
    );
    return ok({ notebook: { id: notebook.id, title: notebook.title, datasetId } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
