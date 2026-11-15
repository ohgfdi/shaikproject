import { requireAuth } from "@/lib/auth/guard";
import { validateConnectorConfig, type ConnectorConfig } from "@/lib/engine/connectors/config";
import { decryptJson } from "@/lib/engine/connectors/crypto";
import { sampleConnectorRows } from "@/lib/engine/connectors/pull";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getScopedConnector } from "@/lib/server/connectors";

export const dynamic = "force-dynamic";

/**
 * Pull a sample of real rows from a source table so the user can confirm the
 * import before it happens. `limit` is client-configurable (capped server-side).
 */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const connector = await getScopedConnector(ctx, params.id);
    const url = new URL(request.url);
    const schema = (url.searchParams.get("schema") ?? "").trim();
    const table = (url.searchParams.get("table") ?? "").trim();
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 5000));
    if (!schema || !table) {
      return ok({ columns: [], rows: [], rowCount: 0, error: "Choose a schema and table to preview." });
    }
    const stored = decryptJson<ConnectorConfig>(connector.config);
    const config = validateConnectorConfig(connector.kind, stored);
    const sample = await sampleConnectorRows(config, schema, table, limit);
    return ok({ ...sample, limit });
  } catch (err) {
    return toErrorResponse(err);
  }
}
