-- Durable outbound-mail queue: a notification survives a crash or SMTP outage
-- and is retried with backoff instead of being lost.
CREATE TABLE "MailOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "MailOutbox_status_nextAttemptAt_idx" ON "MailOutbox"("status", "nextAttemptAt");
CREATE INDEX "MailOutbox_organizationId_createdAt_idx" ON "MailOutbox"("organizationId", "createdAt");
