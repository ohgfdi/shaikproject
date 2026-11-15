-- GstFilingCampaign: GST filing campaign runbook for a book + GSTIN.
-- Mirrors the FilingCampaign shape used by app/api/books/[id]/gst-filing/route.
-- Additive only: no existing table is touched.

-- CreateTable
CREATE TABLE "GstFilingCampaign" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GstFilingCampaign_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GstFilingCampaign_bookId_status_idx" ON "GstFilingCampaign"("bookId", "status");
CREATE INDEX "GstFilingCampaign_bookId_formType_period_idx" ON "GstFilingCampaign"("bookId", "formType", "period");
CREATE INDEX "GstFilingCampaign_bookId_gstin_idx" ON "GstFilingCampaign"("bookId", "gstin");