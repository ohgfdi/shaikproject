import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { validateConnectorConfig } from "@/lib/engine/connectors/config";
import { encryptJson } from "@/lib/engine/connectors/crypto";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { testConnector, CONNECTOR_IMPLEMENTED_KINDS } from "@/lib/engine/connectors/pull";
import { parseCron, CronError } from "@/lib/engine/cron";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { connectorView } from "@/lib/server/connectors";
import { requireEntitlement } from "@/lib/server/entitlements";

export const dynamic = "force-dynamic";

/** List this workspace's connectors (safe view — never the stored config). */
export async function GET() {
  try {
    const ctx = await requireAuth();
    const connectors = await prisma.connector.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return ok({ connectors: connectors.map(connectorView) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    // External data-platform capacity is a Pro/Firm entitlement (billing never
    // changes what a connector imports — only whether the rail is available).
    await requireEntitlement(ctx.workspace.id, "externalConnectors", { feature: "External connectors" });
    const body = await readJsonBody<{
      kind?: string;
      name?: string;
      config?: unknown;
      test?: boolean;
      syncEnabled?: boolean;
      syncCron?: string | null;
    }>(request);
    const kind = (body.kind ?? "postgres").trim();
    const name = (body.name ?? "").trim();
    if (!name || name.length > 140) {
      throw new ConnectorError(
        "Give this connection a name (max 140 characters). How to fix: name it after the database or team it serves.",
      );
    }
    // Postgres, Snowflake and BigQuery are implemented end-to-end
    // (connect/test/browse/sample/import/sync). Unknown kinds are rejected
    // up front with one clear message instead of a config-schema complaint.
    if (!CONNECTOR_IMPLEMENTED_KINDS.includes(kind as (typeof CONNECTOR_IMPLEMENTED_KINDS)[number])) {
      throw new ConnectorError(
        `The ${kind} connector is not implemented or not enabled. How to fix: choose an available connector from the list.`,
      );
    }
    const config = validateConnectorConfig(kind, body.config);
    if (body.syncEnabled && !body.syncCron) {
      throw new ConnectorError(
        "Scheduled sync needs a cron expression. How to fix: pick a schedule or disable scheduled sync.",
      );
    }
    let syncCron: string | null = null;
    if (body.syncCron) {
      try {
        parseCron(body.syncCron);
        syncCron = body.syncCron.trim();
      } catch (err) {
        throw new ConnectorError(
          err instanceof CronError
            ? err.message
            : "The cron expression is invalid. How to fix: use the 5-field format (minute hour day month weekday).",
        );
      }
    }

    const connector = await prisma.connector.create({
      data: {
        workspaceId: ctx.workspace.id,
        kind,
        name,
        config: encryptJson(config),
        syncEnabled: body.syncEnabled ?? false,
        syncCron,
        createdById: ctx.user.id,
      },
    });

    // Optional immediate live test so the user gets real feedback on save.
    let viewConnector = connector;
    if (body.test !== false) {
      const meta = await testConnector(config);
      const tested = await prisma.connector.update({
        where: { id: connector.id },
        data: { status: "ok", lastTestedAt: new Date(), lastError: null },
      });
      viewConnector = tested;
      await logActivity(
        ctx,
        "CONNECTOR_TESTED",
        `Tested connection “${name}” (${meta.serverVersion}, ${meta.latencyMs} ms)`,
        null,
        { connectorId: connector.id },
      );
    }

    await logActivity(ctx, "CONNECTOR_CREATED", `Created ${kind} connection “${name}”`, null, {
      connectorId: connector.id,
    });
    return ok({ connector: connectorView(viewConnector) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
