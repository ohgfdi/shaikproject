import { NextResponse } from "next/server";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { notebookIpynb } from "@/lib/engine/versioning";
import { parseJsonArray } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";
import type { NotebookCell } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/notebooks/:id/export — download the notebook as valid .ipynb JSON. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const notebook = await prisma.notebook.findUnique({
      where: { id: params.id },
      include: { dataset: { select: { name: true } } },
    });
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");
    await requireRowRole(ctx, notebook, "VIEWER");

    const cells = parseJsonArray<NotebookCell>(notebook.cells, []);
    const nb = notebookIpynb(notebook.title, cells);
    await logActivity(
      ctx,
      "NOTEBOOK_EXPORTED",
      `Notebook “${notebook.title}” exported as .ipynb (${cells.length} cells)`,
      notebook.projectId,
      { notebookId: notebook.id },
    );
    const fileName = `notebook-${notebook.id.slice(-8)}-${notebook.title
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .slice(0, 40)}.ipynb`;
    return new NextResponse(JSON.stringify(nb, null, 2), {
      headers: {
        "Content-Type": "application/x-ipynb+json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
