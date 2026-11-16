import Link from "next/link";
import { notFound } from "next/navigation";

import { CommentsPanel } from "@/components/comments/comments-panel";
import { DashboardBuilder, type WidgetSourceAnalysis } from "@/components/dashboards/dashboard-builder";
import { DemoBadge } from "@/components/ui/feedback";
import { PublishButton } from "@/components/ui/publish-button";
import { requirePageAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";
import {
  analysisResult,
  dashboardBookmarks,
  dashboardPages,
  dashboardTheme,
  dashboardWidgets,
  insightCard,
} from "@/lib/serialize";
import { artifactRole } from "@/lib/server/members";

export const metadata = { title: "Dashboard" };

export default async function DashboardDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requirePageAuth();
  const dashboard = await withTenantDb(ctx, (db) =>
    db.dashboard.findUnique({
      where: { id: params.id },
      include: { project: { select: { id: true, name: true, status: true } } },
    }),
  );
  if (!dashboard || dashboard.workspaceId !== ctx.workspace.id) notFound();

  const role = await artifactRole(ctx, dashboard);
  const canPublish = role === "OWNER";

  const [analyses, insights] = await Promise.all([
    await withTenantDb(ctx, (db) => db.analysis.findMany({
      where: { workspaceId: ctx.workspace.id, projectId: dashboard.projectId ?? undefined },
      orderBy: { createdAt: "desc" },
      take: 40,
    })),
    await withTenantDb(ctx, (db) => db.insight.findMany({
      where: { workspaceId: ctx.workspace.id, projectId: dashboard.projectId ?? undefined },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
  ]);

  const widgetSources: WidgetSourceAnalysis[] = analyses.map((a) => ({
    id: a.id,
    title: a.title,
    kind: a.kind,
    result: analysisResult(a),
  }));

  return (
    <div>
      {dashboard.project && (
        <p className="mb-3 text-caption text-muted">
          <Link className="text-accent hover:underline" href={`/projects/${dashboard.project.id}?tab=dashboards`}>
            {dashboard.project.name}
          </Link>{" "}
          · Dashboard
        </p>
      )}
      {canPublish && (
        <div className="mb-4 flex justify-end">
          <PublishButton
            kind="dashboard"
            artifactId={dashboard.id}
            initialAccessMode={dashboard.accessMode}
            initialShareToken={dashboard.shareToken}
            initialPublishedAt={dashboard.publishedAt?.toISOString() ?? null}
          />
        </div>
      )}
      <DashboardBuilder
        key={dashboard.id}
        dashboardId={dashboard.id}
        title={dashboard.title}
        projectId={dashboard.projectId}
        initialWidgets={dashboardWidgets(dashboard)}
        initialPages={dashboardPages(dashboard)}
        initialBookmarks={dashboardBookmarks(dashboard)}
        initialTheme={dashboardTheme(dashboard)}
        analyses={widgetSources}
        insights={insights.map((i) => insightCard(i))}
        isDemo={false}
        numStyle={ctx.settings.numberFormat}
      />
      {ctx.settings.aiDemoMode && (
        <div className="mt-4 inline-flex">
          <DemoBadge
            compact
            tooltip="Some widgets may embed prototype-computed charts (e.g. forecasts). They remain clearly labelled inside each chart."
          />
        </div>
      )}

      <CommentsPanel targetType="dashboard" targetId={dashboard.id} currentUserId={ctx.user.id} />
    </div>
  );
}
