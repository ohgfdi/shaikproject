import { notFoundError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { datasetColumns } from "@/lib/serialize";
import { ok, toErrorResponse } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import { datasetRowsAtVersion } from "@/lib/server/versioning";
import type { ColumnDef, SqlValue } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * tenancy-audit: global-operator — dataset rows API streams dataset rows
 * to the browser for workspace datasets. This is a deployment-wide aggregate
 * rather than a per-tenant query.
 *
 * Stream a dataset's typed rows to the browser (capped at the same sample
 * limit as analyses). Used by the in-browser DuckDB engine in the SQL Lab:
 * after this one fetch, every query runs locally — no further network round
 * trips, which keeps repeat chart/filter updates well under 100 ms.
 *
 * Workspace-level authorization mirrors the query route: viewers may read.
 */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({ where: { id: params.id } });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, { workspaceId: dataset.workspaceId, projectId: dataset.projectId }, "VIEWER");

    const url = new URL(request.url);
    const versionId = url.searchParams.get("version");
    if (versionId) {
      const owned = await prisma.datasetVersion.findFirst({
        where: { id: versionId, datasetId: dataset.id },
        select: { id: true },
      });
      if (!owned) throw notFoundError("Dataset version not found.");
    }

    const columns: ColumnDef[] = datasetColumns(dataset);
    const limit = serverEnv().DATASET_ANALYSIS_LIMIT;

    const loaded = versionId
      ? await datasetRowsAtVersion(dataset.id, versionId, limit)
      : await loadParsedDataset(dataset.id, limit);

    // RLS via the shared chokepoint: rules come from the workspace that OWNS
    // the dataset, so a member of another workspace is still restricted.
    const rls = await applyRowSecurity(ctx, dataset, { rows: loaded.rows, columns });

    return ok({
      columns,
      rows: rls.rows as SqlValue[][],
      totalRows: loaded.totalRows,
      loadedRows: rls.rows.length,
      // Honest labelling: the client knows when RLS truncated its view.
      rlsNote: rls.note || null,
      // The version snapshot the rows were served from (null when live).
      versionId: versionId ?? null,
      // Browser-side engine applies the same result row cap as the server path.
      rowCap: serverEnv().DATASET_QUERY_LIMIT,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
