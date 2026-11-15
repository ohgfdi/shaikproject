-- Filing execution: the calendar generates obligations, this pipeline owns the
-- work (prepared → reviewed → client-approved → filed → acknowledged) and the
-- acknowledgement that proves it. Reaching filed/acknowledged also writes the
-- ClientComplianceStatus row the calendar reads, so the two never diverge.

CREATE TABLE "ComplianceFilingRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "filedAt" DATETIME,
    "acknowledgedAt" DATETIME,
    "blockedReason" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ComplianceFilingRun_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ComplianceFilingEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT NOT NULL,
    "note" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComplianceFilingEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ComplianceFilingRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ComplianceFilingRun_engagementId_taskId_key" ON "ComplianceFilingRun"("engagementId", "taskId");
CREATE INDEX "ComplianceFilingRun_organizationId_stage_idx" ON "ComplianceFilingRun"("organizationId", "stage");
CREATE INDEX "ComplianceFilingRun_engagementId_stage_idx" ON "ComplianceFilingRun"("engagementId", "stage");
CREATE INDEX "ComplianceFilingRun_assigneeId_stage_idx" ON "ComplianceFilingRun"("assigneeId", "stage");
CREATE INDEX "ComplianceFilingEvent_runId_createdAt_idx" ON "ComplianceFilingEvent"("runId", "createdAt");
CREATE INDEX "ComplianceFilingEvent_organizationId_createdAt_idx" ON "ComplianceFilingEvent"("organizationId", "createdAt");
