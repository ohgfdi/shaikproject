import { z } from "zod";

import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson, parseJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import type { InsightCard, ReportSection, ReportSectionSource, InsightSeverity, Confidence } from "@/lib/types";

const schema = z.object({
  reportId: z.string().optional(),
  createNew: z.boolean().optional(),
  title: z.string().min(2).max(200).optional(),
});

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));

    const insight = await prisma.insight.findUnique({ where: { id: params.id } });
    if (!insight) throw new ApiError(404, "NOT_FOUND", "Insight not found");
    await requireRowRole(ctx, insight, "VIEWER");

    let reportId = body.reportId;

    if (body.createNew) {
      const projectId =
        insight.projectId ?? (await prisma.project.findFirst({ where: { workspaceId: ctx.workspace.id } }))?.id;
      if (!projectId) throw new ApiError(400, "NO_PROJECT", "No project available");

      const project = await prisma.project.findUnique({ where: { id: projectId } });
      await requireRowRole(ctx, project, "EDITOR");

      const dataset = await prisma.dataset.findFirst({
        where: { workspaceId: ctx.workspace.id, projectId },
        orderBy: { createdAt: "desc" },
      });
      const analyses = await prisma.analysis.findMany({
        where: { workspaceId: ctx.workspace.id, projectId },
        orderBy: { createdAt: "desc" },
        take: 8,
      });
      const insights = await prisma.insight.findMany({
        where: { workspaceId: ctx.workspace.id, projectId },
        orderBy: { createdAt: "desc" },
        take: 10,
      });

      const { buildReportTemplate } = await import("@/lib/templates");
      const sections = buildReportTemplate({
        dataset: dataset
          ? {
              id: dataset.id,
              name: dataset.name,
              rowCount: dataset.rowCount,
              columnCount: dataset.columnCount,
              columns: parseJson<{ name: string; type: string }[]>(dataset.columns, []),
              profile: parseJson(dataset.profile ?? "", null),
            }
          : null,
        insights: insights.map((i) => parseJson<InsightCard>(JSON.stringify(i), null as unknown as InsightCard)),
        analyses: analyses.map((a) => ({
          id: a.id,
          title: a.title,
          kind: a.kind,
          result: parseJson(a.result, null),
        })),
        userName: ctx.user.name,
        projectName: project!.name,
      });

      const report = await prisma.report.create({
        data: {
          workspaceId: ctx.workspace.id,
          projectId,
          title: body.title ?? `${project!.name} · Executive Report`,
          sections: stringifyJson(sections),
          createdById: ctx.user.id,
        },
      });
      await logActivity(ctx, "REPORT_CREATED", `Report "${report.title}" created from insight`, projectId, {
        reportId: report.id,
      });
      reportId = report.id;
    } else if (reportId) {
      const report = await prisma.report.findUnique({ where: { id: reportId } });
      if (!report) throw new ApiError(404, "NOT_FOUND", "Report not found");
      await requireRowRole(ctx, report, "EDITOR");
    } else {
      throw new ApiError(400, "BAD_REQUEST", "Either reportId or createNew must be provided");
    }

    const report = await prisma.report.findUnique({ where: { id: reportId! } });
    const existingSections = parseJson<ReportSection[]>(report!.sections, []);

    const evidence = parseJson<string[]>(insight.evidence, []);
    const extra = parseJson<Record<string, unknown>>(insight.extra ?? "{}", {});

    const source: ReportSectionSource = { kind: "insight", label: insight.title, id: insight.id };
    const newSection: ReportSection = {
      id: `sec-${Date.now()}`,
      heading: insight.title,
      kind: "insight",
      content: insight.title,
      insight: {
        id: insight.id ?? "",
        title: insight.title,
        severity: insight.severity as InsightSeverity,
        metric: insight.metric ?? undefined,
        observedChange: insight.observedChange ?? undefined,
        evidence,
        possibleCause: insight.possibleCause ?? undefined,
        businessImplication: insight.businessImplication ?? undefined,
        recommendedNextStep: insight.recommendedNextStep ?? undefined,
        confidence: insight.confidence as Confidence,
        extra,
        createdAt: insight.createdAt?.toISOString(),
      },
      source,
    };

    const updatedSections = [...existingSections, newSection];
    await prisma.report.update({
      where: { id: reportId! },
      data: { sections: stringifyJson(updatedSections), updatedAt: new Date() },
    });
    await logActivity(ctx, "REPORT_UPDATED", `Insight "${insight.title}" added to report`, report!.projectId, {
      reportId: report!.id,
      insightId: insight.id,
    });

    return ok({ reportId: reportId! });
  } catch (err) {
    return toErrorResponse(err);
  }
}
