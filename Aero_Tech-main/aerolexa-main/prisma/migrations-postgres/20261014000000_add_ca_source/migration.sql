-- CaSource / CaMappingProfile / CaIngestRun / CaDocumentSnapshot
-- (PostgreSQL dialect).
-- Mirrors prisma/migrations-sqlite/20261014000000_add_ca_source.
-- Additive only: no existing table is touched.

CREATE TABLE IF NOT EXISTS "CaSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "engagementId" TEXT,
    "sourceKind" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "sourceColumns" TEXT NOT NULL,
    "displayName" TEXT,
    "syncCount" INTEGER NOT NULL DEFAULT 0,
    "lastIngestedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "documentFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CaSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaSource_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "CaMappingProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceKind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "sourceColumns" TEXT NOT NULL,
    "mapping" TEXT NOT NULL,
    "firstUsedAt" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "CaIngestRun" (
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
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaIngestRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaIngestRun_caSourceId_fkey" FOREIGN KEY ("caSourceId") REFERENCES "CaSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "CaDocumentSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "caSourceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaDocumentSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaDocumentSnapshot_caSourceId_fkey" FOREIGN KEY ("caSourceId") REFERENCES "CaSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaDocumentSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CaIngestRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "CaSource_workspaceId_idx" ON "CaSource"("workspaceId");
CREATE INDEX IF NOT EXISTS "CaSource_engagementId_idx" ON "CaSource"("engagementId");
CREATE INDEX IF NOT EXISTS "CaSource_sourceKind_idx" ON "CaSource"("sourceKind");
CREATE INDEX IF NOT EXISTS "CaMappingProfile_sourceKind_name_idx" ON "CaMappingProfile"("sourceKind", "name");
CREATE INDEX IF NOT EXISTS "CaIngestRun_workspaceId_caSourceId_idx" ON "CaIngestRun"("workspaceId", "caSourceId");
CREATE INDEX IF NOT EXISTS "CaIngestRun_caSourceId_status_idx" ON "CaIngestRun"("caSourceId", "status");
CREATE INDEX IF NOT EXISTS "CaIngestRun_startedAt_idx" ON "CaIngestRun"("startedAt");
CREATE INDEX IF NOT EXISTS "CaDocumentSnapshot_workspaceId_caSourceId_idx" ON "CaDocumentSnapshot"("workspaceId", "caSourceId");
CREATE INDEX IF NOT EXISTS "CaDocumentSnapshot_fingerprint_idx" ON "CaDocumentSnapshot"("fingerprint");
CREATE UNIQUE INDEX IF NOT EXISTS "CaDocumentSnapshot_caSourceId_runId_fingerprint_key" ON "CaDocumentSnapshot"("caSourceId", "runId", "fingerprint");
