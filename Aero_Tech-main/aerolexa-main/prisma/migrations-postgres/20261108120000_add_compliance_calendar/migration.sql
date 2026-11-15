-- Statutory compliance calendar: one registration profile per client and the
-- firm's filed/waived state per generated obligation.
CREATE TABLE "ClientComplianceProfile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClientComplianceProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientComplianceProfile_engagementId_key" ON "ClientComplianceProfile"("engagementId");
CREATE INDEX "ClientComplianceProfile_organizationId_idx" ON "ClientComplianceProfile"("organizationId");

ALTER TABLE "ClientComplianceProfile" ADD CONSTRAINT "ClientComplianceProfile_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ClientComplianceStatus" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "filedOn" TEXT,
    "reference" TEXT,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClientComplianceStatus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientComplianceStatus_engagementId_taskId_key" ON "ClientComplianceStatus"("engagementId", "taskId");
CREATE INDEX "ClientComplianceStatus_organizationId_status_idx" ON "ClientComplianceStatus"("organizationId", "status");

ALTER TABLE "ClientComplianceStatus" ADD CONSTRAINT "ClientComplianceStatus_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
