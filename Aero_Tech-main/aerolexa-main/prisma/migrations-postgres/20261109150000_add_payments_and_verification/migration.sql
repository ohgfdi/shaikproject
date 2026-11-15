-- Client invoices gain a settlement record (paid/void), and an optional
-- Razorpay order for the client portal rail. Filing runs gain a verification
-- state so an acknowledgement can be reconciled after submission.
-- Additive and nullable throughout: existing rows stay valid.
ALTER TABLE "PracticeInvoice" ADD COLUMN IF NOT EXISTS "paidOn" TEXT;
ALTER TABLE "PracticeInvoice" ADD COLUMN IF NOT EXISTS "paymentReference" TEXT;
ALTER TABLE "PracticeInvoice" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT;
ALTER TABLE "PracticeInvoice" ADD COLUMN IF NOT EXISTS "razorpayOrderId" TEXT;
ALTER TABLE "PracticeInvoice" ADD COLUMN IF NOT EXISTS "razorpayPaymentId" TEXT;
ALTER TABLE "PracticeInvoice" ADD COLUMN IF NOT EXISTS "voidedOn" TEXT;
ALTER TABLE "PracticeInvoice" ADD COLUMN IF NOT EXISTS "voidReason" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "PracticeInvoice_razorpayOrderId_key"
  ON "PracticeInvoice"("razorpayOrderId");

-- unverified | verified | unverifiable | defective
ALTER TABLE "ComplianceFilingRun" ADD COLUMN IF NOT EXISTS "verificationStatus" TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE "ComplianceFilingRun" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
ALTER TABLE "ComplianceFilingRun" ADD COLUMN IF NOT EXISTS "verificationNote" TEXT;

-- Weekly partner digest: the last ISO date the digest was sent for this firm.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "partnerDigestLastSentOn" TEXT;
