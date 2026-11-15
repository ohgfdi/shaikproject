import { FlaskConical, Plus } from "lucide-react";

import { ArtifactGrid } from "@/components/layout/artifact-grid";
import { PageHeader } from "@/components/layout/page-header";
import { ButtonLink } from "@/components/ui/button";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

export const metadata = { title: "Analyses" };

export default async function AnalysesPage() {
  const ctx = await requirePageAuth();
  const analyses = await prisma.analysis.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { createdAt: "desc" },
    include: { project: { select: { name: true } } },
    take: 200,
  });

  return (
    <div>
      <PageHeader
        title="Analyses"
        description="Statistical analyses and lab runs across every project."
        actions={
          <ButtonLink href="/analyses/new" icon={<Plus aria-hidden className="size-4" />}>
            New analysis
          </ButtonLink>
        }
      />
      <div className="mt-6">
        <ArtifactGrid
          icon={FlaskConical}
          emptyTitle="No analyses yet"
          emptyDescription="Run your first statistical analysis from a dataset."
          createHref="/analyses/new"
          createLabel="New analysis"
          items={analyses.map((a) => ({
            id: a.id,
            title: a.title,
            sub: `${a.kind}${a.project?.name ? ` · ${a.project.name}` : ""}`,
            href: `/analyses/${a.id}`,
            updatedAt: a.createdAt,
          }))}
        />
      </div>
    </div>
  );
}
