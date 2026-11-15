-- Practice economics: billable time and client invoices.
-- Time is valued in paise at the rate that applied when it was recorded and is
-- frozen into an invoice when billed, so later rate changes never rewrite
-- history. Deliberately separate from the subscription "Invoice" table.

CREATE TABLE "PracticeInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "subtotalMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "issuedOn" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PracticeInvoice_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PracticeInvoice_number_key" ON "PracticeInvoice"("number");
CREATE INDEX "PracticeInvoice_organizationId_status_idx" ON "PracticeInvoice"("organizationId", "status");
CREATE INDEX "PracticeInvoice_engagementId_issuedOn_idx" ON "PracticeInvoice"("engagementId", "issuedOn");

CREATE TABLE "PracticeTimeEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "taskId" TEXT,
    "userId" TEXT NOT NULL,
    "workDate" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "ratePerHourMinor" INTEGER NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "narrative" TEXT,
    "invoiceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PracticeTimeEntry_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PracticeTimeEntry_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "PracticeInvoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "PracticeTimeEntry_organizationId_workDate_idx" ON "PracticeTimeEntry"("organizationId", "workDate");
CREATE INDEX "PracticeTimeEntry_engagementId_invoiceId_idx" ON "PracticeTimeEntry"("engagementId", "invoiceId");
CREATE INDEX "PracticeTimeEntry_userId_workDate_idx" ON "PracticeTimeEntry"("userId", "workDate");
