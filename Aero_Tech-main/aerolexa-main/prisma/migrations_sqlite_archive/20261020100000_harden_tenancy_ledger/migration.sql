-- Tenancy, ledger lifecycle and subledger posting contract.
-- Additive only. Backfills are safe to re-run.

-- ---------------------------------------------------------------------------
-- Book: optional organization owner (legacy personal books stay NULL)
-- ---------------------------------------------------------------------------
ALTER TABLE "Book" ADD COLUMN "organizationId" TEXT;
CREATE INDEX "Book_organizationId_idx" ON "Book"("organizationId");

-- ---------------------------------------------------------------------------
-- Voucher lifecycle + cached totals + reversal chain
-- ---------------------------------------------------------------------------
ALTER TABLE "BookVoucher" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'posted';
ALTER TABLE "BookVoucher" ADD COLUMN "postedAt" DATETIME;
ALTER TABLE "BookVoucher" ADD COLUMN "totalDebit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BookVoucher" ADD COLUMN "totalCredit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BookVoucher" ADD COLUMN "reversalOfId" TEXT;

UPDATE "BookVoucher"
SET "totalDebit" = COALESCE((SELECT SUM(CASE WHEN "amount" > 0 THEN "amount" ELSE 0 END) FROM "BookVoucherLine" WHERE "BookVoucherLine"."voucherId" = "BookVoucher"."id"), 0),
    "totalCredit" = COALESCE((SELECT SUM(CASE WHEN "amount" < 0 THEN -"amount" ELSE 0 END) FROM "BookVoucherLine" WHERE "BookVoucherLine"."voucherId" = "BookVoucher"."id"), 0),
    "postedAt" = COALESCE("postedAt", "createdAt");

CREATE UNIQUE INDEX "BookVoucher_reversalOfId_key" ON "BookVoucher"("reversalOfId");
CREATE INDEX "BookVoucher_bookId_status_date_idx" ON "BookVoucher"("bookId", "status", "date");

-- ---------------------------------------------------------------------------
-- Audit tamper evidence
-- ---------------------------------------------------------------------------
ALTER TABLE "BookAuditEntry" ADD COLUMN "prevHash" TEXT;
ALTER TABLE "BookAuditEntry" ADD COLUMN "hash" TEXT;

-- ---------------------------------------------------------------------------
-- Fiscal period locks
-- ---------------------------------------------------------------------------
CREATE TABLE "FiscalPeriodLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "lockedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedById" TEXT NOT NULL,
    "reason" TEXT,
    CONSTRAINT "FiscalPeriodLock_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FiscalPeriodLock_bookId_period_key" ON "FiscalPeriodLock"("bookId", "period");
CREATE INDEX "FiscalPeriodLock_bookId_idx" ON "FiscalPeriodLock"("bookId");

-- ---------------------------------------------------------------------------
-- Subledger ↔ ledger posting map
-- ---------------------------------------------------------------------------
CREATE TABLE "SubledgerPosting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "postedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedById" TEXT,
    CONSTRAINT "SubledgerPosting_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SubledgerPosting_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "BookVoucher" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SubledgerPosting_bookId_sourceType_sourceId_key" ON "SubledgerPosting"("bookId", "sourceType", "sourceId");
CREATE INDEX "SubledgerPosting_bookId_sourceType_idx" ON "SubledgerPosting"("bookId", "sourceType");
CREATE INDEX "SubledgerPosting_voucherId_idx" ON "SubledgerPosting"("voucherId");
