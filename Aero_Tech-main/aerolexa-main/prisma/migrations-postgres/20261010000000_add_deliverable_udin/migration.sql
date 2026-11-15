-- UDIN issuance + verification on signed deliverables (PostgreSQL dialect).
-- Mirrors prisma/migrations-sqlite/20261010000000_add_deliverable_udin.
-- Additive only: existing rows keep their defaults.

ALTER TABLE "EngagementDeliverableVersion" ADD COLUMN IF NOT EXISTS "udin" TEXT;

ALTER TABLE "EngagementDeliverableVersion" ADD COLUMN IF NOT EXISTS "udinIssuedAt" TIMESTAMP(3);

ALTER TABLE "EngagementDeliverableVersion" ADD COLUMN IF NOT EXISTS "udinVerifiedById" TEXT;

ALTER TABLE "EngagementDeliverableVersion" ADD COLUMN IF NOT EXISTS "udinVerifiedAt" TIMESTAMP(3);

ALTER TABLE "EngagementDeliverableVersion" ADD COLUMN IF NOT EXISTS "udinVerifyCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "EngagementDeliverableVersion_udin_idx" ON "EngagementDeliverableVersion"("udin");