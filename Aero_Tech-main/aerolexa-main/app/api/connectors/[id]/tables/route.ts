import { requireAuth } from "@/lib/auth/guard";
import { validateConnectorConfig, type ConnectorConfig } from "@/lib/engine/connectors/config";
import { decryptJson } from "@/lib/engine/connectors/crypto";
import { listConnectorTables } from "@/lib/engine/connectors/pull";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getScopedConnector } from "@/lib/server/connectors";

export const dynamic = "force-dynamic";

/** Introspect the live source: real tables + columns from information_schema. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const connector = await getScopedConnector(ctx, params.id);
    const stored = decryptJson<ConnectorConfig>(connector.config);
    const config = validateConnectorConfig(connector.kind, stored);
    const tables = await listConnectorTables(config);

    let source: { host: string; database: string };
    switch (config.kind) {
      case "postgres":
        source = { host: config.postgres.host, database: config.postgres.database };
        break;
      case "snowflake":
        source = { host: config.snowflake.account, database: config.snowflake.database };
        break;
      case "bigquery":
        source = { host: "bigquery.googleapis.com", database: config.bigquery.projectId };
        break;
      case "mysql":
        source = { host: config.mysql.host, database: config.mysql.database };
        break;
      case "mongodb":
        source = { host: config.mongodb.host, database: config.mongodb.database };
        break;
      case "tally":
        source = { host: "file-upload", database: "tally-export" };
        break;
      case "gst":
        source = { host: "file-upload", database: "gst-return" };
        break;
      case "bank-statement":
        source = { host: "file-upload", database: "bank-statement" };
        break;
      default:
        source = { host: "unknown", database: "unknown" };
    }

    return ok({
      tables: tables.slice(0, 100),
      source,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
