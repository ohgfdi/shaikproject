-- Portable client-approval evidence for a filing run: the receipt itself, its
-- SHA-256 digest and when the client acted through their portal link.
ALTER TABLE "ComplianceFilingRun" ADD COLUMN IF NOT EXISTS "clientApprovedAt" TIMESTAMP(3);
ALTER TABLE "ComplianceFilingRun" ADD COLUMN IF NOT EXISTS "clientApprovalDigest" TEXT;
ALTER TABLE "ComplianceFilingRun" ADD COLUMN IF NOT EXISTS "clientApprovalReceipt" JSONB;
