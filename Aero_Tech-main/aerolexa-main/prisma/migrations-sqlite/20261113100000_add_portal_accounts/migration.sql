-- Named client people for the portal, and the one-time magic-link tokens they
-- sign in with. The link token proves possession; the account proves identity.
CREATE TABLE "ClientPortalAccount" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "engagementId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "createdById" TEXT NOT NULL,
  "revokedAt" DATETIME,
  "lastLoginAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ClientPortalAccount_engagementId_fkey"
    FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ClientPortalLoginToken" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "usedAt" DATETIME,
  "ipHash" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientPortalLoginToken_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "ClientPortalAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ClientPortalAccount_engagementId_email_key"
  ON "ClientPortalAccount"("engagementId", "email");
CREATE INDEX "ClientPortalAccount_organizationId_idx"
  ON "ClientPortalAccount"("organizationId");
CREATE UNIQUE INDEX "ClientPortalLoginToken_tokenHash_key"
  ON "ClientPortalLoginToken"("tokenHash");
CREATE INDEX "ClientPortalLoginToken_accountId_expiresAt_idx"
  ON "ClientPortalLoginToken"("accountId", "expiresAt");
