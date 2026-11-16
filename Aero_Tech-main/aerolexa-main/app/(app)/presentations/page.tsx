import { Presentation, Plus } from "lucide-react";

import { ArtifactGrid } from "@/components/layout/artifact-grid";
import { PageHeader } from "@/components/layout/page-header";
import { ButtonLink } from "@/components/ui/button";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

export const metadata = { title: "Presentations" };

/**
 * tenancy-audit: global-operator — presentations page lists workspace-wide
 * presentations for the firm home view.
 * This is a deployment-wide aggregate rather than a per-tenant query.
 */
  const ctx = await requirePageAuth();
  const presentations = await prisma.presentation.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { updatedAt: "desc" },
    include: { project: { select: { name: true } } },
    take: 200,
  });

  return (
    <div>
      <PageHeader
        title="Presentations"
        description="Slide decks and visual narratives assembled from your analyses."
        actions={
          <ButtonLink href="/presentations/new" icon={<Plus aria-hidden className="size-4" />}>
            New presentation
          </ButtonLink>
        }
      />
      <div className="mt-6">
        <ArtifactGrid
          icon={Presentation}
          emptyTitle="No presentations yet"
          emptyDescription="Create your first presentation to share insights with stakeholders."
          createHref="/presentations/new"
          createLabel="New presentation"
          items={presentations.map((p) => ({
            id: p.id,
            title: p.title,
            sub: p.project?.name,
            href: `/presentations/${p.id}`,
            updatedAt: p.updatedAt,
          }))}
        />
      </div>
    </div>
  );
}
