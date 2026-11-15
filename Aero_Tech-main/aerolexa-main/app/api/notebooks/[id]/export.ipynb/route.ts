import { NextResponse } from "next/server";

import { notFoundError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { exportNotebookToIpynb } from "@/lib/export/python";
import { parseJsonArray } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";
import type { NotebookCell } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Download a notebook as a valid Jupyter .ipynb file (cells + outputs preserved). */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    const notebook = await prisma.notebook.findUnique({ where: { id: params.id } });
    if (!notebook) throw notFoundError("Notebook not found.");
    await requireRowRole(ctx, notebook, "VIEWER");

    const cells = parseJsonArray<NotebookCell>(notebook.cells, []);
    const doc = exportNotebookToIpynb(cells, notebook.title);

    await logActivity(ctx, "NOTEBOOK_CELL_RUN", `Exported notebook “${notebook.title}” to .ipynb`, notebook.projectId, {
      notebookId: notebook.id,
    });

    const safeName =
      notebook.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/gi, "-")
        .slice(0, 60) || "notebook";
    return new NextResponse(JSON.stringify(doc, null, 1), {
      headers: {
        "Content-Type": "application/x-ipynb+json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeName}.ipynb"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
