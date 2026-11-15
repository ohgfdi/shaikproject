import { Notebook } from "lucide-react";
import { notFound } from "next/navigation";

import { ArtifactGrid } from "@/components/layout/artifact-grid";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { moduleEnabled } from "@/lib/server/modules";

export const metadata = { title: "Notebooks" };

export default async function NotebooksPage() {
  const ctx = await requirePageAuth();
  // 404 rather than redirect: a frozen profile must not enumerate the
  // workspace's notebooks, and the nav entry that links here is already hidden.
  if (!moduleEnabled("NOTEBOOK_ENABLED")) notFound();
  const notebooks = await prisma.notebook.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { updatedAt: "desc" },
    include: { project: { select: { id: true, name: true } } },
    take: 200,
  });

  return (
    <div>
      <PageHeader title="Notebooks" description="Python notebooks and prototype code across every project." />
      <div className="mt-6">
        <ArtifactGrid
          icon={Notebook}
          emptyTitle="No notebooks yet"
          emptyDescription="Notebooks are created inside the notebook tab of a project — head to a project and open the Notebook tab."
          items={notebooks.map((n) => ({
            id: n.id,
            title: n.title,
            sub: n.project?.name ?? "No project",
            href: n.projectId ? `/projects/${n.projectId}?tab=notebook` : "#",
            updatedAt: n.updatedAt,
          }))}
        />
      </div>
    </div>
  );
}
