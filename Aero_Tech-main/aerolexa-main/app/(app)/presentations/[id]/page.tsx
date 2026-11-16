import Link from "next/link";
import { notFound } from "next/navigation";

import { CommentsPanel } from "@/components/comments/comments-panel";
import { PresentationEditor } from "@/components/presentations/presentation-editor";
import { requirePageAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";
import { analysisResult, insightCard, presentationSlides } from "@/lib/serialize";

export const metadata = { title: "Presentation" };

export default async function PresentationDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requirePageAuth();
  const presentation = await withTenantDb(ctx, (db) =>
    db.presentation.findUnique({
      where: { id: params.id },
      include: { project: { select: { id: true, name: true } } },
    }),
  );
  if (!presentation || presentation.workspaceId !== ctx.workspace.id) notFound();

  const [analyses, insights] = await Promise.all([
    withTenantDb(ctx, (db) =>
    db.analysis.findMany({
      where: { workspaceId: ctx.workspace.id, projectId: presentation.projectId ?? undefined },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
    withTenantDb(ctx, (db) =>
      db.insight.findMany({
        where: { workspaceId: ctx.workspace.id, projectId: presentation.projectId ?? undefined },
        orderBy: { createdAt: "desc" },
        take: 40,
      }),
  ));

  return (
    <div>
      {presentation.project && (
        <p className="mb-3 text-caption text-muted">
          <Link className="text-accent hover:underline" href={`/projects/${presentation.project.id}?tab=presentations`}>
            {presentation.project.name}
          </Link>{" "}
          · Presentation
        </p>
      )}
      <PresentationEditor
        presentationId={presentation.id}
        title={presentation.title}
        projectId={presentation.projectId}
        initialSlides={presentationSlides(presentation)}
        analyses={analyses.map((a) => ({ id: a.id, title: a.title, result: analysisResult(a) }))}
        insights={insights.map((i) => insightCard(i))}
      />

      <CommentsPanel targetType="presentation" targetId={presentation.id} currentUserId={ctx.user.id} />
    </div>
  );
}
