-- Cross-replica relay: collab Yjs updates + distributed rate-limit sync
-- (multi-replica safety without an external broker).

CREATE TABLE "CollaborativeUpdate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "notebookId" TEXT NOT NULL,
    "replicaId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "CollaborativeUpdate_notebookId_id_idx" ON "CollaborativeUpdate"("notebookId", "id");
