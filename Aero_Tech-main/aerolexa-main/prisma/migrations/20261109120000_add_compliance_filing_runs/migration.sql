-- Filing execution: the calendar generates obligations, this pipeline owns the
-- work (prepared → reviewed → client-approved → filed → acknowledged) and the
-- acknowledgement that proves it. Reaching filed/acknowledged also writes the
-- ClientComplianceStatus row the calendar reads, so the two never diverge.
--
-- PostgreSQL dialect. Mirrors prisma/migrations-sqlite/20261109120000_add_compliance_filing_runs.
-- Additive only: no existing table is touched.

CREATE TABLE IF NOT EXISTS "ComplianceFilingRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'computed',
    "assigneeId" TEXT,
    "reviewerId" TEXT,
    "acknowledgementReference" TEXT,
    "filedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComplianceFilingRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ComplianceFilingEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT NOT NULL,
    "note" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComplianceFilingEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ComplianceFilingRun_engagementId_taskId_key"
  ON "ComplianceFilingRun"("engagementId", "taskId");
CREATE INDEX IF NOT EXISTS "ComplianceFilingRun_organizationId_stage_idx"
  ON "ComplianceFilingRun"("organizationId", "stage");
CREATE INDEX IF NOT EXISTS "ComplianceFilingRun_engagementId_stage_idx"
  ON "ComplianceFilingRun"("engagementId", "stage");
CREATE INDEX IF NOT EXISTS "ComplianceFilingRun_assigneeId_stage_idx"
  ON "ComplianceFilingRun"("assigneeId", "stage");
CREATE INDEX IF NOT EXISTS "ComplianceFilingEvent_runId_createdAt_idx"
  ON "ComplianceFilingEvent"("runId", "createdAt");
CREATE INDEX IF NOT EXISTS "ComplianceFilingEvent_organizationId_createdAt_idx"
  ON "ComplianceFilingEvent"("organizationId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "ComplianceFilingRun"
    ADD CONSTRAINT "ComplianceFilingRun_engagementId_fkey"
    FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ComplianceFilingEvent"
    ADD CONSTRAINT "ComplianceFilingEvent_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "ComplianceFilingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
