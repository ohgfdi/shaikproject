-- Platform feature tables (multi-tenancy, feature flags, audit, mobile,
-- marketplace, webhooks). The models have shipped in prisma/schema.prisma
-- since the enterprise phases but no migration ever created their tables, so a
-- freshly migrated database died with P2021 ("no such table") the moment one
-- of those modules was used. The schema-drift gate now holds both shipped
-- migration sets to every declared model.
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'active',
    "maxDashboards" INTEGER NOT NULL DEFAULT 3,
    "maxStorageGB" INTEGER NOT NULL DEFAULT 1,
    "maxApiCallsPerMinute" INTEGER NOT NULL DEFAULT 60,
    "features" JSON NOT NULL DEFAULT '[]',
    "primaryColor" TEXT NOT NULL DEFAULT '#0052cc',
    "secondaryColor" TEXT NOT NULL DEFAULT '#e0e7ff',
    "logoUrl" TEXT,
    "faviconUrl" TEXT,
    "customDomain" TEXT,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "customJs" TEXT,
    "customCss" TEXT,
    "trialEndsAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE UNIQUE INDEX "Tenant_customDomain_key" ON "Tenant"("customDomain");

CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rollout" INTEGER NOT NULL DEFAULT 0,
    "userId" TEXT,
    "workspaceId" TEXT,
    "organizationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "FeatureFlag"("key");

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT,
    "workspaceId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "details" JSON,
    "status" TEXT NOT NULL DEFAULT 'success',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "events" JSON NOT NULL DEFAULT '[]',
    "dashboardId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "label" TEXT,
    "secret" TEXT,
    "lastDelivery" JSON,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "WebhookSubscription_idempotencyKey_key" ON "WebhookSubscription"("idempotencyKey");
CREATE INDEX "WebhookSubscription_dashboardId_idx" ON "WebhookSubscription"("dashboardId");

CREATE TABLE "Chart" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "Chart_tenantId_idx" ON "Chart"("tenantId");

CREATE TABLE "Kpi" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT,
    "color" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "Kpi_tenantId_idx" ON "Kpi"("tenantId");

CREATE TABLE "ErrorTracking" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ErrorTracking_tenantId_idx" ON "ErrorTracking"("tenantId");
CREATE INDEX "ErrorTracking_fingerprint_idx" ON "ErrorTracking"("fingerprint");

CREATE TABLE "ChartData" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "value" REAL
);

CREATE INDEX "ChartData_tenantId_date_idx" ON "ChartData"("tenantId", "date");

CREATE TABLE "Plugin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "priceAmount" REAL,
    "rating" REAL NOT NULL DEFAULT 0,
    "reviews" INTEGER NOT NULL DEFAULT 0,
    "installCount" INTEGER NOT NULL DEFAULT 0,
    "previewImage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "MarketplacePlugin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "priceAmount" REAL,
    "rating" REAL NOT NULL DEFAULT 0,
    "reviews" INTEGER NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "isInstalled" BOOLEAN NOT NULL DEFAULT false,
    "installCount" INTEGER NOT NULL DEFAULT 0,
    "supportedPlatforms" JSON NOT NULL DEFAULT '[]',
    "previewUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "MarketplacePlugin_category_idx" ON "MarketplacePlugin"("category");
