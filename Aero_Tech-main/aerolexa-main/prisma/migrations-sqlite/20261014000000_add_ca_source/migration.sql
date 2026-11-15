-- CA source ingestion: reusable "column X means canonical field Y" mapping
-- profiles, append-only ingest runs, and fingerprint-deduped document
-- snapshots. Additive only: no existing table is touched.
--
-- Without this migration the schema's CaSource/CaMappingProfile/CaIngestRun/
-- CaDocumentSnapshot models have no backing tables, so /ca-sources fails with
-- P2021 ("table main.CaSource does not exist") on a freshly migrated database.

-- CreateTable
CREATE TABLE "CaSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "engagementId" TEXT,
    "sourceKind" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "sourceColumns" TEXT NOT NULL,
    "displayName" TEXT,
    "syncCount" INTEGER NOT NULL DEFAULT 0,
    "lastIngestedAt" DATETIME,
    "lastError" TEXT,
    "documentFingerprint" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CaSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaSource_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CaMappingProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceKind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "sourceColumns" TEXT NOT NULL,
    "mapping" TEXT NOT NULL,
    "firstUsedAt" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CaIngestRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "caSourceId" TEXT NOT NULL,
    "syncVersion" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "rowCount" INTEGER,
    "documentCount" INTEGER,
    "report" TEXT,
    "reconciliation" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaIngestRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaIngestRun_caSourceId_fkey" FOREIGN KEY ("caSourceId") REFERENCES "CaSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CaDocumentSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "caSourceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaDocumentSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaDocumentSnapshot_caSourceId_fkey" FOREIGN KEY ("caSourceId") REFERENCES "CaSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaDocumentSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CaIngestRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CaSource_workspaceId_idx" ON "CaSource"("workspaceId");
CREATE INDEX "CaSource_engagementId_idx" ON "CaSource"("engagementId");
CREATE INDEX "CaSource_sourceKind_idx" ON "CaSource"("sourceKind");
CREATE INDEX "CaMappingProfile_sourceKind_name_idx" ON "CaMappingProfile"("sourceKind", "name");
CREATE INDEX "CaIngestRun_workspaceId_caSourceId_idx" ON "CaIngestRun"("workspaceId", "caSourceId");
CREATE INDEX "CaIngestRun_caSourceId_status_idx" ON "CaIngestRun"("caSourceId", "status");
CREATE INDEX "CaIngestRun_startedAt_idx" ON "CaIngestRun"("startedAt");
CREATE INDEX "CaDocumentSnapshot_workspaceId_caSourceId_idx" ON "CaDocumentSnapshot"("workspaceId", "caSourceId");
CREATE INDEX "CaDocumentSnapshot_fingerprint_idx" ON "CaDocumentSnapshot"("fingerprint");
CREATE UNIQUE INDEX "CaDocumentSnapshot_caSourceId_runId_fingerprint_key" ON "CaDocumentSnapshot"("caSourceId", "runId", "fingerprint");
