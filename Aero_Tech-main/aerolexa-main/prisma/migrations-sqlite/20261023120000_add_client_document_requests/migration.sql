-- Document requests: the firm asking a client for a missing document, with a
-- deadline and a reminder trail. Everything is workspace-scoped.
CREATE TABLE "ClientDocumentRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "lastRemindedAt" DATETIME,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClientDocumentRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientDocumentRequest_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ClientDocumentRequest_workspaceId_status_idx" ON "ClientDocumentRequest"("workspaceId", "status");
CREATE INDEX "ClientDocumentRequest_workspaceId_dueDate_idx" ON "ClientDocumentRequest"("workspaceId", "dueDate");
