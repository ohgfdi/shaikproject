-- Data alerts (KPI thresholds, anomalies, staleness) + connector webhooks
-- Alert rules watch one dataset column; evaluated after each connector sync
-- and on manual run. See lib/engine/alerts.ts (pure engine) and
-- lib/server/alerts.ts (orchestration + delivery).

CREATE TABLE "DataAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "ruleKind" TEXT NOT NULL,
    "ruleConfig" TEXT NOT NULL,
    "columnName" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 240,
    "lastFiredAt" DATETIME,
    "lastResolvedAt" DATETIME,
    "lastOutcome" TEXT NOT NULL DEFAULT 'never',
    "lastValue" REAL,
    "lastMessage" TEXT,
    "valueHistory" TEXT NOT NULL DEFAULT '[]',
    "notifyEmail" BOOLEAN NOT NULL DEFAULT true,
    "notifyWhatsapp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DataAlert_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DataAlert_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DataAlert_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "DataAlert_workspaceId_idx" ON "DataAlert"("workspaceId");
CREATE INDEX "DataAlert_datasetId_idx" ON "DataAlert"("datasetId");

-- Push-based refresh: per-connector HMAC secret for inbound webhooks.
ALTER TABLE "Connector" ADD COLUMN "webhookSecret" TEXT;
