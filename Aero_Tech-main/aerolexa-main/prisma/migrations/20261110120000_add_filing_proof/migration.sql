-- Immutable evidence for the latest filing-gateway attempt.
ALTER TABLE "ComplianceFilingRun" ADD COLUMN IF NOT EXISTS "proofBundle" JSONB;
ALTER TABLE "ComplianceFilingRun" ADD COLUMN IF NOT EXISTS "proofDigest" TEXT;
ALTER TABLE "ComplianceFilingRun" ADD COLUMN IF NOT EXISTS "proofCapturedAt" TIMESTAMP(3);
