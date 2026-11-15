-- Practice economics: billable time and client invoices (PostgreSQL dialect).
-- Mirrors prisma/migrations-sqlite/20261109130000_add_practice_economics.
-- Additive only: no existing table is touched.

CREATE TABLE IF NOT EXISTS "PracticeInvoice" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PracticeInvoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PracticeInvoice_number_key" ON "PracticeInvoice"("number");
CREATE INDEX IF NOT EXISTS "PracticeInvoice_organizationId_status_idx" ON "PracticeInvoice"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "PracticeInvoice_engagementId_issuedOn_idx" ON "PracticeInvoice"("engagementId", "issuedOn");

CREATE TABLE IF NOT EXISTS "PracticeTimeEntry" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PracticeTimeEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PracticeTimeEntry_organizationId_workDate_idx" ON "PracticeTimeEntry"("organizationId", "workDate");
CREATE INDEX IF NOT EXISTS "PracticeTimeEntry_engagementId_invoiceId_idx" ON "PracticeTimeEntry"("engagementId", "invoiceId");
CREATE INDEX IF NOT EXISTS "PracticeTimeEntry_userId_workDate_idx" ON "PracticeTimeEntry"("userId", "workDate");

DO $$ BEGIN
  ALTER TABLE "PracticeInvoice"
    ADD CONSTRAINT "PracticeInvoice_engagementId_fkey"
    FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PracticeTimeEntry"
    ADD CONSTRAINT "PracticeTimeEntry_engagementId_fkey"
    FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PracticeTimeEntry"
    ADD CONSTRAINT "PracticeTimeEntry_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "PracticeInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
