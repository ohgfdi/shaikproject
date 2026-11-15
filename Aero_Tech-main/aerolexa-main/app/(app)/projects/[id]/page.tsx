import { notFound } from "next/navigation";

import { ProjectHub, type HubAnalysis, type HubDataset } from "@/components/projects/project-hub";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { parseJsonArray } from "@/lib/json";
import { analysisResult, datasetColumns, insightCard } from "@/lib/serialize";
import { moduleEnabled } from "@/lib/server/modules";

export const metadata = { title: "Project" };

const LIST_LIMIT = 20;

export default async function ProjectPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ all?: string }>;
}) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const ctx = await requirePageAuth();
  const showAll = searchParams.all === "1";
  const take = showAll ? undefined : LIST_LIMIT;
  const project = await prisma.project.findUnique({
    where: { id: params.id },
  });
  if (!project || project.workspaceId !== ctx.workspace.id) notFound();

  const worksWhere = { workspaceId: ctx.workspace.id, projectId: project.id };
  const [
    datasets,
    totalDatasets,
    analyses,
    totalAnalyses,
    insights,
    totalInsights,
    dashboards,
    totalDashboards,
    reports,
    totalReports,
    presentations,
    totalPresentations,
    notebookCount,
    modelCount,
    memberCount,
    myMembership,
    activity,
  ] = await Promise.all([
    prisma.dataset.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      take,
    }),
    prisma.dataset.count({ where: { projectId: project.id } }),
    prisma.analysis.findMany({
      where: worksWhere,
      orderBy: { createdAt: "desc" },
      take,
      include: { dataset: { select: { name: true } } },
    }),
    prisma.analysis.count({ where: worksWhere }),
    prisma.insight.findMany({
      where: worksWhere,
      orderBy: { createdAt: "desc" },
      take,
    }),
    prisma.insight.count({ where: worksWhere }),
    prisma.dashboard.findMany({
      where: worksWhere,
      orderBy: { updatedAt: "desc" },
      take,
    }),
    prisma.dashboard.count({ where: worksWhere }),
    prisma.report.findMany({
      where: worksWhere,
      orderBy: { updatedAt: "desc" },
      take,
    }),
    prisma.report.count({ where: worksWhere }),
    prisma.presentation.findMany({
      where: worksWhere,
      orderBy: { updatedAt: "desc" },
      take,
    }),
    prisma.presentation.count({ where: worksWhere }),
    prisma.notebook.count({ where: worksWhere }),
    prisma.modelVersion.count({ where: worksWhere }),
    prisma.projectMember.count({ where: { projectId: project.id } }),
    prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: ctx.user.id } },
      select: { role: true },
    }),
    prisma.activity.findMany({
      where: worksWhere,
      orderBy: { createdAt: "desc" },
      take: 80,
    }),
  ]);

  const datasetsView: HubDataset[] = datasets.map((d) => ({
    id: d.id,
    name: d.name,
    originalName: d.originalName,
    rowCount: d.rowCount,
    columnCount: d.columnCount,
    isDemo: d.isDemo,
    createdAt: d.createdAt.toISOString(),
    warnings: parseJsonArray<string>(d.qualityWarnings, []).length,
    columns: datasetColumns(d),
  }));

  const serializedAnalyses: HubAnalysis[] = analyses.map((a) => ({
    id: a.id,
    title: a.title,
    kind: a.kind,
    datasetName: a.dataset?.name ?? null,
    createdAt: a.createdAt.toISOString(),
    quickFindings: analysisResult(a)?.quickFindings ?? [],
  }));

  const counts = {
    datasets: totalDatasets,
    analyses: totalAnalyses,
    insights: totalInsights,
    dashboards: totalDashboards,
    reports: totalReports,
    presentations: totalPresentations,
    notebooks: notebookCount,
    models: modelCount,
    team: memberCount,
    activity: activity.length,
  };

  return (
    <ProjectHub
      project={{
        id: project.id,
        name: project.name,
        description: project.description,
        company: project.company,
        industry: project.industry,
        status: project.status,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      }}
      datasets={datasetsView}
      analyses={serializedAnalyses}
      insights={insights.map((i) => insightCard(i))}
      dashboards={dashboards.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }))}
      reports={reports.map((r) => ({
        id: r.id,
        title: r.title,
        description: null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        version: r.version,
      }))}
      presentations={presentations.map((r) => ({
        id: r.id,
        title: r.title,
        description: null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }))}
      activity={activity.map((a) => ({
        id: a.id,
        type: a.type,
        message: a.message,
        createdAt: a.createdAt.toISOString(),
      }))}
      counts={counts}
      myRole={myMembership?.role ?? undefined}
      serverPythonEnabled={serverEnv().PYODIDE_SERVER_ENABLED}
      collaborationEnabled={moduleEnabled("COLLABORATION_ENABLED")}
      notebookEnabled={moduleEnabled("NOTEBOOK_ENABLED")}
    />
  );
}
