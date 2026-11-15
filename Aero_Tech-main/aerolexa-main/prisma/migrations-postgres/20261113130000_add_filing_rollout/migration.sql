-- Per-client live-filing promotion. Shadow is the default; a firm promotes a
-- client explicitly after reviewing shadow evidence. The gate is only enforced
-- when FILING_ROLLOUT_ENFORCED=true.
CREATE TABLE "FilingRollout" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'shadow',
    "note" TEXT,
    "promotedById" TEXT,
    "promotedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FilingRollout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FilingRollout_engagementId_key" ON "FilingRollout"("engagementId");
CREATE INDEX "FilingRollout_organizationId_mode_idx" ON "FilingRollout"("organizationId", "mode");
