import { randomUUID } from "node:crypto";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireEntitlement } from "@/lib/server/entitlements";
import { requirePublishRole, requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";
import type { NotebookCell } from "@/lib/types";

export const dynamic = "force-dynamic";

interface PublishRequest {
  viewOnly?: boolean;
  allowPublic?: boolean;
}

/**
 * Publish a notebook as an app.
 *
 * - Publishing always snapshots the current cells into a NotebookVersion
 *   (immutable, audited).
 * - Default access mode is "workspace": anyone with a sign-in who can view
 *   the notebook can open the read-only view.
 * - Public opt-in (accessMode "public") requires the project OWNER and
 *   produces a share token → /apps/<token>, viewable with no sign-in.
 *
 * DELETE unpublishes (drops the public token, keeps the version history).
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const notebook = await prisma.notebook.findUnique({
      where: { id: params.id },
      include: { dataset: { select: { id: true, name: true } } },
    });
    await requireRowRole(ctx, notebook, "EDITOR");
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");

    const body = await readJsonBody<PublishRequest>(request);
    const { viewOnly = false, allowPublic = false } = body;

    // Public opt-in goes through the SEC-2 publish guard (workspace scoping +
    // creator/project-OWNER check). Workspace-mode publishing stays EDITOR —
    // that is an ordinary write on the notebook.

    // Snapshot the current state as the next NotebookVersion.
    const previousVersion = await prisma.notebookVersion.count({ where: { notebookId: notebook.id } });
    const version = previousVersion + 1;
    const cells = parseCells(notebook.cells);
    await prisma.notebookVersion.create({
      data: {
        workspaceId: notebook.workspaceId,
        notebookId: notebook.id,
        version,
        result: stringifyJson({ cells, title: notebook.title }),
        config: stringifyJson({ datasetId: notebook.datasetId }),
        createdById: ctx.user.id,
      },
    });

    // Access mode: public opt-in requires the SEC-2 publish role.
    let accessMode: "workspace" | "public" = "workspace";
    let shareToken: string | null = null;
    if (allowPublic) {
      await requirePublishRole(ctx, notebook, "Notebook");
      // Public app distribution is a Pro/Firm entitlement (capacity gate).
      await requireEntitlement(ctx.workspace.id, "publicShareLinks", {
        feature: "Publishing notebooks as public apps",
      });
      accessMode = "public";
      shareToken = randomUUID();
    } else if (notebook.accessMode === "public") {
      // Re-publishing as workspace-only unpublishes the public link.
      accessMode = "workspace";
      shareToken = null;
    }

    await prisma.notebook.update({
      where: { id: notebook.id },
      data: {
        accessMode,
        shareToken,
        publishedAt: accessMode === "public" ? new Date() : notebook.publishedAt,
      },
    });

    await logActivity(
      ctx,
      accessMode === "public" ? "PUBLICATION_PUBLIC_LINK" : "NOTEBOOK_PUBLISHED",
      accessMode === "public"
        ? `Notebook “${notebook.title}” published with a public view-only link (v${version})`
        : `Notebook “${notebook.title}” published to the workspace (v${version}), view-only: ${viewOnly ? "yes" : "no"}`,
      notebook.projectId,
      { notebookId: notebook.id, accessMode, viewOnly, version },
    );

    return ok({
      success: true,
      version,
      accessMode,
      viewOnly: viewOnly || accessMode === "public",
      shareUrl: shareToken ? `/apps/${shareToken}` : null,
      workspaceUrl: `/published-notebook?notebookId=${notebook.id}`,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Unpublish: drop the public token; version history stays. */
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const notebook = await prisma.notebook.findUnique({ where: { id: params.id } });
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");

    // Unpublishing drops a public link — same SEC-2 publish role as publishing.
    await requirePublishRole(ctx, notebook, "Notebook");

    await prisma.notebook.update({
      where: { id: notebook.id },
      data: { accessMode: "workspace", shareToken: null },
    });
    await logActivity(ctx, "NOTEBOOK_PUBLISHED", `Notebook “${notebook.title}” unpublished`, notebook.projectId, {
      notebookId: notebook.id,
      accessMode: "workspace",
    });
    return ok({ unpublished: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function parseCells(raw: string): NotebookCell[] {
  try {
    const cells = JSON.parse(raw) as unknown;
    return Array.isArray(cells) ? (cells as NotebookCell[]) : [];
  } catch {
    return [];
  }
}
