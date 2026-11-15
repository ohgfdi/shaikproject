-- GstFilingCampaign (PostgreSQL dialect).
-- Mirrors prisma/migrations-sqlite/20261012000000_add_gst_filing_campaign.
-- Additive only: no existing table is touched.

CREATE TABLE IF NOT EXISTS "GstFilingCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "gstin" TEXT NOT NULL,
    "formType" TEXT NOT NULL DEFAULT 'gstr-3b',
    "period" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "signingMethod" TEXT NOT NULL DEFAULT 'evc',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "ackNumber" TEXT,
    "ackDate" TEXT,
    "irn" TEXT,
    "filedById" TEXT,
    "filedAt" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GstFilingCampaign_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "GstFilingCampaign_bookId_status_idx" ON "GstFilingCampaign"("bookId", "status");
CREATE INDEX IF NOT EXISTS "GstFilingCampaign_bookId_formType_period_idx" ON "GstFilingCampaign"("bookId", "formType", "period");
CREATE INDEX IF NOT EXISTS "GstFilingCampaign_bookId_gstin_idx" ON "GstFilingCampaign"("bookId", "gstin");