-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'postgres',
    "name" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'untested',
    "lastTestedAt" DATETIME,
    "lastError" TEXT,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "syncCron" TEXT,
    "lastSyncAt" DATETIME,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Connector_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Connector_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConnectorSyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "rowCount" INTEGER,
    "changeLog" TEXT,
    "error" TEXT,
    "snapshotPath" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'manual',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConnectorSyncRun_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConnectorSyncRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Dataset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "columnCount" INTEGER NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "filePath" TEXT,
    "ndjsonPath" TEXT NOT NULL,
    "error" TEXT,
    "profile" TEXT,
    "columns" TEXT NOT NULL,
    "preview" TEXT,
    "qualityWarnings" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "connectorId" TEXT,
    "connectorSourceTable" TEXT,
    CONSTRAINT "Dataset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Dataset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Dataset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Dataset_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Dataset" ("columnCount", "columns", "createdAt", "createdById", "error", "filePath", "id", "isDemo", "mimeType", "name", "ndjsonPath", "originalName", "preview", "profile", "projectId", "qualityWarnings", "rowCount", "sizeBytes", "status", "updatedAt", "workspaceId") SELECT "columnCount", "columns", "createdAt", "createdById", "error", "filePath", "id", "isDemo", "mimeType", "name", "ndjsonPath", "originalName", "preview", "profile", "projectId", "qualityWarnings", "rowCount", "sizeBytes", "status", "updatedAt", "workspaceId" FROM "Dataset";
DROP TABLE "Dataset";
ALTER TABLE "new_Dataset" RENAME TO "Dataset";
CREATE INDEX "Dataset_workspaceId_projectId_idx" ON "Dataset"("workspaceId", "projectId");
CREATE INDEX "Dataset_connectorId_idx" ON "Dataset"("connectorId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Connector_workspaceId_idx" ON "Connector"("workspaceId");

-- CreateIndex
CREATE INDEX "ConnectorSyncRun_workspaceId_connectorId_createdAt_idx" ON "ConnectorSyncRun"("workspaceId", "connectorId", "createdAt");

-- CreateIndex
CREATE INDEX "ConnectorSyncRun_datasetId_idx" ON "ConnectorSyncRun"("datasetId");
