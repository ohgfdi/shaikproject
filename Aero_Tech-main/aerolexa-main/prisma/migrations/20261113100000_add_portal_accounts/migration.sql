-- Named client people for the portal, and the one-time magic-link tokens they
-- sign in with. The link token proves possession; the account proves identity.
CREATE TABLE IF NOT EXISTS "ClientPortalAccount" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "engagementId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "createdById" TEXT NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClientPortalAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClientPortalLoginToken" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "ipHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientPortalLoginToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ClientPortalAccount_engagementId_email_key"
  ON "ClientPortalAccount"("engagementId", "email");
CREATE INDEX IF NOT EXISTS "ClientPortalAccount_organizationId_idx"
  ON "ClientPortalAccount"("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "ClientPortalLoginToken_tokenHash_key"
  ON "ClientPortalLoginToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "ClientPortalLoginToken_accountId_expiresAt_idx"
  ON "ClientPortalLoginToken"("accountId", "expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ClientPortalAccount_engagementId_fkey'
  ) THEN
    ALTER TABLE "ClientPortalAccount"
      ADD CONSTRAINT "ClientPortalAccount_engagementId_fkey"
      FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ClientPortalLoginToken_accountId_fkey'
  ) THEN
    ALTER TABLE "ClientPortalLoginToken"
      ADD CONSTRAINT "ClientPortalLoginToken_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "ClientPortalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
