-- Deliverable assembly — the firm-grade layer that turns computed results into
-- engagement-specific, sign-off-aware deliverables (financial statements, tax
-- computations, 44AB/44ADA certificates, notes, schedules, management letters).
--
-- Adds:
--   * per-engagement report formats (what a client engagement can issue),
--   * reusable engagement templates and firm-wide master templates,
--   * versioned signed deliverables with CLIENT and REVIEWER variants,
--   * immutable deliverable parts (working-paper-to-report traceability),
--   * append-only sign-off steps, and
--   * identifier redaction rules that are part of the signed record.
--
-- Additive only: new tables are engagement/org scoped with ON DELETE CASCADE
-- and carry defaults, so an existing deployment's data is untouched.

-- ---------------------------------------------------------------------------
-- Per-engagement report formats
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementReportFormat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "defaultVariant" TEXT NOT NULL DEFAULT 'CLIENT',
    "clauses" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EngagementReportFormat_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EngagementReportFormat_engagementId_code_key" ON "EngagementReportFormat"("engagementId", "code");
CREATE INDEX "EngagementReportFormat_organizationId_engagementId_idx" ON "EngagementReportFormat"("organizationId", "engagementId");
CREATE INDEX "EngagementReportFormat_engagementId_status_idx" ON "EngagementReportFormat"("engagementId", "status");

-- ---------------------------------------------------------------------------
-- Engagement report templates (derive from a firm-wide master via masterRef)
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementReportTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "formatCode" TEXT NOT NULL,
    "masterRef" TEXT,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "firmName" TEXT NOT NULL DEFAULT '^^FIRM_NAME^^',
    "firmAddress" TEXT NOT NULL DEFAULT '^^FIRM_ADDRESS^^',
    "signatoryName" TEXT NOT NULL DEFAULT '^^SIGNATORY_NAME^^',
    "signatoryDesignation" TEXT NOT NULL DEFAULT '^^SIGNATORY_DESIGNATION^^',
    "dateLabel" TEXT NOT NULL DEFAULT '^^DATE_LABEL^^',
    "body" TEXT NOT NULL,
    "notes" TEXT,
    "effectiveFrom" TEXT,
    "effectiveTo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EngagementReportTemplate_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EngagementReportTemplate_engagementId_formatCode_label_key" ON "EngagementReportTemplate"("engagementId", "formatCode", "label");
CREATE INDEX "EngagementReportTemplate_organizationId_engagementId_formatCode_idx" ON "EngagementReportTemplate"("organizationId", "engagementId", "formatCode");
CREATE INDEX "EngagementReportTemplate_engagementId_status_idx" ON "EngagementReportTemplate"("engagementId", "status");

-- ---------------------------------------------------------------------------
-- Versioned deliverables (a revision is immutable; it is signed independently)
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementDeliverableVersion" (
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
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EngagementDeliverableVersion_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EngagementDeliverableVersion_formatCode_fkey" FOREIGN KEY ("formatCode") REFERENCES "EngagementReportFormat" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EngagementDeliverableVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EngagementReportTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EngagementDeliverableVersion_engagementId_formatCode_revision_variant_key" ON "EngagementDeliverableVersion"("engagementId", "formatCode", "revision", "variant");
CREATE INDEX "EngagementDeliverableVersion_engagementId_formatCode_revision_idx" ON "EngagementDeliverableVersion"("engagementId", "formatCode", "revision");
CREATE INDEX "EngagementDeliverableVersion_organizationId_engagementId_formatCode_status_idx" ON "EngagementDeliverableVersion"("organizationId", "engagementId", "formatCode", "status");
CREATE INDEX "EngagementDeliverableVersion_engagementId_variant_status_idx" ON "EngagementDeliverableVersion"("engagementId", "variant", "status");

-- ---------------------------------------------------------------------------
-- Append-only sign-off steps
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementDeliverableSignOff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "performedById" TEXT NOT NULL,
    "performedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    CONSTRAINT "EngagementDeliverableSignOff_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EngagementDeliverableSignOff_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EngagementDeliverableVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "EngagementDeliverableSignOff_versionId_step_idx" ON "EngagementDeliverableSignOff"("versionId", "step");
CREATE INDEX "EngagementDeliverableSignOff_engagementId_performedById_idx" ON "EngagementDeliverableSignOff"("engagementId", "performedById");

-- ---------------------------------------------------------------------------
-- Immutable deliverable parts (working-paper-to-report traceability)
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementDeliverablePart" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT,
    "heading" TEXT NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "attachments" TEXT NOT NULL DEFAULT '[]',
    "source" TEXT,
    "sourceRef" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EngagementDeliverablePart_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EngagementDeliverablePart_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EngagementDeliverableVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "EngagementDeliverablePart_versionId_kind_order_idx" ON "EngagementDeliverablePart"("versionId", "kind", "order");
CREATE INDEX "EngagementDeliverablePart_engagementId_source_idx" ON "EngagementDeliverablePart"("engagementId", "source");

-- ---------------------------------------------------------------------------
-- Redaction rules (part of the signed record)
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementDeliverableRedaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "policy" TEXT NOT NULL DEFAULT 'MASKED',
    "appliesTo" TEXT NOT NULL,
    "note" TEXT,
    "effectiveForVariant" TEXT NOT NULL DEFAULT 'CLIENT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "engagementReportFormatId" TEXT,
    CONSTRAINT "EngagementDeliverableRedaction_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EngagementDeliverableRedaction_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EngagementDeliverableVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EngagementDeliverableRedaction_engagementReportFormatId_fkey" FOREIGN KEY ("engagementReportFormatId") REFERENCES "EngagementReportFormat" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "EngagementDeliverableRedaction_engagementId_versionId_appliesTo_idx" ON "EngagementDeliverableRedaction"("engagementId", "versionId", "appliesTo");

-- ---------------------------------------------------------------------------
-- Firm-wide master templates
-- ---------------------------------------------------------------------------

CREATE TABLE "OrganizationReportTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "formatCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "firmName" TEXT NOT NULL DEFAULT '^^FIRM_NAME^^',
    "firmAddress" TEXT NOT NULL DEFAULT '^^FIRM_ADDRESS^^',
    "signatoryName" TEXT NOT NULL DEFAULT '^^SIGNATORY_NAME^^',
    "signatoryDesignation" TEXT NOT NULL DEFAULT '^^SIGNATORY_DESIGNATION^^',
    "dateLabel" TEXT NOT NULL DEFAULT '^^DATE_LABEL^^',
    "body" TEXT NOT NULL,
    "notes" TEXT,
    "effectiveFrom" TEXT,
    "effectiveTo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrganizationReportTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OrganizationReportTemplate_organizationId_formatCode_label_key" ON "OrganizationReportTemplate"("organizationId", "formatCode", "label");
CREATE INDEX "OrganizationReportTemplate_organizationId_formatCode_idx" ON "OrganizationReportTemplate"("organizationId", "formatCode");
CREATE INDEX "OrganizationReportTemplate_organizationId_status_idx" ON "OrganizationReportTemplate"("organizationId", "status");

-- ---------------------------------------------------------------------------
-- Implicit M:N — OrganizationReportTemplate.engagements / Engagement.masterReportTemplates
-- ---------------------------------------------------------------------------

CREATE TABLE "_EngagementToOrganizationReportTemplate" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_EngagementToOrganizationReportTemplate_A_fkey" FOREIGN KEY ("A") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_EngagementToOrganizationReportTemplate_B_fkey" FOREIGN KEY ("B") REFERENCES "OrganizationReportTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "_EngagementToOrganizationReportTemplate_AB_unique" ON "_EngagementToOrganizationReportTemplate"("A", "B");
CREATE INDEX "_EngagementToOrganizationReportTemplate_B_index" ON "_EngagementToOrganizationReportTemplate"("B");
