import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { validateConnectorConfig, type ConnectorConfig } from "@/lib/engine/connectors/config";
import { decryptJson, encryptJson } from "@/lib/engine/connectors/crypto";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { testConnector } from "@/lib/engine/connectors/pull";
import { parseCron, CronError } from "@/lib/engine/cron";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { connectorView, getScopedConnector } from "@/lib/server/connectors";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const connector = await getScopedConnector(ctx, params.id);
    return ok({ connector: connectorView(connector) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const connector = await getScopedConnector(ctx, params.id);
    const body = await readJsonBody<{
      name?: string;
      config?: unknown;
      syncEnabled?: boolean;
      syncCron?: string | null;
      test?: boolean;
    }>(request);

    const data: {
      name?: string;
      config?: string;
      syncEnabled?: boolean;
      syncCron?: string | null;
      status?: string;
      lastError?: string | null;
      lastTestedAt?: Date;
    } = {};

    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name || name.length > 140) {
        throw new ConnectorError(
          "Give this connection a name (max 140 characters). How to fix: shorten the name and save again.",
        );
      }
      data.name = name;
    }

    // Re-validating the whole config keeps a corrupt blob from ever landing.
    if (body.config !== undefined) {
      const config = validateConnectorConfig(connector.kind, body.config);
      data.config = encryptJson(config);
      data.status = "untested";
      data.lastError = null;
    }

    if (body.syncCron !== undefined || body.syncEnabled !== undefined) {
      const syncEnabled = body.syncEnabled ?? connector.syncEnabled;
      const syncCron = body.syncCron === undefined ? connector.syncCron : body.syncCron;
      if (syncEnabled && !syncCron) {
        throw new ConnectorError(
          "Scheduled sync needs a cron expression. How to fix: pick a schedule or disable scheduled sync.",
        );
      }
      if (syncCron) {
        try {
          parseCron(syncCron);
        } catch (err) {
          throw new ConnectorError(
            err instanceof CronError
              ? err.message
              : "The cron expression is invalid. How to fix: use the 5-field format (minute hour day month weekday).",
          );
        }
        data.syncCron = syncCron.trim();
      } else {
        data.syncCron = null;
      }
      data.syncEnabled = syncEnabled;
    }

    const updated = await prisma.connector.update({ where: { id: connector.id }, data });

    // Re-test live when the credentials changed, unless the client opts out.
    if (body.config !== undefined && body.test !== false) {
      const stored = decryptJson<ConnectorConfig>(updated.config);
      try {
        const meta = await testConnector(stored);
        await prisma.connector.update({
          where: { id: connector.id },
          data: { status: "ok", lastTestedAt: new Date(), lastError: null },
        });
        await logActivity(
          ctx,
          "CONNECTOR_TESTED",
          `Re-tested connection “${updated.name}” (${meta.serverVersion}, ${meta.latencyMs} ms)`,
          null,
          { connectorId: connector.id },
        );
      } catch (err) {
        await prisma.connector.update({
          where: { id: connector.id },
          data: { status: "error", lastError: err instanceof Error ? err.message : "Connection test failed." },
        });
      }
    }

    await logActivity(ctx, "CONNECTOR_UPDATED", `Updated connection “${updated.name}”`, null, {
      connectorId: connector.id,
    });
    return ok({ connector: connectorView(updated) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const connector = await getScopedConnector(ctx, params.id);
    if (connector.datasets.length > 0) {
      throw new ConnectorError(
        "This connection still has imported datasets. What happened: deleting it would orphan them. How to fix: delete the imported datasets first, or keep the connection.",
      );
    }
    await prisma.connector.delete({ where: { id: connector.id } });
    await logActivity(ctx, "CONNECTOR_DELETED", `Deleted connection “${connector.name}”`, null, {
      connectorId: connector.id,
    });
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
