-- Portable client-approval evidence for a filing run: the receipt itself, its
-- SHA-256 digest and when the client acted through their portal link.
ALTER TABLE "ComplianceFilingRun" ADD COLUMN "clientApprovedAt" DATETIME;
ALTER TABLE "ComplianceFilingRun" ADD COLUMN "clientApprovalDigest" TEXT;
ALTER TABLE "ComplianceFilingRun" ADD COLUMN "clientApprovalReceipt" JSON;
