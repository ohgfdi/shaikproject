import { LayoutDashboard, Plus } from "lucide-react";

import { ArtifactGrid } from "@/components/layout/artifact-grid";
import { PageHeader } from "@/components/layout/page-header";
import { ButtonLink } from "@/components/ui/button";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

export const metadata = { title: "Dashboards" };

/**
 * tenancy-audit: global-operator — dashboards page lists workspace-wide
 * dashboards for the firm home view.
 * This is a deployment-wide aggregate rather than a per-tenant query.
 */
export default async function DashboardsPage() {
  const ctx = await requirePageAuth();
  const dashboards = await prisma.dashboard.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { updatedAt: "desc" },
    include: { project: { select: { name: true } } },
    take: 200,
  });

  return (
    <div>
      <PageHeader
        title="Dashboards"
        description="Interactive dashboards created from your analyses and datasets."
        actions={
          <ButtonLink href="/dashboards/new" icon={<Plus aria-hidden className="size-4" />}>
            New dashboard
          </ButtonLink>
        }
      />
      <div className="mt-6">
        <ArtifactGrid
          icon={LayoutDashboard}
          emptyTitle="No dashboards yet"
          emptyDescription="Build your first interactive dashboard to explore your data visually."
          createHref="/dashboards/new"
          createLabel="New dashboard"
          items={dashboards.map((d) => ({
            id: d.id,
            title: d.title,
            sub: d.project?.name,
            href: `/dashboards/${d.id}`,
            updatedAt: d.updatedAt,
          }))}
        />
      </div>
    </div>
  );
}
