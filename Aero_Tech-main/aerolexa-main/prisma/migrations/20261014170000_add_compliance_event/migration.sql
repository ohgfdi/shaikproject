-- Durable compliance evidence, independent of any workspace (DPDP erasure
-- proof). See the ComplianceEvent model comment in prisma/schema.prisma.

-- CreateTable
CREATE TABLE "ComplianceEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectId" TEXT,
    "organizationId" TEXT,
    "ipHash" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplianceEvent_kind_createdAt_idx" ON "ComplianceEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "ComplianceEvent_subjectId_idx" ON "ComplianceEvent"("subjectId");

