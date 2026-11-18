import { redirect } from "next/navigation";
import { z } from "zod";

import { requirePageAuth } from "@/lib/auth/guard";
import { stringifyJson, parseJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { withTenantDb } from "@/lib/server/tenant-db";
import { buildReportTemplate } from "@/lib/templates";
import type { AnalysisResult, DatasetProfile, InsightCard } from "@/lib/types";

export const metadata = { title: "New report" };

export default async function NewReportPage(props: { searchParams: Promise<{ project?: string; title?: string }> }) {
  const searchParams = await props.searchParams;
  const ctx = await requirePageAuth();
  const projectId = searchParams.project;
  const project = projectId
    ? await withTenantDb(ctx, (db) => db.project.findUnique({ where: { id: projectId } }))
    : await withTenantDb(ctx, (db) => db.project.findFirst({ where: { workspaceId: ctx.workspace.id }, orderBy: { updatedAt: "desc" } }));
  if (!project || project.workspaceId !== ctx.workspace.id) redirect("/projects");

  const dataset = await withTenantDb(ctx, (db) =>
    db.dataset.findFirst({
      where: { workspaceId: ctx.workspace.id, projectId: project.id },
      orderBy: { createdAt: "desc" },
    }),
  );
  const analyses = await withTenantDb(ctx, (db) =>
    db.analysis.findMany({
      where: { workspaceId: ctx.workspace.id, projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  );
  const insights = await withTenantDb(ctx, (db) =>
    db.insight.findMany({
      where: { workspaceId: ctx.workspace.id, projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  );

  const sections = buildReportTemplate({
    dataset: dataset
      ? {
          id: dataset.id,
          name: dataset.name,
          rowCount: dataset.rowCount,
          columnCount: dataset.columnCount,
          columns: parseJson<{ name: string; type: string }[]>(dataset.columns, []),
          profile: parseJson<DatasetProfile | null>(dataset.profile ?? "", null),
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
    projectName: project.name,
  });

  const parsedTitle = z.string().max(200).optional().parse(searchParams.title);
  const report = await withTenantDb(ctx, (db) =>
    db.report.create({
      data: {
        workspaceId: ctx.workspace.id,
        projectId: project.id,
        title: parsedTitle || `${project.name} · Executive Report`,
        sections: stringifyJson(sections),
        createdById: ctx.user.id,
      },
    }),
  );
  await logActivity(ctx, "REPORT_CREATED", `Report “${report.title}” created`, project.id, { reportId: report.id });
  redirect(`/reports/${report.id}`);
}
