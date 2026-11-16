import { redirect } from "next/navigation";

// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - new analysis page is a deployment-wide aggregate operation

import { AnalysisWizard } from "@/components/analyses/analysis-wizard";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";
import { datasetColumns } from "@/lib/serialize";

export const metadata = { title: "Analysis Lab" };

export default async function NewAnalysisPage(props: {
  searchParams: Promise<{ project?: string; dataset?: string }>;
}) {
  const searchParams = await props.searchParams;
  const ctx = await requirePageAuth();
  const projectId = searchParams.project;
  if (!projectId) redirect("/projects");

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.workspaceId !== ctx.workspace.id) redirect("/projects");

  const datasets = await withTenantDb(ctx, (db) =>
    db.dataset.findMany({
      where: { workspaceId: ctx.workspace.id, projectId, status: "READY" },
      orderBy: { createdAt: "desc" },
    }),
  );

  return (
    <div>
      <PageHeader
        title="Analysis Lab"
        description={`Run an analysis against data in “${project.name}”. Every result keeps its exact columns, filters and methodology.`}
      />
      <AnalysisWizard
        projectId={project.id}
        initialDatasetId={searchParams.dataset}
        datasets={datasets.map((d) => ({
          id: d.id,
          name: d.name,
          rowCount: d.rowCount,
          isDemo: d.isDemo,
          columns: datasetColumns(d),
        }))}
      />
    </div>
  );
}
