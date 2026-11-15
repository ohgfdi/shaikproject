import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { WhatIfPanel } from "@/components/whatif/what-if-panel";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { datasetColumns } from "@/lib/serialize";
import { moduleEnabled } from "@/lib/server/modules";

export const metadata = { title: "What-if simulator" };

export default async function DatasetWhatIfPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requirePageAuth();
  // 404 (not a redirect) so a frozen profile cannot be probed for which
  // datasets exist, and so a bookmarked What-if URL stops being a back door
  // around the hidden sub-nav tab.
  if (!moduleEnabled("WHATIF_ENABLED")) notFound();
  const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
  if (!dataset || dataset.workspaceId !== ctx.workspace.id) notFound();

  const columns = datasetColumns(dataset);

  return (
    <div>
      <PageHeader
        title="What-if simulator"
        description={
          <>
            Perturb one column (e.g. price) and see the estimated effect on another (e.g. margin) using a multivariate
            ordinary-least-squares model (optional control variables, exact Student-t inference) on{" "}
            <Link className="text-accent hover:underline" href={`/datasets/${dataset.id}`}>
              {dataset.name}
            </Link>
            .
          </>
        }
      />
      <WhatIfPanel
        datasetId={dataset.id}
        datasetName={dataset.name}
        columns={columns.map((c) => ({ name: c.name, type: c.type }))}
      />
    </div>
  );
}
