-- Document requests: the firm asking a client for a missing document, with a
-- deadline and a reminder trail. Everything is workspace-scoped.
CREATE TABLE "ClientDocumentRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT,
    "clientName" TEXT NOT NULL,
    "clientEmail" TEXT,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "period" TEXT,
    "dueDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "notes" TEXT,
    "requestedById" TEXT NOT NULL,
    "lastRemindedAt" TIMESTAMP(3),
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClientDocumentRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientDocumentRequest_workspaceId_status_idx" ON "ClientDocumentRequest"("workspaceId", "status");
CREATE INDEX "ClientDocumentRequest_workspaceId_dueDate_idx" ON "ClientDocumentRequest"("workspaceId", "dueDate");

ALTER TABLE "ClientDocumentRequest" ADD CONSTRAINT "ClientDocumentRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientDocumentRequest" ADD CONSTRAINT "ClientDocumentRequest_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE SET NULL ON UPDATE CASCADE;
