-- Client portal: one hashed, expiring link per client engagement (read-only
-- issued deliverables + document uploads). Only the token hash is stored.
CREATE TABLE "ClientPortalToken" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "label" TEXT,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientPortalToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientPortalToken_tokenHash_key" ON "ClientPortalToken"("tokenHash");
CREATE INDEX "ClientPortalToken_organizationId_engagementId_idx" ON "ClientPortalToken"("organizationId", "engagementId");
CREATE INDEX "ClientPortalToken_engagementId_revokedAt_idx" ON "ClientPortalToken"("engagementId", "revokedAt");

ALTER TABLE "ClientPortalToken" ADD CONSTRAINT "ClientPortalToken_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Documents uploaded by the client through a portal link.
CREATE TABLE "ClientPortalUpload" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "tokenId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "note" TEXT,
    "category" TEXT NOT NULL DEFAULT 'client-upload',
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientPortalUpload_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientPortalUpload_engagementId_uploadedAt_idx" ON "ClientPortalUpload"("engagementId", "uploadedAt");
CREATE INDEX "ClientPortalUpload_organizationId_idx" ON "ClientPortalUpload"("organizationId");

ALTER TABLE "ClientPortalUpload" ADD CONSTRAINT "ClientPortalUpload_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientPortalUpload" ADD CONSTRAINT "ClientPortalUpload_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "ClientPortalToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;
