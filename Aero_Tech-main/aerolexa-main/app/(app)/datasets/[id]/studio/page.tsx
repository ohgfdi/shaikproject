import Link from "next/link";
import { notFound } from "next/navigation";

/**
 * tenancy-audit: global-operator — dataset studio page displays Power BI
 * workspace-wide analytics. This is a deployment-wide aggregate rather than a
 * per-tenant query.
 */

import { PageHeader } from "@/components/layout/page-header";
import { PowerBiStudioPanel } from "@/components/pbi/power-bi-studio-panel";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { datasetColumns } from "@/lib/serialize";

export const metadata = { title: "Power BI studio" };

export default async function DatasetPowerBiStudioPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requirePageAuth();
  const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
  if (!dataset || dataset.workspaceId !== ctx.workspace.id) notFound();

  const columns = datasetColumns(dataset);

  return (
    <div>
      <PageHeader
        title="Power BI studio"
        description={
          <>
            KPI scorecards, a DAX-style measure builder and AI visuals (decomposition tree, key influencers) computed
            from actual rows of{" "}
            <Link className="text-accent hover:underline" href={`/datasets/${dataset.id}`}>
              {dataset.name}
            </Link>
            . Every number is deterministic — no predictions.
          </>
        }
      />
      <PowerBiStudioPanel
        datasetId={dataset.id}
        datasetName={dataset.name}
        columns={columns.map((c) => ({ name: c.name, type: c.type }))}
      />
    </div>
  );
}
