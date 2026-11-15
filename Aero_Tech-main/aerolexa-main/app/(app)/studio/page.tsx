import { PageHeader } from "@/components/layout/page-header";
import { StudioPanel } from "@/components/studio/studio-panel";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { datasetColumns } from "@/lib/serialize";

export const metadata = { title: "Visualization Studio" };

export default async function StudioPage() {
  const ctx = await requirePageAuth();
  const datasets = await prisma.dataset.findMany({
    where: { workspaceId: ctx.workspace.id, status: "READY" },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  return (
    <div>
      <PageHeader
        title="Visualization Studio"
        description="Compose dimension, metric and chart type against your uploaded data. Filters and titles auto-populate — everything renders from real rows."
      />
      <StudioPanel
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
