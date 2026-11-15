-- CA firm work — Phase B: a persisted book of accounts.
--
-- lib/engine/accounting.ts owns the arithmetic (debits must equal credits,
-- amounts in integer minor units); these tables own the storage. A voucher line
-- stores signed minor units, positive = debit and negative = credit, so the
-- debit=credit invariant can be re-checked from the database at any time.
--
-- Workspace-scoped with ON DELETE CASCADE: one client's ledger can never be
-- read by another, and deleting the workspace removes its books.

CREATE TABLE "Book" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "entityType" TEXT NOT NULL DEFAULT 'company',
    "booksFrom" TEXT,
    "fiscalYearEnd" TEXT NOT NULL DEFAULT '03-31',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Book_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Book_workspaceId_idx" ON "Book"("workspaceId");

CREATE TABLE "BookAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "openingBalance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookAccount_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "BookAccount_bookId_idx" ON "BookAccount"("bookId");
CREATE UNIQUE INDEX "BookAccount_bookId_code_key" ON "BookAccount"("bookId", "code");

CREATE TABLE "BookVoucher" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "narration" TEXT NOT NULL,
    "reference" TEXT,
    "voucherType" TEXT NOT NULL DEFAULT 'journal',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookVoucher_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "BookVoucher_bookId_date_idx" ON "BookVoucher"("bookId", "date");
CREATE UNIQUE INDEX "BookVoucher_bookId_number_key" ON "BookVoucher"("bookId", "number");

CREATE TABLE "BookVoucherLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "voucherId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "narration" TEXT,
    CONSTRAINT "BookVoucherLine_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "BookVoucher" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookVoucherLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BookAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "BookVoucherLine_voucherId_idx" ON "BookVoucherLine"("voucherId");
CREATE INDEX "BookVoucherLine_accountId_idx" ON "BookVoucherLine"("accountId");
