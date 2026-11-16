import { redirect } from "next/navigation";

import { requirePageAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";
import { parseJson, stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { buildPresentationTemplate } from "@/lib/templates";
import type { AnalysisResult, InsightCard } from "@/lib/types";

export const metadata = { title: "New presentation" };

export default async function NewPresentationPage(props: {
  searchParams: Promise<{ project?: string; title?: string }>;
}) {
  const searchParams = await props.searchParams;
  const ctx = await requirePageAuth();
  const projectId = searchParams.project;
  const project = projectId
    ? await withTenantDb(ctx, (db) =>
      db.project.findUnique({ where: { id: projectId } })
    )
    : await withTenantDb(ctx, (db) =>
      db.project.findFirst({ where: { workspaceId: ctx.workspace.id }, orderBy: { updatedAt: "desc" } }),
  );
  if (!project || project.workspaceId !== ctx.workspace.id) redirect("/projects");

  const dataset = await withTenantDb(ctx, (db) => db.dataset.findFirst({
    where: { workspaceId: ctx.workspace.id, projectId: project.id },
    orderBy: { createdAt: "desc" },
  }),
  const analyses = await withTenantDb(ctx, (db) => db.analysis.findMany({
    where: { workspaceId: ctx.workspace.id, projectId: project.id },
    orderBy: { createdAt: "desc" },
    take: 8,
  }),
  const insights = await withTenantDb(ctx, (db) => db.insight.findMany({
    where: { workspaceId: ctx.workspace.id, projectId: project.id },
    orderBy: { createdAt: "desc" },
    take: 8,
  }));

  const slides = buildPresentationTemplate({
    datasetName: dataset?.name,
    insights: insights.map((i) => parseJson<InsightCard>(JSON.stringify(i), null as unknown as InsightCard)),
    analyses: analyses.map((a) => ({
      id: a.id,
      title: a.title,
      kind: a.kind,
      result: parseJson<AnalysisResult | null>(a.result, null),
    })),
  });

  const presentation = await withTenantDb(ctx, (db) =>
    db.presentation.create({
      data: {
        workspaceId: ctx.workspace.id,
        projectId: project.id,
        title: searchParams.title || `${project.name} · Board Deck`,
        slides: stringifyJson(slides),
        createdById: ctx.user.id,
      },
    }),
  );
  await logActivity(ctx, "PRESENTATION_CREATED", `Presentation “${presentation.title}” created`, project.id, {
    presentationId: presentation.id,
  });
  redirect(`/presentations/${presentation.id}`);
}
