import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJson, stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { buildReportTemplate } from "@/lib/templates";
import type { AnalysisResult, DatasetProfile, InsightCard } from "@/lib/types";

const schema = z.object({ projectId: z.string().min(1), title: z.string().min(2).max(200) });

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const project = await prisma.project.findUnique({ where: { id: body.projectId } });
    await requireRowRole(ctx, project, "EDITOR");

    const dataset = await prisma.dataset.findFirst({
      where: { workspaceId: ctx.workspace.id, projectId: project!.id },
      orderBy: { createdAt: "desc" },
    });
    const analyses = await prisma.analysis.findMany({
      where: { workspaceId: ctx.workspace.id, projectId: project!.id },
      orderBy: { createdAt: "desc" },
      take: 8,
    });
    const insights = await prisma.insight.findMany({
      where: { workspaceId: ctx.workspace.id, projectId: project!.id },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const columns = dataset ? parseJson<{ name: string; type: string }[]>(dataset.columns, []) : [];
    const profile = dataset ? parseJson<DatasetProfile | null>(dataset.profile ?? "", null) : null;

    const sections = buildReportTemplate({
      dataset: dataset
        ? {
            id: dataset.id,
            name: dataset.name,
            rowCount: dataset.rowCount,
            columnCount: dataset.columnCount,
            columns,
            profile,
          }
        : null,
      insights: insights.map((i) => parseJson<InsightCard>(JSON.stringify(i), null as unknown as InsightCard)),
      analyses: analyses.map((a) => ({
        id: a.id,
        title: a.title,
        kind: a.kind,
        result: parseJson<AnalysisResult | null>(a.result, null),
      })),
      userName: ctx.user.name,
      projectName: project!.name,
    });

    const report = await prisma.report.create({
      data: {
        workspaceId: ctx.workspace.id,
        projectId: project!.id,
        title: body.title,
        sections: stringifyJson(sections),
        createdById: ctx.user.id,
      },
    });
    await logActivity(ctx, "REPORT_CREATED", `Report “${report.title}” created`, project!.id, { reportId: report.id });
    return ok({ report: { id: report.id } }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
