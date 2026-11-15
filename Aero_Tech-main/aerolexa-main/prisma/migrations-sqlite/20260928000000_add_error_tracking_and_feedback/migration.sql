-- Phase 5.2: self-hosted error tracking + customer feedback / feature requests.
--
-- ErrorReport is deliberately NOT foreign-keyed to Workspace: it is operational
-- data about the deployment, and it must survive a workspace deletion without
-- losing the operator's history. It still stores workspaceId so a tenant's
-- triage view only ever shows its own rows.
--
-- Feedback IS workspace-scoped with ON DELETE CASCADE: it belongs to the
-- customer, and deleting the workspace must delete their feedback too.

CREATE TABLE "ErrorReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fingerprint" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT NOT NULL DEFAULT '',
    "path" TEXT NOT NULL DEFAULT '',
    "requestId" TEXT,
    "userId" TEXT,
    "workspaceId" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "count" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" DATETIME
);

-- The grouping key: a repeat occurrence updates `count` instead of inserting.
CREATE UNIQUE INDEX "ErrorReport_fingerprint_key" ON "ErrorReport"("fingerprint");
CREATE INDEX "ErrorReport_lastSeenAt_idx" ON "ErrorReport"("lastSeenAt");
-- Partial-style composite for the default triage query (unresolved, newest).
CREATE INDEX "ErrorReport_resolvedAt_lastSeenAt_idx" ON "ErrorReport"("resolvedAt", "lastSeenAt");

CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'feedback',
    "message" TEXT NOT NULL,
    "context" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "resolvedAt" DATETIME,
    CONSTRAINT "Feedback_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "Feedback_workspaceId_status_createdAt_idx" ON "Feedback"("workspaceId", "status", "createdAt");
CREATE INDEX "Feedback_kind_status_idx" ON "Feedback"("kind", "status");