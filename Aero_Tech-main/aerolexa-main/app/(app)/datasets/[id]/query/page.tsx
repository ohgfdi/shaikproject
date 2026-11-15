import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { SqlLab } from "@/components/sql/sql-lab";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { datasetColumns } from "@/lib/serialize";
import { moduleEnabled } from "@/lib/server/modules";

export const metadata = { title: "SQL Lab" };

export default async function DatasetQueryPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requirePageAuth();
  // 404 so a frozen profile cannot be probed for dataset existence, and so a
  // bookmarked SQL Lab URL is not a back door around the hidden sub-nav tab.
  if (!moduleEnabled("SQL_LAB_ENABLED")) notFound();
  const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
  if (!dataset || dataset.workspaceId !== ctx.workspace.id) notFound();

  const columns = datasetColumns(dataset);
  const projectDatasets = dataset.projectId
    ? await prisma.dataset.findMany({
        where: { projectId: dataset.projectId, workspaceId: ctx.workspace.id },
        orderBy: { createdAt: "asc" },
      })
    : [dataset];

  return (
    <div>
      <PageHeader
        title="SQL Lab"
        description={
          <>
            Run read-only SELECT queries against{" "}
            <Link className="text-accent hover:underline" href={`/datasets/${dataset.id}`}>
              {dataset.name}
            </Link>{" "}
            and materialize results as new datasets.
          </>
        }
      />
      <SqlLab
        datasetId={dataset.id}
        datasetName={dataset.name}
        columns={columns.map((c) => ({ name: c.name, type: c.type }))}
        totalRows={dataset.rowCount}
        datasets={projectDatasets.map((source) => ({
          id: source.id,
          name: source.name,
          columns: datasetColumns(source).map((column) => ({ name: column.name, type: column.type })),
        }))}
      />
    </div>
  );
}
