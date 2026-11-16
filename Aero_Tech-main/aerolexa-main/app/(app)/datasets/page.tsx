import { FileSpreadsheet } from "lucide-react";

/**
 * tenancy-audit: global-operator — datasets page shows
 * workspace-wide dataset listing for the firm home view.
 * This is a deployment-wide aggregate rather than a per-tenant query.
 */

import { DatasetUploader } from "@/components/datasets/dataset-uploader";
import { ArtifactGrid } from "@/components/layout/artifact-grid";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";

export const metadata = { title: "Datasets" };

/**
 * The datasets index: everything uploaded into this workspace, newest first,
 * plus the upload entry point. Individual datasets live at /datasets/[id].
 */
export default async function DatasetsPage() {
  const ctx = await requirePageAuth();
  const [datasets, projects] = await Promise.all([
    await withTenantDb(ctx, (db) => prisma.dataset.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        rowCount: true,
        isDemo: true,
        updatedAt: true,
        project: { select: { name: true } },
      },
      take: 200,
    })),
    await withTenantDb(ctx, (db) => prisma.project.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true },
      take: 200,
    })),
  ]);

  return (
    <div>
      <PageHeader
        title="Datasets"
        description="Every dataset in this workspace, newest first. Upload a CSV or XLSX to profile it, then explore, transform and chart it."
      />
      <div className="mt-6 space-y-6">
        <DatasetUploader projects={projects} />
        <ArtifactGrid
          icon={FileSpreadsheet}
          emptyTitle="No datasets yet"
          emptyDescription="Upload a CSV or XLSX file above to profile your first dataset."
          items={datasets.map((d) => ({
            id: d.id,
            title: d.name,
            sub: d.project?.name ?? (d.isDemo ? "Demo data" : `${d.rowCount.toLocaleString()} rows`),
            href: `/datasets/${d.id}`,
            updatedAt: d.updatedAt,
          }))}
        />
      </div>
    </div>
  );
}
