import { requireAuth } from "@/lib/auth/guard";
import { SqlError } from "@/lib/engine/sql";
import { serverEnv } from "@/lib/env";
import { logActivity } from "@/lib/server/activity";
import { readJsonBody, toErrorResponse, ok } from "@/lib/server/api";
import { runQueryOnDatasets } from "@/lib/server/dataset-query";
import { requireModule } from "@/lib/server/modules";

export const dynamic = "force-dynamic";

const MAX_SQL_LENGTH = 20_000;

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // Same predicate as the "SQL lab" sub-nav tab, so a frozen profile hides
    // the tab and refuses the query instead of leaving a live back door.
    requireModule("SQL_LAB_ENABLED");
    const ctx = await requireAuth();
    const body = await readJsonBody<{ sql?: string; datasetIds?: string[] }>(request);
    const sql = (body.sql ?? "").trim();
    if (!sql) {
      return toErrorResponse(new SqlError("Write a SELECT query to run."));
    }
    if (sql.length > MAX_SQL_LENGTH) {
      return toErrorResponse(new SqlError("The query is too long (max 20 000 characters)."));
    }
    const outcome = await runQueryOnDatasets(ctx, body.datasetIds?.length ? body.datasetIds : [params.id], sql, {
      rowCap: serverEnv().DATASET_QUERY_LIMIT,
    });
    await logActivity(
      ctx,
      "SQL_QUERY_RUN",
      `SQL query run on “${outcome.datasetName}” (${outcome.result.rowCount.toLocaleString()} rows returned)`,
      outcome.projectId,
      { datasetIds: outcome.sourceDatasetIds },
    );
    return ok({
      result: outcome.result,
      dataset: { id: outcome.datasetId, name: outcome.datasetName, totalRows: outcome.datasetRowCount },
      sourceDatasetIds: outcome.sourceDatasetIds,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
