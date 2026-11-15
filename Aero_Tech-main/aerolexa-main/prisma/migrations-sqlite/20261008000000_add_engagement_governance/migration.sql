-- CA firm governance (engagement scope): jurisdiction-aware handling,
-- per-engagement practice access, working papers, and an append-only,
-- hash-chained change ledger for client data.
--
-- All statements are additive: new columns carry defaults and new tables are
-- workspace/org scoped with ON DELETE CASCADE, so an existing deployment's
-- data is untouched.

-- ---------------------------------------------------------------------------
-- Engagement: jurisdiction + retention / legal-hold posture
-- ---------------------------------------------------------------------------

ALTER TABLE "Engagement" ADD COLUMN "jurisdiction" TEXT NOT NULL DEFAULT 'IN';
ALTER TABLE "Engagement" ADD COLUMN "dataClassification" TEXT NOT NULL DEFAULT 'CONFIDENTIAL';
ALTER TABLE "Engagement" ADD COLUMN "legalHold" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Engagement" ADD COLUMN "retentionUntil" DATETIME;
ALTER TABLE "Engagement" ADD COLUMN "retainedById" TEXT;

-- ---------------------------------------------------------------------------
-- Per-engagement practice access
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "practiceRole" TEXT NOT NULL DEFAULT 'ASSISTANT',
    "assignedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EngagementMember_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EngagementMember_engagementId_userId_key" ON "EngagementMember"("engagementId", "userId");
CREATE INDEX "EngagementMember_organizationId_engagementId_idx" ON "EngagementMember"("organizationId", "engagementId");
CREATE INDEX "EngagementMember_userId_idx" ON "EngagementMember"("userId");

-- ---------------------------------------------------------------------------
-- Working papers (SA 230) + immutable versions
-- ---------------------------------------------------------------------------

CREATE TABLE "WorkingPaper" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "projectId" TEXT,
    "indexRef" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "section" TEXT,
    "saReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "classification" TEXT NOT NULL DEFAULT 'CONFIDENTIAL',
    "version" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT,
    "preparedById" TEXT,
    "preparedAt" DATETIME,
    "reviewedById" TEXT,
    "reviewedAt" DATETIME,
    "reviewNote" TEXT,
    "signedOffById" TEXT,
    "signedOffAt" DATETIME,
    "signOffRole" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkingPaper_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorkingPaper_engagementId_indexRef_key" ON "WorkingPaper"("engagementId", "indexRef");
CREATE INDEX "WorkingPaper_organizationId_engagementId_status_idx" ON "WorkingPaper"("organizationId", "engagementId", "status");

CREATE TABLE "WorkingPaperVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workingPaperId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "changeSummary" TEXT NOT NULL,
    "preparedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkingPaperVersion_workingPaperId_fkey" FOREIGN KEY ("workingPaperId") REFERENCES "WorkingPaper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorkingPaperVersion_workingPaperId_version_key" ON "WorkingPaperVersion"("workingPaperId", "version");
CREATE INDEX "WorkingPaperVersion_workingPaperId_createdAt_idx" ON "WorkingPaperVersion"("workingPaperId", "createdAt");

-- ---------------------------------------------------------------------------
-- Change control: requests + hash-chained ledger
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementChangeRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "rationale" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "assignedToPracticeRole" TEXT NOT NULL DEFAULT 'SENIOR',
    "signOffRequiredFor" TEXT NOT NULL DEFAULT 'MANAGER',
    "reviewNote" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EngagementChangeRequest_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "EngagementChangeRequest_organizationId_engagementId_state_idx" ON "EngagementChangeRequest"("organizationId", "engagementId", "state");
CREATE INDEX "EngagementChangeRequest_engagementId_updatedAt_idx" ON "EngagementChangeRequest"("engagementId", "updatedAt");

CREATE TABLE "EngagementChangeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "changeRequestId" TEXT,
    "actorId" TEXT NOT NULL,
    "actorPracticeRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "rawSummary" TEXT,
    "meta" TEXT,
    "consentAware" BOOLEAN NOT NULL DEFAULT true,
    "prevHash" TEXT,
    "entryHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EngagementChangeLog_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EngagementChangeLog_engagementId_seq_key" ON "EngagementChangeLog"("engagementId", "seq");
CREATE INDEX "EngagementChangeLog_organizationId_engagementId_createdAt_idx" ON "EngagementChangeLog"("organizationId", "engagementId", "createdAt");

-- ---------------------------------------------------------------------------
-- Client consent (engagement-scoped, append-only proof)
-- ---------------------------------------------------------------------------

CREATE TABLE "ClientConsent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "policyVersion" TEXT NOT NULL,
    "evidenceNote" TEXT,
    "recordedById" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientConsent_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ClientConsent_organizationId_engagementId_purpose_idx" ON "ClientConsent"("organizationId", "engagementId", "purpose");
