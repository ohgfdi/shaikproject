-- CA firm governance (engagement scope) — PostgreSQL dialect.
-- Mirrors prisma/migrations-sqlite/20261008000000_add_engagement_governance.
-- Additive only: existing rows keep their defaults.

-- ---------------------------------------------------------------------------
-- Engagement: jurisdiction + retention / legal-hold posture
-- ---------------------------------------------------------------------------

ALTER TABLE "Engagement" ADD COLUMN "jurisdiction" TEXT NOT NULL DEFAULT 'IN';
ALTER TABLE "Engagement" ADD COLUMN "dataClassification" TEXT NOT NULL DEFAULT 'CONFIDENTIAL';
ALTER TABLE "Engagement" ADD COLUMN "legalHold" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Engagement" ADD COLUMN "retentionUntil" TIMESTAMP(3);
ALTER TABLE "Engagement" ADD COLUMN "retainedById" TEXT;

-- ---------------------------------------------------------------------------
-- Per-engagement practice access
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "practiceRole" TEXT NOT NULL DEFAULT 'ASSISTANT',
    "assignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngagementMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EngagementMember_engagementId_userId_key" ON "EngagementMember"("engagementId", "userId");
CREATE INDEX "EngagementMember_organizationId_engagementId_idx" ON "EngagementMember"("organizationId", "engagementId");
CREATE INDEX "EngagementMember_userId_idx" ON "EngagementMember"("userId");
ALTER TABLE "EngagementMember" ADD CONSTRAINT "EngagementMember_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Working papers (SA 230) + immutable versions
-- ---------------------------------------------------------------------------

CREATE TABLE "WorkingPaper" (
    "id" TEXT NOT NULL,
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
    "preparedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "signedOffById" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "signOffRole" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkingPaper_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkingPaper_engagementId_indexRef_key" ON "WorkingPaper"("engagementId", "indexRef");
CREATE INDEX "WorkingPaper_organizationId_engagementId_status_idx" ON "WorkingPaper"("organizationId", "engagementId", "status");
ALTER TABLE "WorkingPaper" ADD CONSTRAINT "WorkingPaper_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkingPaperVersion" (
    "id" TEXT NOT NULL,
    "workingPaperId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "changeSummary" TEXT NOT NULL,
    "preparedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkingPaperVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkingPaperVersion_workingPaperId_version_key" ON "WorkingPaperVersion"("workingPaperId", "version");
CREATE INDEX "WorkingPaperVersion_workingPaperId_createdAt_idx" ON "WorkingPaperVersion"("workingPaperId", "createdAt");
ALTER TABLE "WorkingPaperVersion" ADD CONSTRAINT "WorkingPaperVersion_workingPaperId_fkey" FOREIGN KEY ("workingPaperId") REFERENCES "WorkingPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Change control: requests + hash-chained ledger
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementChangeRequest" (
    "id" TEXT NOT NULL,
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
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngagementChangeRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EngagementChangeRequest_organizationId_engagementId_state_idx" ON "EngagementChangeRequest"("organizationId", "engagementId", "state");
CREATE INDEX "EngagementChangeRequest_engagementId_updatedAt_idx" ON "EngagementChangeRequest"("engagementId", "updatedAt");
ALTER TABLE "EngagementChangeRequest" ADD CONSTRAINT "EngagementChangeRequest_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EngagementChangeLog" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementChangeLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EngagementChangeLog_engagementId_seq_key" ON "EngagementChangeLog"("engagementId", "seq");
CREATE INDEX "EngagementChangeLog_organizationId_engagementId_createdAt_idx" ON "EngagementChangeLog"("organizationId", "engagementId", "createdAt");
ALTER TABLE "EngagementChangeLog" ADD CONSTRAINT "EngagementChangeLog_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Client consent (engagement-scoped, append-only proof)
-- ---------------------------------------------------------------------------

CREATE TABLE "ClientConsent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "policyVersion" TEXT NOT NULL,
    "evidenceNote" TEXT,
    "recordedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientConsent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientConsent_organizationId_engagementId_purpose_idx" ON "ClientConsent"("organizationId", "engagementId", "purpose");
ALTER TABLE "ClientConsent" ADD CONSTRAINT "ClientConsent_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
