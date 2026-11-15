import { BrainCircuit } from "lucide-react";

import { ArtifactGrid } from "@/components/layout/artifact-grid";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

export const metadata = { title: "Models" };

export default async function ModelsPage() {
  const ctx = await requirePageAuth();
  const models = await prisma.modelVersion.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { createdAt: "desc" },
    include: { project: { select: { id: true, name: true } } },
    take: 200,
  });

  return (
    <div>
      <PageHeader title="Models" description="Trained model versions across every project." />
      <div className="mt-6">
        <ArtifactGrid
          icon={BrainCircuit}
          emptyTitle="No models yet"
          emptyDescription="Train your first model from the Models tab inside a project."
          items={models.map((m) => ({
            id: m.id,
            title: m.name,
            sub: `${m.task} · v${m.version}${m.project?.name ? ` · ${m.project.name}` : ""}`,
            href: m.projectId ? `/projects/${m.projectId}?tab=models` : "#",
            updatedAt: m.createdAt,
          }))}
        />
      </div>
    </div>
  );
}
