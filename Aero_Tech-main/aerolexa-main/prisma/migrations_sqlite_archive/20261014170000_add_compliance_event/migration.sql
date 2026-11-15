-- Durable compliance evidence, independent of any workspace (DPDP erasure
-- proof). See the ComplianceEvent model comment in prisma/schema.prisma: the
-- proof previously lived in Activity, which cascades when erasure deletes the
-- personal workspace — so the record of the erasure was erased with it.

-- CreateTable
CREATE TABLE "ComplianceEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "subjectId" TEXT,
    "organizationId" TEXT,
    "ipHash" TEXT,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ComplianceEvent_kind_createdAt_idx" ON "ComplianceEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "ComplianceEvent_subjectId_idx" ON "ComplianceEvent"("subjectId");

