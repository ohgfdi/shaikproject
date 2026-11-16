import { ApiError, requireAuth } from "@/lib/auth/guard";
// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - notebooks API is a deployment-wide aggregate operation
import { prisma } from "@/lib/db";
import { parseJsonArray, stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";
import type { NotebookCell, NotebookVersion } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_CELLS = 200;
const MAX_CELL_LENGTH = 50_000;

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const notebook = await prisma.notebook.findUnique({
      where: { id: params.id },
      include: { dataset: { select: { id: true, name: true } }, project: { select: { id: true, name: true } } },
    });
    await requireRowRole(ctx, notebook, "VIEWER");
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");
    // Load version history
    const versions = await prisma.notebookVersion.findMany({
      where: { notebookId: notebook.id },
      orderBy: { version: "desc" },
      take: 50,
    });
    const versionHistory: NotebookVersion[] = versions.map((v) => ({
      id: v.id,
      notebookId: v.notebookId,
      version: v.version,
      cells: parseJsonArray<NotebookCell>(v.result, []),
      title: notebook.title,
      createdAt: v.createdAt.toISOString(),
      authorName: "user",
      label: "auto",
    }));

    return ok({
      notebook: {
        id: notebook.id,
        title: notebook.title,
        projectId: notebook.projectId,
        projectName: notebook.project?.name ?? null,
        dataset: notebook.dataset ? { id: notebook.dataset.id, name: notebook.dataset.name } : null,
        datasetVersionId: notebook.datasetVersionId,
        cells: parseJsonArray<NotebookCell>(notebook.cells, []),
        accessMode: notebook.accessMode,
        // The share URL is a capability link — only the owner sees it here.
        shareUrl:
          notebook.accessMode === "public" && notebook.createdById === ctx.user.id
            ? `/apps/${notebook.shareToken}`
            : null,
        publishedAt: notebook.publishedAt ? notebook.publishedAt.toISOString() : null,
        updatedAt: notebook.updatedAt.toISOString(),
        versions: versionHistory,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const notebook = await prisma.notebook.findUnique({ where: { id: params.id } });
    await requireRowRole(ctx, notebook, "EDITOR");
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");

    const body = await readJsonBody<{
      title?: string;
      cells?: NotebookCell[];
      datasetId?: string | null;
      datasetVersionId?: string | null;
    }>(request);
    const data: { title?: string; cells?: string; datasetId?: string | null; datasetVersionId?: string | null } = {};
    if (typeof body.title === "string") {
      const title = body.title.trim().slice(0, 120);
      if (title) data.title = title;
    }
    if ("datasetId" in body) {
      if (body.datasetId) {
        const ds = await prisma.dataset.findUnique({ where: { id: body.datasetId } });
        if (!ds || ds.workspaceId !== ctx.workspace.id) {
          throw new ApiError(400, "VALIDATION", "The chosen dataset does not belong to this workspace.");
        }
      }
      data.datasetId = body.datasetId;
    }
    if ("datasetVersionId" in body) {
      if (body.datasetVersionId) {
        const version = await prisma.datasetVersion.findFirst({
          where: { id: body.datasetVersionId, workspaceId: ctx.workspace.id },
        });
        if (!version || version.datasetId !== notebook.datasetId) {
          throw new ApiError(
            400,
            "VALIDATION",
            "The chosen dataset version does not belong to this notebook's dataset.",
          );
        }
      }
      data.datasetVersionId = body.datasetVersionId;
    }
    if (Array.isArray(body.cells)) {
      if (body.cells.length > MAX_CELLS)
        throw new ApiError(400, "VALIDATION", `A notebook can hold at most ${MAX_CELLS} cells.`);
      for (const cell of body.cells) {
        if (typeof cell?.content !== "string" || cell.content.length > MAX_CELL_LENGTH) {
          throw new ApiError(400, "VALIDATION", "Cell content must be text under 50 000 characters.");
        }
        const validKinds = ["markdown", "code", "widget", "sql", "chart", "table-display", "pivot", "map"];
        if (!validKinds.includes(cell.kind)) {
          throw new ApiError(400, "VALIDATION", `Cell kind must be one of: ${validKinds.join(", ")}.`);
        }
        if (cell.kind === "widget" && (!cell.widget || typeof cell.widget.variable !== "string")) {
          throw new ApiError(400, "VALIDATION", "Widget cells need a widget descriptor with a variable name.");
        }
      }
      data.cells = stringifyJson(body.cells);
    }
    const updated = await prisma.notebook.update({ where: { id: notebook.id }, data });
    return ok({ notebook: { id: updated.id, title: updated.title } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const notebook = await prisma.notebook.findUnique({ where: { id: params.id } });
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");
    await requireRowRole(ctx, notebook, "EDITOR");
    const title = notebook.title;
    await prisma.notebook.delete({ where: { id: notebook.id } });
    await logActivity(ctx, "ARTIFACT_DELETED", `Notebook “${title}” deleted`, notebook.projectId, {
      notebookId: notebook.id,
    });
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
