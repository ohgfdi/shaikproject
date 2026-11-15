import Link from "next/link";
import { notFound } from "next/navigation";

import { CommentsPanel } from "@/components/comments/comments-panel";
import { ReportEditor } from "@/components/reports/report-editor";
import { PublishButton } from "@/components/ui/publish-button";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { analysisResult, insightCard, reportSections } from "@/lib/serialize";
import { artifactRole } from "@/lib/server/members";

export const metadata = { title: "Report" };

export default async function ReportDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requirePageAuth();
  const report = await prisma.report.findUnique({
    where: { id: params.id },
    include: { project: { select: { id: true, name: true } } },
  });
  if (!report || report.workspaceId !== ctx.workspace.id) notFound();

  const role = await artifactRole(ctx, report);
  const canPublish = role === "OWNER";

  const [analyses, insights] = await Promise.all([
    prisma.analysis.findMany({
      where: { workspaceId: ctx.workspace.id, projectId: report.projectId ?? undefined },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
    prisma.insight.findMany({
      where: { workspaceId: ctx.workspace.id, projectId: report.projectId ?? undefined },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
  ]);

  return (
    <div>
      {report.project && (
        <p className="mb-3 text-caption text-muted">
          <Link className="text-accent hover:underline" href={`/projects/${report.project.id}?tab=reports`}>
            {report.project.name}
          </Link>{" "}
          · Report
        </p>
      )}
      {canPublish && (
        <div className="mb-4 flex justify-end">
          <PublishButton
            kind="report"
            artifactId={report.id}
            initialAccessMode={report.accessMode}
            initialShareToken={report.shareToken}
            initialPublishedAt={report.publishedAt?.toISOString() ?? null}
          />
        </div>
      )}
      <ReportEditor
        reportId={report.id}
        title={report.title}
        projectId={report.projectId}
        initialSections={reportSections(report)}
        version={report.version}
        analyses={analyses.map((a) => ({ id: a.id, title: a.title, kind: a.kind, result: analysisResult(a) }))}
        insights={insights.map((i) => insightCard(i))}
        numStyle={ctx.settings.numberFormat}
      />

      <CommentsPanel targetType="report" targetId={report.id} currentUserId={ctx.user.id} />
    </div>
  );
}
