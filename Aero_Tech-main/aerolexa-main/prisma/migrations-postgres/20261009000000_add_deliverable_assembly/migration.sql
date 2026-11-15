-- Deliverable assembly — PostgreSQL dialect.
-- Mirrors prisma/migrations-sqlite/20261009000000_add_deliverable_assembly.
-- Additive only: existing rows keep their defaults.

-- ---------------------------------------------------------------------------
-- Per-engagement report formats
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementReportFormat" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "defaultVariant" TEXT NOT NULL DEFAULT 'CLIENT',
    "clauses" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngagementReportFormat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EngagementReportFormat_engagementId_code_key" ON "EngagementReportFormat"("engagementId", "code");
CREATE INDEX "EngagementReportFormat_organizationId_engagementId_idx" ON "EngagementReportFormat"("organizationId", "engagementId");
CREATE INDEX "EngagementReportFormat_engagementId_status_idx" ON "EngagementReportFormat"("engagementId", "status");
ALTER TABLE "EngagementReportFormat" ADD CONSTRAINT "EngagementReportFormat_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Engagement report templates (derive from a firm-wide master via masterRef)
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementReportTemplate" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngagementReportTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EngagementReportTemplate_engagementId_formatCode_label_key" ON "EngagementReportTemplate"("engagementId", "formatCode", "label");
CREATE INDEX "EngagementReportTemplate_organizationId_engagementId_formatCode_idx" ON "EngagementReportTemplate"("organizationId", "engagementId", "formatCode");
CREATE INDEX "EngagementReportTemplate_engagementId_status_idx" ON "EngagementReportTemplate"("engagementId", "status");
ALTER TABLE "EngagementReportTemplate" ADD CONSTRAINT "EngagementReportTemplate_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Versioned deliverables (a revision is immutable; it is signed independently)
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementDeliverableVersion" (
    "id" TEXT NOT NULL,
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
    "preparedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "signedOffById" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "signOffRole" TEXT,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3),
    "issuedFor" TEXT,
    "remarks" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngagementDeliverableVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EngagementDeliverableVersion_engagementId_formatCode_revision_variant_key" ON "EngagementDeliverableVersion"("engagementId", "formatCode", "revision", "variant");
CREATE INDEX "EngagementDeliverableVersion_engagementId_formatCode_revision_idx" ON "EngagementDeliverableVersion"("engagementId", "formatCode", "revision");
CREATE INDEX "EngagementDeliverableVersion_organizationId_engagementId_formatCode_status_idx" ON "EngagementDeliverableVersion"("organizationId", "engagementId", "formatCode", "status");
CREATE INDEX "EngagementDeliverableVersion_engagementId_variant_status_idx" ON "EngagementDeliverableVersion"("engagementId", "variant", "status");
ALTER TABLE "EngagementDeliverableVersion" ADD CONSTRAINT "EngagementDeliverableVersion_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementDeliverableVersion" ADD CONSTRAINT "EngagementDeliverableVersion_formatCode_fkey" FOREIGN KEY ("formatCode") REFERENCES "EngagementReportFormat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementDeliverableVersion" ADD CONSTRAINT "EngagementDeliverableVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EngagementReportTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Append-only sign-off steps
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementDeliverableSignOff" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "performedById" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "EngagementDeliverableSignOff_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EngagementDeliverableSignOff_versionId_step_idx" ON "EngagementDeliverableSignOff"("versionId", "step");
CREATE INDEX "EngagementDeliverableSignOff_engagementId_performedById_idx" ON "EngagementDeliverableSignOff"("engagementId", "performedById");
ALTER TABLE "EngagementDeliverableSignOff" ADD CONSTRAINT "EngagementDeliverableSignOff_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementDeliverableSignOff" ADD CONSTRAINT "EngagementDeliverableSignOff_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EngagementDeliverableVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Immutable deliverable parts (working-paper-to-report traceability)
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementDeliverablePart" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementDeliverablePart_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EngagementDeliverablePart_versionId_kind_order_idx" ON "EngagementDeliverablePart"("versionId", "kind", "order");
CREATE INDEX "EngagementDeliverablePart_engagementId_source_idx" ON "EngagementDeliverablePart"("engagementId", "source");
ALTER TABLE "EngagementDeliverablePart" ADD CONSTRAINT "EngagementDeliverablePart_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementDeliverablePart" ADD CONSTRAINT "EngagementDeliverablePart_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EngagementDeliverableVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Redaction rules (part of the signed record)
-- ---------------------------------------------------------------------------

CREATE TABLE "EngagementDeliverableRedaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "policy" TEXT NOT NULL DEFAULT 'MASKED',
    "appliesTo" TEXT NOT NULL,
    "note" TEXT,
    "effectiveForVariant" TEXT NOT NULL DEFAULT 'CLIENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "engagementReportFormatId" TEXT,

    CONSTRAINT "EngagementDeliverableRedaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EngagementDeliverableRedaction_engagementId_versionId_appliesTo_idx" ON "EngagementDeliverableRedaction"("engagementId", "versionId", "appliesTo");
ALTER TABLE "EngagementDeliverableRedaction" ADD CONSTRAINT "EngagementDeliverableRedaction_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementDeliverableRedaction" ADD CONSTRAINT "EngagementDeliverableRedaction_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EngagementDeliverableVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementDeliverableRedaction" ADD CONSTRAINT "EngagementDeliverableRedaction_engagementReportFormatId_fkey" FOREIGN KEY ("engagementReportFormatId") REFERENCES "EngagementReportFormat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Firm-wide master templates
-- ---------------------------------------------------------------------------

CREATE TABLE "OrganizationReportTemplate" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationReportTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationReportTemplate_organizationId_formatCode_label_key" ON "OrganizationReportTemplate"("organizationId", "formatCode", "label");
CREATE INDEX "OrganizationReportTemplate_organizationId_formatCode_idx" ON "OrganizationReportTemplate"("organizationId", "formatCode");
CREATE INDEX "OrganizationReportTemplate_organizationId_status_idx" ON "OrganizationReportTemplate"("organizationId", "status");
ALTER TABLE "OrganizationReportTemplate" ADD CONSTRAINT "OrganizationReportTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Implicit M:N — OrganizationReportTemplate.engagements / Engagement.masterReportTemplates
-- ---------------------------------------------------------------------------

CREATE TABLE "_EngagementToOrganizationReportTemplate" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

CREATE UNIQUE INDEX "_EngagementToOrganizationReportTemplate_AB_unique" ON "_EngagementToOrganizationReportTemplate"("A", "B");
CREATE INDEX "_EngagementToOrganizationReportTemplate_B_index" ON "_EngagementToOrganizationReportTemplate"("B");
ALTER TABLE "_EngagementToOrganizationReportTemplate" ADD CONSTRAINT "_EngagementToOrganizationReportTemplate_A_fkey" FOREIGN KEY ("A") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_EngagementToOrganizationReportTemplate" ADD CONSTRAINT "_EngagementToOrganizationReportTemplate_B_fkey" FOREIGN KEY ("B") REFERENCES "OrganizationReportTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
