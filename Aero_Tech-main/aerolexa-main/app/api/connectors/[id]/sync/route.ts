import { requireAuth } from "@/lib/auth/guard";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { runConnectorSync } from "@/lib/server/connector-sync";
import { getScopedConnector } from "@/lib/server/connectors";

export const dynamic = "force-dynamic";

/**
 * Re-pull one imported dataset (or every imported dataset when no datasetId is
 * given) right now. Each run is recorded with a snapshot + change log — the
 * same code path the scheduler tick uses, with `triggeredBy: manual`.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const connector = await getScopedConnector(ctx, params.id);
    const body = await readJsonBody<{ datasetId?: string }>(request);

    const targets = body.datasetId
      ? connector.datasets.filter((dataset) => dataset.id === body.datasetId)
      : connector.datasets;
    if (targets.length === 0) {
      return ok({ synced: 0, message: "This connection has no imported datasets to sync yet. Import a table first." });
    }

    const outcomes = [];
    for (const dataset of targets) {
      const outcome = await runConnectorSync(connector.id, dataset.id, "manual");
      outcomes.push(outcome);
      await logActivity(
        ctx,
        "CONNECTOR_SYNCED",
        `Synced “${dataset.name}” from “${connector.name}”${outcome.status === "SUCCESS" ? ` (${outcome.rowCount.toLocaleString()} rows, ${outcome.changeLog?.rowsAdded ?? 0} added / ${outcome.changeLog?.rowsRemoved ?? 0} removed)` : " — sync failed"}`,
        null,
        { connectorId: connector.id, datasetId: dataset.id, runId: outcome.runId || null },
      );
    }

    const failed = outcomes.filter((outcome) => outcome.status === "ERROR");
    return ok({
      synced: outcomes.length,
      failed: failed.length,
      outcomes: outcomes.map((outcome) => ({
        datasetId: outcome.datasetId,
        status: outcome.status,
        rowCount: outcome.rowCount,
        changeLog: outcome.changeLog,
        error: outcome.error,
      })),
      message:
        failed.length === 0
          ? `Synced ${outcomes.length} dataset(s).`
          : `${failed.length} of ${outcomes.length} sync(s) failed. See the error for details on how to fix.`,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
