-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AnalysisVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "datasetVersionId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'eda',
    "title" TEXT NOT NULL DEFAULT '',
    "result" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "metrics" TEXT NOT NULL DEFAULT '[]',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalysisVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AnalysisVersion_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AnalysisVersion_datasetVersionId_fkey" FOREIGN KEY ("datasetVersionId") REFERENCES "DatasetVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AnalysisVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_AnalysisVersion" ("analysisId", "config", "createdAt", "createdById", "datasetVersionId", "id", "kind", "metrics", "result", "title", "version", "workspaceId") SELECT "analysisId", "config", "createdAt", "createdById", "datasetVersionId", "id", "kind", "metrics", "result", "title", "version", "workspaceId" FROM "AnalysisVersion";
DROP TABLE "AnalysisVersion";
ALTER TABLE "new_AnalysisVersion" RENAME TO "AnalysisVersion";
CREATE INDEX "AnalysisVersion_workspaceId_analysisId_createdAt_idx" ON "AnalysisVersion"("workspaceId", "analysisId", "createdAt");
CREATE UNIQUE INDEX "AnalysisVersion_analysisId_version_key" ON "AnalysisVersion"("analysisId", "version");
CREATE TABLE "new_ConnectorSyncRun" (
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
    CONSTRAINT "ConnectorSyncRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConnectorSyncRun_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConnectorSyncRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ConnectorSyncRun" ("changeLog", "connectorId", "createdAt", "datasetId", "error", "finishedAt", "id", "rowCount", "snapshotPath", "startedAt", "status", "tableName", "triggeredBy", "workspaceId") SELECT "changeLog", "connectorId", "createdAt", "datasetId", "error", "finishedAt", "id", "rowCount", "snapshotPath", "startedAt", "status", "tableName", "triggeredBy", "workspaceId" FROM "ConnectorSyncRun";
DROP TABLE "ConnectorSyncRun";
ALTER TABLE "new_ConnectorSyncRun" RENAME TO "ConnectorSyncRun";
CREATE INDEX "ConnectorSyncRun_workspaceId_connectorId_createdAt_idx" ON "ConnectorSyncRun"("workspaceId", "connectorId", "createdAt");
CREATE INDEX "ConnectorSyncRun_datasetId_idx" ON "ConnectorSyncRun"("datasetId");
CREATE TABLE "new_Dashboard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "widgets" TEXT NOT NULL,
    "accessMode" TEXT NOT NULL DEFAULT 'workspace',
    "shareToken" TEXT,
    "publishedAt" DATETIME,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Dashboard_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Dashboard_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Dashboard_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Dashboard" ("createdAt", "createdById", "description", "id", "projectId", "title", "updatedAt", "widgets", "workspaceId") SELECT "createdAt", "createdById", "description", "id", "projectId", "title", "updatedAt", "widgets", "workspaceId" FROM "Dashboard";
DROP TABLE "Dashboard";
ALTER TABLE "new_Dashboard" RENAME TO "Dashboard";
CREATE UNIQUE INDEX "Dashboard_shareToken_key" ON "Dashboard"("shareToken");
CREATE INDEX "Dashboard_workspaceId_projectId_idx" ON "Dashboard"("workspaceId", "projectId");
CREATE TABLE "new_DatasetVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "rowCount" INTEGER NOT NULL,
    "columnCount" INTEGER NOT NULL,
    "ndjsonPath" TEXT NOT NULL,
    "columns" TEXT NOT NULL DEFAULT '[]',
    "profile" TEXT,
    "qualityWarnings" TEXT,
    "changeLog" TEXT,
    "previousVersionId" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DatasetVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DatasetVersion_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DatasetVersion_previousVersionId_fkey" FOREIGN KEY ("previousVersionId") REFERENCES "DatasetVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DatasetVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_DatasetVersion" ("changeLog", "columnCount", "columns", "createdAt", "createdById", "datasetId", "id", "label", "ndjsonPath", "previousVersionId", "profile", "qualityWarnings", "rowCount", "source", "version", "workspaceId") SELECT "changeLog", "columnCount", "columns", "createdAt", "createdById", "datasetId", "id", "label", "ndjsonPath", "previousVersionId", "profile", "qualityWarnings", "rowCount", "source", "version", "workspaceId" FROM "DatasetVersion";
DROP TABLE "DatasetVersion";
ALTER TABLE "new_DatasetVersion" RENAME TO "DatasetVersion";
CREATE INDEX "DatasetVersion_workspaceId_datasetId_createdAt_idx" ON "DatasetVersion"("workspaceId", "datasetId", "createdAt");
CREATE UNIQUE INDEX "DatasetVersion_datasetId_version_key" ON "DatasetVersion"("datasetId", "version");
CREATE TABLE "new_NotebookVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "notebookId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotebookVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotebookVersion_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "Notebook" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotebookVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_NotebookVersion" ("config", "createdAt", "createdById", "id", "notebookId", "result", "version", "workspaceId") SELECT "config", "createdAt", "createdById", "id", "notebookId", "result", "version", "workspaceId" FROM "NotebookVersion";
DROP TABLE "NotebookVersion";
ALTER TABLE "new_NotebookVersion" RENAME TO "NotebookVersion";
CREATE INDEX "NotebookVersion_workspaceId_notebookId_createdAt_idx" ON "NotebookVersion"("workspaceId", "notebookId", "createdAt");
CREATE TABLE "new_ProjectJoinMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "leftDatasetId" TEXT NOT NULL,
    "leftColumn" TEXT NOT NULL,
    "leftType" TEXT NOT NULL,
    "rightDatasetId" TEXT NOT NULL,
    "rightColumn" TEXT NOT NULL,
    "rightType" TEXT NOT NULL,
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectJoinMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectJoinMapping_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectJoinMapping_leftDatasetId_fkey" FOREIGN KEY ("leftDatasetId") REFERENCES "Dataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectJoinMapping_rightDatasetId_fkey" FOREIGN KEY ("rightDatasetId") REFERENCES "Dataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ProjectJoinMapping" ("createdAt", "id", "leftColumn", "leftDatasetId", "leftType", "projectId", "rightColumn", "rightDatasetId", "rightType", "updatedAt", "warnings", "workspaceId") SELECT "createdAt", "id", "leftColumn", "leftDatasetId", "leftType", "projectId", "rightColumn", "rightDatasetId", "rightType", "updatedAt", "warnings", "workspaceId" FROM "ProjectJoinMapping";
DROP TABLE "ProjectJoinMapping";
ALTER TABLE "new_ProjectJoinMapping" RENAME TO "ProjectJoinMapping";
CREATE INDEX "ProjectJoinMapping_workspaceId_projectId_idx" ON "ProjectJoinMapping"("workspaceId", "projectId");
CREATE TABLE "new_Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "sections" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "accessMode" TEXT NOT NULL DEFAULT 'workspace',
    "shareToken" TEXT,
    "publishedAt" DATETIME,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Report_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Report_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Report_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Report" ("createdAt", "createdById", "id", "projectId", "sections", "title", "updatedAt", "version", "workspaceId") SELECT "createdAt", "createdById", "id", "projectId", "sections", "title", "updatedAt", "version", "workspaceId" FROM "Report";
DROP TABLE "Report";
ALTER TABLE "new_Report" RENAME TO "Report";
CREATE UNIQUE INDEX "Report_shareToken_key" ON "Report"("shareToken");
CREATE INDEX "Report_workspaceId_projectId_idx" ON "Report"("workspaceId", "projectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "VerificationToken_userId_idx" ON "VerificationToken"("userId");
