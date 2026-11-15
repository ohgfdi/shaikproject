-- Client invoices gain a settlement record (paid/void), and an optional
-- Razorpay order for the client portal rail. Filing runs gain a verification
-- state so an acknowledgement can be reconciled after submission.
-- Additive and nullable throughout: existing rows stay valid.
ALTER TABLE "PracticeInvoice" ADD COLUMN "paidOn" TEXT;
ALTER TABLE "PracticeInvoice" ADD COLUMN "paymentReference" TEXT;
ALTER TABLE "PracticeInvoice" ADD COLUMN "paymentMethod" TEXT;
ALTER TABLE "PracticeInvoice" ADD COLUMN "razorpayOrderId" TEXT;
ALTER TABLE "PracticeInvoice" ADD COLUMN "razorpayPaymentId" TEXT;
ALTER TABLE "PracticeInvoice" ADD COLUMN "voidedOn" TEXT;
ALTER TABLE "PracticeInvoice" ADD COLUMN "voidReason" TEXT;

CREATE UNIQUE INDEX "PracticeInvoice_razorpayOrderId_key"
  ON "PracticeInvoice"("razorpayOrderId");

-- unverified | verified | unverifiable | defective
ALTER TABLE "ComplianceFilingRun" ADD COLUMN "verificationStatus" TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE "ComplianceFilingRun" ADD COLUMN "verifiedAt" DATETIME;
ALTER TABLE "ComplianceFilingRun" ADD COLUMN "verificationNote" TEXT;

-- Weekly partner digest: the last ISO date the digest was sent for this firm.
ALTER TABLE "Organization" ADD COLUMN "partnerDigestLastSentOn" TEXT;
