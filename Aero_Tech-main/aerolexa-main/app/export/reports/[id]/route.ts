import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { renderReportDocument } from "@/lib/export/report-doc";
import { reportSections } from "@/lib/serialize";
import { logActivity } from "@/lib/server/activity";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireAuth();
  const report = await prisma.report.findUnique({
    where: { id: params.id },
    include: {
      createdBy: { select: { name: true } },
      project: { select: { name: true } },
    },
  });
  if (!report || report.workspaceId !== ctx.workspace.id) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Report not found." } },
      { status: 404 },
    );
  }

  // Real provenance: the report's latest dataset for this project, when it has one.
  const dataset = report.projectId
    ? await prisma.dataset.findFirst({
        where: { workspaceId: report.workspaceId, projectId: report.projectId },
        orderBy: { createdAt: "desc" },
        select: { name: true, rowCount: true, columnCount: true },
      })
    : null;

  const html = renderReportDocument(reportSections(report), {
    title: report.title,
    projectName: report.project?.name ?? null,
    authorName: report.createdBy.name,
    version: report.version,
    generatedAt: new Date(),
    datasetName: dataset?.name ?? null,
    datasetRowCount: dataset?.rowCount ?? null,
    datasetColumnCount: dataset?.columnCount ?? null,
    productionNote: "Exported from the Ledgerly workspace (manual export)",
  });

  await logActivity(ctx, "REPORT_EXPORTED", `Report “${report.title}” exported`, report.projectId, {
    reportId: report.id,
  });

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `inline; filename="report-${report.id.slice(0, 8)}.html"`,
    },
  });
}
