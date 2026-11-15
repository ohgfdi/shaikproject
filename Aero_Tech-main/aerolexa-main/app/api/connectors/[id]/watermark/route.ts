import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { CONNECTOR_IMPLEMENTED_KINDS } from "@/lib/engine/connectors/pull";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { getScopedConnector } from "@/lib/server/connectors";
import type { ColType } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/connectors/[id]/watermark — configure incremental sync (Gap ④)
 *
 * Body: { datasetId, column, colType } | { datasetId, clear: true }
 *
 * A watermark { column, value, colType } on a connector-backed dataset makes
 * the next syncs incremental for engines with a safe parameterized pull
 * (postgres, mysql): only rows with column > value are re-pulled and appended;
 * everything else stays a full replace (honest fallback). `value` starts empty
 * and is captured from the first pull — configuring it never invents state.
 * Clearing restores full-pull behavior. Both are audit-logged.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const connector = await getScopedConnector(ctx, params.id);
    if (!CONNECTOR_IMPLEMENTED_KINDS.includes(connector.kind as (typeof CONNECTOR_IMPLEMENTED_KINDS)[number])) {
      throw new ConnectorError("This connector kind has no sync engine.", { status: 400, code: "CONNECTOR_CONFIG" });
    }
    const body = await readJsonBody<{ datasetId?: string; column?: string; colType?: ColType; clear?: boolean }>(
      request,
    );
    const datasetId = body.datasetId ?? "";
    const dataset = connector.datasets.find((d) => d.id === datasetId);
    if (!dataset) {
      throw new ConnectorError("Choose a dataset imported from this connection.", {
        status: 404,
        code: "CONNECTOR_NOT_FOUND",
      });
    }

    if (body.clear) {
      await prisma.dataset.update({ where: { id: dataset.id }, data: { connectorWatermark: null } });
      await logActivity(ctx, "CONNECTOR_SYNCED", `Cleared incremental-sync watermark on “${dataset.name}”`, null, {
        connectorId: connector.id,
        datasetId: dataset.id,
      });
      return ok({ cleared: true });
    }

    const column = (body.column ?? "").trim();
    const colType = body.colType === "number" || body.colType === "date" ? body.colType : null;
    if (!column || !colType) {
      throw new ConnectorError(
        "Provide a watermark column and its type (number for ids, date for updated-at timestamps).",
        { status: 400, code: "CONNECTOR_CONFIG" },
      );
    }
    if (column.length > 120) {
      throw new ConnectorError("Watermark column name is too long.", { status: 400, code: "CONNECTOR_CONFIG" });
    }

    await prisma.dataset.update({
      where: { id: dataset.id },
      data: { connectorWatermark: JSON.stringify({ column, value: "", colType }) },
    });
    await logActivity(ctx, "CONNECTOR_SYNCED", `Enabled incremental sync on “${dataset.name}” via “${column}”`, null, {
      connectorId: connector.id,
      datasetId: dataset.id,
      column,
      colType,
    });
    return ok({ datasetId: dataset.id, watermark: { column, colType } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
