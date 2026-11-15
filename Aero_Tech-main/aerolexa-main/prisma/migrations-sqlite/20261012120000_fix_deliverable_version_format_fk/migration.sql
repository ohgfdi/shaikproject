-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EngagementDeliverableVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "formatCode" TEXT NOT NULL,
    "templateId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "variant" TEXT NOT NULL DEFAULT 'CLIENT',
    "issuedAtLabel" TEXT,
    "filepath" TEXT,
    "bodyHash" TEXT,
    "preparedById" TEXT,
    "preparedAt" DATETIME,
    "reviewedById" TEXT,
    "reviewedAt" DATETIME,
    "reviewNote" TEXT,
    "signedOffById" TEXT,
    "signedOffAt" DATETIME,
    "signOffRole" TEXT,
    "issuedById" TEXT,
    "issuedAt" DATETIME,
    "issuedFor" TEXT,
    "remarks" TEXT,
    "udin" TEXT,
    "udinIssuedAt" DATETIME,
    "udinVerifiedById" TEXT,
    "udinVerifiedAt" DATETIME,
    "udinVerifyCount" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EngagementDeliverableVersion_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EngagementDeliverableVersion_engagementId_formatCode_fkey" FOREIGN KEY ("engagementId", "formatCode") REFERENCES "EngagementReportFormat" ("engagementId", "code") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EngagementDeliverableVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EngagementReportTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_EngagementDeliverableVersion" ("bodyHash", "content", "createdAt", "engagementId", "filepath", "formatCode", "id", "issuedAt", "issuedAtLabel", "issuedById", "issuedFor", "organizationId", "preparedAt", "preparedById", "remarks", "reviewNote", "reviewedAt", "reviewedById", "revision", "signOffRole", "signedOffAt", "signedOffById", "status", "templateId", "udin", "udinIssuedAt", "udinVerifiedAt", "udinVerifiedById", "udinVerifyCount", "updatedAt", "variant") SELECT "bodyHash", "content", "createdAt", "engagementId", "filepath", "formatCode", "id", "issuedAt", "issuedAtLabel", "issuedById", "issuedFor", "organizationId", "preparedAt", "preparedById", "remarks", "reviewNote", "reviewedAt", "reviewedById", "revision", "signOffRole", "signedOffAt", "signedOffById", "status", "templateId", "udin", "udinIssuedAt", "udinVerifiedAt", "udinVerifiedById", "udinVerifyCount", "updatedAt", "variant" FROM "EngagementDeliverableVersion";
DROP TABLE "EngagementDeliverableVersion";
ALTER TABLE "new_EngagementDeliverableVersion" RENAME TO "EngagementDeliverableVersion";
CREATE INDEX "EngagementDeliverableVersion_engagementId_formatCode_revision_idx" ON "EngagementDeliverableVersion"("engagementId", "formatCode", "revision");
CREATE INDEX "EngagementDeliverableVersion_organizationId_engagementId_formatCode_status_idx" ON "EngagementDeliverableVersion"("organizationId", "engagementId", "formatCode", "status");
CREATE INDEX "EngagementDeliverableVersion_engagementId_variant_status_idx" ON "EngagementDeliverableVersion"("engagementId", "variant", "status");
CREATE INDEX "EngagementDeliverableVersion_udin_idx" ON "EngagementDeliverableVersion"("udin");
CREATE UNIQUE INDEX "EngagementDeliverableVersion_engagementId_formatCode_revision_variant_key" ON "EngagementDeliverableVersion"("engagementId", "formatCode", "revision", "variant");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;