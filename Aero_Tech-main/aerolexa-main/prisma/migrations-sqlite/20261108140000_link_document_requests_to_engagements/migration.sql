-- Document requests can now belong to an engagement (client portal), not only a
-- legacy workspace. SQLite cannot ALTER COLUMN ... DROP NOT NULL, so rebuild the
-- table with the nullable workspace and the new engagement/upload links.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ClientDocumentRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "engagementId" TEXT,
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
    "fulfilledByUploadId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClientDocumentRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientDocumentRequest_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientDocumentRequest_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_ClientDocumentRequest" (
    "id", "workspaceId", "engagementId", "bookId", "clientName", "clientEmail", "title", "category",
    "period", "dueDate", "status", "notes", "requestedById", "lastRemindedAt", "reminderCount",
    "receivedAt", "fulfilledByUploadId", "createdAt", "updatedAt"
)
SELECT
    "id", "workspaceId", NULL, "bookId", "clientName", "clientEmail", "title", "category",
    "period", "dueDate", "status", "notes", "requestedById", "lastRemindedAt", "reminderCount",
    "receivedAt", NULL, "createdAt", "updatedAt"
FROM "ClientDocumentRequest";

DROP TABLE "ClientDocumentRequest";
ALTER TABLE "new_ClientDocumentRequest" RENAME TO "ClientDocumentRequest";

CREATE INDEX "ClientDocumentRequest_workspaceId_status_idx" ON "ClientDocumentRequest"("workspaceId", "status");
CREATE INDEX "ClientDocumentRequest_workspaceId_dueDate_idx" ON "ClientDocumentRequest"("workspaceId", "dueDate");
CREATE INDEX "ClientDocumentRequest_engagementId_status_idx" ON "ClientDocumentRequest"("engagementId", "status");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
