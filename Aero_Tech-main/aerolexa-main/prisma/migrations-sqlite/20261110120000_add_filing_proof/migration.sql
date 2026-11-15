-- Immutable evidence for the latest filing-gateway attempt.
ALTER TABLE "ComplianceFilingRun" ADD COLUMN "proofBundle" TEXT;
ALTER TABLE "ComplianceFilingRun" ADD COLUMN "proofDigest" TEXT;
ALTER TABLE "ComplianceFilingRun" ADD COLUMN "proofCapturedAt" DATETIME;
