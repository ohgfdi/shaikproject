/**
 * Notebook version history API.
 *
 * GET: returns version history for a notebook.
 * POST: creates a new version snapshot.
 * PATCH: restores a specific version.
 */

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJsonArray, stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";
import type { NotebookCell, NotebookVersion } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const notebook = await prisma.notebook.findUnique({ where: { id: params.id } });
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");
    await requireRowRole(ctx, notebook, "VIEWER");

    const versions = await prisma.notebookVersion.findMany({
      where: { notebookId: notebook.id },
      orderBy: { version: "desc" },
      take: 100,
    });

    const versionList: NotebookVersion[] = versions.map((v) => ({
      id: v.id,
      notebookId: v.notebookId,
      version: v.version,
      cells: parseJsonArray<NotebookCell>(v.result, []),
      title: notebook.title,
      createdAt: v.createdAt.toISOString(),
      authorName: "user",
      label: "auto",
    }));

    return ok({ versions: versionList });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const notebook = await prisma.notebook.findUnique({ where: { id: params.id } });
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");
    await requireRowRole(ctx, notebook, "EDITOR");

    const body = await readJsonBody<{ cells?: NotebookCell[]; label?: string }>(request);

    const cells = body.cells ?? parseJsonArray<NotebookCell>(notebook.cells, []);

    const previousVersion = await prisma.notebookVersion.count({
      where: { notebookId: notebook.id },
    });
    const newVersion = previousVersion + 1;

    const version = await prisma.notebookVersion.create({
      data: {
        workspaceId: notebook.workspaceId,
        notebookId: notebook.id,
        version: newVersion,
        result: stringifyJson(cells),
        config: stringifyJson({ label: body.label ?? "manual" }),
        createdById: ctx.user.id,
      },
    });

    await logActivity(
      ctx,
      "NOTEBOOK_CELL_RUN",
      `Version ${newVersion} saved for notebook "${notebook.title}"`,
      notebook.projectId,
      { notebookId: notebook.id },
    );

    return ok({
      version: {
        id: version.id,
        version: newVersion,
        label: body.label ?? "manual",
        createdAt: version.createdAt.toISOString(),
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
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");
    await requireRowRole(ctx, notebook, "EDITOR");

    const body = await readJsonBody<{ versionId: string }>(request);
    if (!body.versionId) throw new ApiError(400, "VALIDATION", "versionId is required.");

    const version = await prisma.notebookVersion.findUnique({ where: { id: body.versionId } });
    if (!version || version.notebookId !== notebook.id) {
      throw new ApiError(404, "NOT_FOUND", "Version not found.");
    }

    const cells = parseJsonArray<NotebookCell>(version.result, []);

    // Restore the cells
    await prisma.notebook.update({
      where: { id: notebook.id },
      data: { cells: stringifyJson(cells) },
    });

    await logActivity(
      ctx,
      "NOTEBOOK_CELL_RUN",
      `Restored version ${version.version} of notebook "${notebook.title}"`,
      notebook.projectId,
      { notebookId: notebook.id },
    );

    return ok({
      restored: true,
      version: version.version,
      cells,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
