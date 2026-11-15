-- Per-client live-filing promotion. Shadow is the default; a firm promotes a
-- client explicitly after reviewing shadow evidence. The gate is only enforced
-- when FILING_ROLLOUT_ENFORCED=true.
CREATE TABLE "FilingRollout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'shadow',
    "note" TEXT,
    "promotedById" TEXT,
    "promotedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "FilingRollout_engagementId_key" ON "FilingRollout"("engagementId");
CREATE INDEX "FilingRollout_organizationId_mode_idx" ON "FilingRollout"("organizationId", "mode");
