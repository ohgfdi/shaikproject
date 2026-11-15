-- Durable job queue (Band 2.4): resumable background jobs with retries/backoff.
-- Adapted from SQLite version for PostgreSQL (DATETIME → TIMESTAMP(3)).
--
-- The postgres baseline (20260924000000_postgres_baseline) was generated from
-- the live database and already contains JobQueue, so this migration must be
-- idempotent: on a fresh deploy it is a no-op after the baseline, while the
-- migration name still records the job-queue feature in history.

CREATE TABLE IF NOT EXISTS "JobQueue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "finishedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobQueue_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "JobQueue_status_runAt_idx" ON "JobQueue"("status", "runAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "JobQueue_workspaceId_status_idx" ON "JobQueue"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "JobQueue_idempotencyKey_key" ON "JobQueue"("idempotencyKey");
