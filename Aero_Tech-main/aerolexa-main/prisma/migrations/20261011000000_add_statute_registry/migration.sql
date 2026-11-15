-- Statute & notification rule registry (PostgreSQL dialect).
-- Mirrors prisma/migrations-sqlite/20261011000000_add_statute_registry.
-- Additive only: no existing table is touched, so existing rows keep working.

CREATE TABLE IF NOT EXISTS "StatuteSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'json',
    "kind" TEXT NOT NULL DEFAULT 'notification',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "checkCron" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StatuteSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StatuteSource_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "StatuteSource_workspaceId_key_key" ON "StatuteSource"("workspaceId", "key");
CREATE INDEX IF NOT EXISTS "StatuteSource_workspaceId_idx" ON "StatuteSource"("workspaceId");

CREATE TABLE IF NOT EXISTS "StatuteNotification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "publishedAt" TEXT,
    "effectiveFrom" TEXT,
    "effectiveTo" TEXT,
    "excerpt" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "impactedRuleKeys" TEXT NOT NULL,
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'new',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    CONSTRAINT "StatuteNotification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StatuteNotification_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "StatuteSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "StatuteNotification_workspaceId_sourceId_contentHash_key" ON "StatuteNotification"("workspaceId", "sourceId", "contentHash");
CREATE INDEX IF NOT EXISTS "StatuteNotification_workspaceId_status_idx" ON "StatuteNotification"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "StatuteNotification_sourceId_idx" ON "StatuteNotification"("sourceId");

CREATE TABLE IF NOT EXISTS "StatutoryRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StatutoryRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "StatutoryRule_workspaceId_key_key" ON "StatutoryRule"("workspaceId", "key");
CREATE INDEX IF NOT EXISTS "StatutoryRule_workspaceId_idx" ON "StatutoryRule"("workspaceId");

CREATE TABLE IF NOT EXISTS "StatutoryRuleVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "ay" TEXT,
    "entityTypes" TEXT NOT NULL DEFAULT '[]',
    "states" TEXT NOT NULL DEFAULT '[]',
    "scope" TEXT NOT NULL DEFAULT 'central',
    "unit" TEXT NOT NULL,
    "rows" TEXT NOT NULL,
    "valueSummary" TEXT NOT NULL,
    "citation" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "effectiveTo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notificationId" TEXT,
    "supersedesId" TEXT,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "notes" TEXT,
    CONSTRAINT "StatutoryRuleVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StatutoryRuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "StatutoryRule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StatutoryRuleVersion_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "StatuteNotification" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StatutoryRuleVersion_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "StatutoryRuleVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StatutoryRuleVersion_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "StatutoryRuleVersion_workspaceId_ruleId_version_key" ON "StatutoryRuleVersion"("workspaceId", "ruleId", "version");
CREATE INDEX IF NOT EXISTS "StatutoryRuleVersion_workspaceId_ruleId_idx" ON "StatutoryRuleVersion"("workspaceId", "ruleId");
CREATE INDEX IF NOT EXISTS "StatutoryRuleVersion_ruleId_status_idx" ON "StatutoryRuleVersion"("ruleId", "status");
