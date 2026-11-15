/**
 * Connector serializers (server-only).
 *
 * Every object returned to the client is built here so credentials can never
 * leak: `connectorView` deliberately picks only safe fields and never touches
 * the encrypted config blob.
 */
import { assertWorkspaceAccess, notFoundError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { nextRunAt } from "@/lib/engine/cron";
import { parseJson } from "@/lib/json";
import type { ConnectorChangeLog, ConnectorSyncRunView, ConnectorView } from "@/lib/types";

export interface ConnectorRowLike {
  id: string;
  name: string;
  kind: string;
  status: string;
  lastTestedAt: Date | null;
  lastError: string | null;
  syncEnabled: boolean;
  syncCron: string | null;
  lastSyncAt: Date | null;
  createdAt: Date;
  datasets?: { id: string; name: string; connectorSourceTable: string | null; rowCount: number }[];
}

/**
 * Fetch a connector, assert the caller's workspace owns it, and return it with
 * its imported datasets (for the safe view). Every connector route goes
 * through here — workspace isolation is enforced once, not per handler.
 */
export async function getScopedConnector(ctx: AuthContext, id: string) {
  const connector = await prisma.connector.findUnique({
    where: { id },
    include: {
      datasets: {
        select: { id: true, name: true, connectorSourceTable: true, rowCount: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
  });
  if (!connector) throw notFoundError("Connector not found.");
  assertWorkspaceAccess(ctx, connector, "Connector");
  return connector;
}

/** Safe client view of a Connector row — no config, no credentials. */
export function connectorView(connector: ConnectorRowLike): ConnectorView {
  let nextSyncAt: string | null = null;
  if (connector.syncEnabled && connector.syncCron) {
    try {
      nextSyncAt = nextRunAt(connector.syncCron, connector.lastSyncAt ?? new Date())?.toISOString() ?? null;
    } catch {
      nextSyncAt = null;
    }
  }
  return {
    id: connector.id,
    name: connector.name,
    kind: connector.kind,
    status: connector.status as ConnectorView["status"],
    lastTestedAt: connector.lastTestedAt ? connector.lastTestedAt.toISOString() : null,
    lastError: connector.lastError,
    syncEnabled: connector.syncEnabled,
    syncCron: connector.syncCron,
    lastSyncAt: connector.lastSyncAt ? connector.lastSyncAt.toISOString() : null,
    nextSyncAt,
    importedDatasets: (connector.datasets ?? []).map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      sourceTable: dataset.connectorSourceTable,
      rowCount: dataset.rowCount,
    })),
    createdAt: connector.createdAt.toISOString(),
  };
}

export interface SyncRunRowLike {
  id: string;
  datasetId: string;
  dataset: { name: string } | null;
  tableName: string;
  status: string;
  rowCount: number | null;
  changeLog: string | null;
  error: string | null;
  triggeredBy: string;
  startedAt: Date;
  finishedAt: Date | null;
}

/** Safe client view of a sync run (parses the stored change log JSON). */
export function syncRunView(run: SyncRunRowLike): ConnectorSyncRunView {
  return {
    id: run.id,
    datasetId: run.datasetId,
    datasetName: run.dataset?.name ?? "dataset",
    tableName: run.tableName,
    status: run.status as ConnectorSyncRunView["status"],
    rowCount: run.rowCount,
    changeLog: run.changeLog ? parseJson<ConnectorChangeLog | null>(run.changeLog, null) : null,
    error: run.error,
    triggeredBy: run.triggeredBy as ConnectorSyncRunView["triggeredBy"],
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}
