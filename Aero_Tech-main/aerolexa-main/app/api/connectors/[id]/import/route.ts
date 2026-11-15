import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { importConnectorTable } from "@/lib/server/connector-sync";
import { getScopedConnector } from "@/lib/server/connectors";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

/** Pull a real table from the source and materialize it as an Ledgerly Dataset. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    // Opens a live warehouse connection, streams rows to disk and builds a
    // dataset. The single most expensive operation a user can trigger.
    enforceUserRateLimit(ctx.user.id, "connector_import", RATE_LIMITS.connector_import);
    const connector = await getScopedConnector(ctx, params.id);
    const body = await readJsonBody<{ schema?: string; table?: string; name?: string; limit?: number }>(request);
    const result = await importConnectorTable({
      ctx,
      connectorId: connector.id,
      schema: body.schema ?? "",
      table: body.table ?? "",
      datasetName: body.name ?? "",
      rowCap: body.limit,
    });
    return ok({ ...result, connectorId: connector.id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
