-- Tenancy, ledger lifecycle and subledger posting contract (PostgreSQL).
-- Mirrors prisma/migrations-sqlite/20261020100000_harden_tenancy_ledger.

ALTER TABLE "Book" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
CREATE INDEX IF NOT EXISTS "Book_organizationId_idx" ON "Book"("organizationId");
DO $$ BEGIN
  ALTER TABLE "Book" ADD CONSTRAINT "Book_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "BookVoucher" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'posted';
ALTER TABLE "BookVoucher" ADD COLUMN IF NOT EXISTS "postedAt" TIMESTAMP(3);
ALTER TABLE "BookVoucher" ADD COLUMN IF NOT EXISTS "totalDebit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BookVoucher" ADD COLUMN IF NOT EXISTS "totalCredit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BookVoucher" ADD COLUMN IF NOT EXISTS "reversalOfId" TEXT;

UPDATE "BookVoucher"
SET "totalDebit" = COALESCE((SELECT SUM(CASE WHEN "amount" > 0 THEN "amount" ELSE 0 END) FROM "BookVoucherLine" WHERE "BookVoucherLine"."voucherId" = "BookVoucher"."id"), 0),
    "totalCredit" = COALESCE((SELECT SUM(CASE WHEN "amount" < 0 THEN -"amount" ELSE 0 END) FROM "BookVoucherLine" WHERE "BookVoucherLine"."voucherId" = "BookVoucher"."id"), 0),
    "postedAt" = COALESCE("postedAt", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "BookVoucher_reversalOfId_key" ON "BookVoucher"("reversalOfId");
CREATE INDEX IF NOT EXISTS "BookVoucher_bookId_status_date_idx" ON "BookVoucher"("bookId", "status", "date");
DO $$ BEGIN
  ALTER TABLE "BookVoucher" ADD CONSTRAINT "BookVoucher_reversalOfId_fkey"
    FOREIGN KEY ("reversalOfId") REFERENCES "BookVoucher" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "BookAuditEntry" ADD COLUMN IF NOT EXISTS "prevHash" TEXT;
ALTER TABLE "BookAuditEntry" ADD COLUMN IF NOT EXISTS "hash" TEXT;

CREATE TABLE IF NOT EXISTS "FiscalPeriodLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedById" TEXT NOT NULL,
    "reason" TEXT,
    CONSTRAINT "FiscalPeriodLock_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "FiscalPeriodLock_bookId_period_key" ON "FiscalPeriodLock"("bookId", "period");
CREATE INDEX IF NOT EXISTS "FiscalPeriodLock_bookId_idx" ON "FiscalPeriodLock"("bookId");

CREATE TABLE IF NOT EXISTS "SubledgerPosting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedById" TEXT,
    CONSTRAINT "SubledgerPosting_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SubledgerPosting_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "BookVoucher" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "SubledgerPosting_bookId_sourceType_sourceId_key" ON "SubledgerPosting"("bookId", "sourceType", "sourceId");
CREATE INDEX IF NOT EXISTS "SubledgerPosting_bookId_sourceType_idx" ON "SubledgerPosting"("bookId", "sourceType");
CREATE INDEX IF NOT EXISTS "SubledgerPosting_voucherId_idx" ON "SubledgerPosting"("voucherId");
