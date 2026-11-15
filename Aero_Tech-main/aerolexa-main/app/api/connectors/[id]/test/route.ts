import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { validateConnectorConfig, type ConnectorConfig } from "@/lib/engine/connectors/config";
import { decryptJson } from "@/lib/engine/connectors/crypto";
import { testConnector } from "@/lib/engine/connectors/pull";
import { logActivity } from "@/lib/server/activity";
import { ok, toErrorResponse } from "@/lib/server/api";
import { connectorView, getScopedConnector } from "@/lib/server/connectors";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

/** Run a real connection test against the stored (decrypted server-side) config. */
export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let ctx: Awaited<ReturnType<typeof requireAuth>> | null = null;
  try {
    ctx = await requireAuth();
    // A test opens a real outbound connection to a Postgres/Snowflake/BigQuery
    // host. Unmetered, this is a free amplifier aimed at a third party.
    enforceUserRateLimit(ctx.user.id, "connector_test", RATE_LIMITS.connector_test);
    const connector = await getScopedConnector(ctx, params.id);
    const stored = decryptJson<ConnectorConfig>(connector.config);
    const config = validateConnectorConfig(connector.kind, stored);

    const meta = await testConnector(config);
    await prisma.connector.update({
      where: { id: connector.id },
      data: { status: "ok", lastTestedAt: new Date(), lastError: null },
    });
    await logActivity(
      ctx,
      "CONNECTOR_TESTED",
      `Tested connection “${connector.name}” (${meta.serverVersion}, ${meta.latencyMs} ms)`,
      null,
      { connectorId: connector.id },
    );
    return ok({
      ok: true,
      meta,
      connector: connectorView({ ...connector, status: "ok", lastTestedAt: new Date(), lastError: null }),
    });
  } catch (err) {
    // A failed test is a first-class result, not a crash: record the clean
    // "What happened / How to fix" message on the connector (scoped to the
    // caller's workspace) and return a 4xx so the UI can show it.
    const message = err instanceof Error ? err.message : "The connection test failed.";
    if (ctx) {
      const connector = await prisma.connector.findUnique({ where: { id: params.id } });
      if (connector && connector.workspaceId === ctx.workspace.id) {
        await prisma.connector
          .update({ where: { id: params.id }, data: { status: "error", lastError: message } })
          .catch(() => undefined);
      }
    }
    return toErrorResponse(err);
  }
}
