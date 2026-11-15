-- UDIN issuance + verification on signed deliverables (SQLite dialect).
--
-- Adds the Unique Document Identification Number minted when a signed-off
-- version is issued (see lib/engine/udin.ts), plus the verification
-- bookkeeping trail (who last verified, when, and how many times).
-- Additive only: existing rows keep their defaults.

ALTER TABLE "EngagementDeliverableVersion" ADD COLUMN "udin" TEXT;

ALTER TABLE "EngagementDeliverableVersion" ADD COLUMN "udinIssuedAt" DATETIME;

ALTER TABLE "EngagementDeliverableVersion" ADD COLUMN "udinVerifiedById" TEXT;

ALTER TABLE "EngagementDeliverableVersion" ADD COLUMN "udinVerifiedAt" DATETIME;

ALTER TABLE "EngagementDeliverableVersion" ADD COLUMN "udinVerifyCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "EngagementDeliverableVersion_udin_idx" ON "EngagementDeliverableVersion"("udin");