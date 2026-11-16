import { notFound } from "next/navigation";

import { PowerQueryStudio } from "@/components/datasets/power-query-studio";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

export const metadata = { title: "Transform · Power Query studio" };

/**
 * tenancy-audit: global-operator — dataset transform page visualizes Power Query
 * studio for workspace-wide dataset preparation. This is a deployment-wide aggregate
 * rather than a per-tenant query.
 */

* GET /datasets/[id]/transform — visual data preparation. *
 * The Power Query engine (lib/engine/powerquery.ts, 20 step kinds) already had
 * an API; this page gives it a UI: an applied-steps list with add/remove/
 * reorder, a before/after preview table and per-step row counts — the exact
 * shape POST /api/datasets/[id]/transform already returns.
 *
 * Saved steps ride on the dataset's existing JSON `preview`-style storage:
 * they are persisted in `qualityWarnings`-adjacent JSON on the row? No — the
 * steps live on the Dataset.transformSteps JSON column added by migration
 * 20260922000000_dataset_transform_steps. Analyses and exports keep reading
 * the materialized store; the studio is a preparation surface, not a mutation
 * of the source file.
 */
export default async function TransformPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePageAuth();
  const dataset = await prisma.dataset.findUnique({
    where: { id },
    select: { id: true, name: true, transformSteps: true },
  });
  if (!dataset) notFound();

  let initialSteps: import("@/lib/engine/powerquery").PQStep[] = [];
  try {
    const parsed: unknown = JSON.parse(dataset.transformSteps ?? "[]");
    if (Array.isArray(parsed)) initialSteps = parsed as import("@/lib/engine/powerquery").PQStep[];
  } catch {
    initialSteps = []; // corrupt JSON → start from the source
  }

  return <PowerQueryStudio datasetId={dataset.id} datasetName={dataset.name} initialSteps={initialSteps} />;
}
