import { randomUUID } from "node:crypto";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { SqlError } from "@/lib/engine/sql";
import { serverEnv } from "@/lib/env";
import { storeRowsAsDataset } from "@/lib/file/store-rows";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { runQueryOnDatasets } from "@/lib/server/dataset-query";
import { requireModule } from "@/lib/server/modules";

export const dynamic = "force-dynamic";

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // Only reachable from the SQL Lab panel, so it freezes with SQL Lab.
    requireModule("SQL_LAB_ENABLED");
    const ctx = await requireAuth();
    const body = await readJsonBody<{ sql?: string; name?: string; datasetIds?: string[] }>(request);
    const sql = (body.sql ?? "").trim();
    const name = (body.name ?? "").trim();
    if (!sql) throw new SqlError("Write a SELECT query to materialize.");
    if (!name || name.length > 140) {
      throw new ApiError(400, "VALIDATION", "Give the new dataset a name (max 140 characters).");
    }

    const outcome = await runQueryOnDatasets(ctx, body.datasetIds?.length ? body.datasetIds : [params.id], sql, {
      rowCap: serverEnv().DATASET_QUERY_LIMIT,
      minRole: "EDITOR",
    });
    if (outcome.result.columns.length === 0 || outcome.result.rows.length === 0) {
      throw new SqlError("The query returned no rows — nothing to materialize.");
    }

    const id = randomUUID();
    const stored = await storeRowsAsDataset(id, outcome.result.columns, outcome.result.rows);

    const dataset = await prisma.dataset.create({
      data: {
        id,
        workspaceId: ctx.workspace.id,
        projectId: outcome.projectId,
        name,
        originalName: `${name}.sql-result`,
        mimeType: "application/x-Ledgerly-sql-result",
        sizeBytes: outcome.result.rows.length * 64,
        rowCount: stored.rowCount,
        columnCount: stored.columns.length,
        isDemo: false,
        status: "READY",
        ndjsonPath: `${id}.ndjson`,
        profile: stringifyJson(stored.profile),
        columns: stringifyJson(stored.columns),
        preview: stringifyJson(stored.preview),
        qualityWarnings: stringifyJson(stored.qualityWarnings),
        createdById: ctx.user.id,
      },
    });
    await prisma.datasetProvenance.createMany({
      data: outcome.sourceDatasetIds.map((sourceDatasetId) => ({
        derivedDatasetId: dataset.id,
        sourceDatasetId,
        query: sql,
      })),
    });

    await logActivity(
      ctx,
      "SQL_MATERIALIZED",
      `SQL result materialized as dataset “${dataset.name}” (${stored.rowCount.toLocaleString()} rows)`,
      outcome.projectId,
      { datasetId: dataset.id, sourceDatasetIds: outcome.sourceDatasetIds },
    );

    return ok({
      datasetId: dataset.id,
      name: dataset.name,
      rowCount: stored.rowCount,
      columnCount: stored.columns.length,
      warnings: stored.qualityWarnings.length,
      sourceDatasetIds: outcome.sourceDatasetIds,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
