-- ===========================================================================
-- Aerolexa — PostgreSQL Row-Level Security (org-aware defense in depth)
--
-- Two tenancy keys are set by the application per transaction (see
-- lib/server/tenancy.ts → withTenantContext):
--
--   app.current_user          → the signed-in user's id
--   app.current_workspace     → the user's workspace id (legacy isolation)
--   app.current_organization  → the user's active organization id (firm)
--
-- Policies:
--   * Workspace-scoped tables enforce `workspaceId` isolation (legacy).
--   * Organization tables (Organization/OrganizationMember/Engagement) are
--     keyed off the org GUC, so firm data is only visible inside the firm.
--   * Project additionally allows rows whose `organizationId` equals the
--     active organization — org members can read engagement artifacts even
--     when the row physically lives in another member's workspace.
--
-- STATUS / PRECONDITIONS (read before enabling!):
--   This layer is OPT-IN and is NOT active by default. For the policies below
--   to actually protect anything, ALL THREE must hold:
--
--     1. FORCE ROW LEVEL SECURITY is applied (it is, below). Without FORCE,
--        PostgreSQL exempts the table OWNER from its own policies — so if the
--        app connects as the migration/owner role, RLS is silently a no-op.
--     2. The application connects as a NON-owner role that is neither SUPERUSER
--        nor has BYPASSRLS. Create a dedicated app role and grant it DML.
--     3. Every tenant-scoped query runs inside withTenantContext(), which sets
--        the app.current_* GUCs for the transaction. This wiring is NOT in
--        place yet (see ROADMAP 2.5 and RLS_QUERY_LAYER_WIRED in
--        lib/server/tenancy.ts): the app still queries `prisma` directly, so
--        setting RLS_ENABLED=true today would hide EVERY row (the policies
--        compare against an unset GUC). Do not enable it until (3) lands.
--
--   Until then the real isolation boundary is the application layer
--   (lib/auth/guard.ts, lib/server/members.ts). The health endpoint reports
--   the RLS status so a deployment can see whether enforcement is genuine.
--   Measure the wiring gap with `npm run tenancy:audit`; it exits 1 when RLS is
--   requested while tenant files still bypass withTenantContext().
--
-- Setup (PostgreSQL profile only — SQLite cannot run this):
--   1. npm run switch:postgres && npm run db:deploy
--   2. psql "$DATABASE_URL" -f prisma/rls.sql
--   3. (Only once the query layer is wired) set RLS_ENABLED=true.
-- ===========================================================================

ALTER TABLE "Organization"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Engagement"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Project"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Dataset"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Analysis"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Insight"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Dashboard"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Report"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Presentation"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Activity"           ENABLE ROW LEVEL SECURITY;

-- FORCE: apply the policies to the table owner too. Without this, a deployment
-- whose app role owns these tables bypasses every policy below.
ALTER TABLE "Organization"       FORCE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationMember" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Engagement"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "Project"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "Dataset"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "Analysis"           FORCE ROW LEVEL SECURITY;
ALTER TABLE "Insight"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "Dashboard"          FORCE ROW LEVEL SECURITY;
ALTER TABLE "Report"             FORCE ROW LEVEL SECURITY;
ALTER TABLE "Presentation"       FORCE ROW LEVEL SECURITY;
ALTER TABLE "Activity"           FORCE ROW LEVEL SECURITY;

-- --- Organization (firm) ---
-- Bootstrap: getAuth() runs with only app.current_user set (the active org is
-- discovered FROM these rows). A user can therefore see their own membership
-- rows and the organizations those memberships point at. Every other org row
-- still requires app.current_organization.
DROP POLICY IF EXISTS organization_self ON "Organization";
CREATE POLICY organization_self ON "Organization"
  USING ("id" = current_setting('app.current_organization', true)::text
         OR "ownerId" = current_setting('app.current_user', true)::text);

-- Read-only bootstrap policy. Deliberately SELECT-only: a user-scoped context
-- may discover its firms, but writes still require app.current_organization.
DROP POLICY IF EXISTS organization_bootstrap_read ON "Organization";
CREATE POLICY organization_bootstrap_read ON "Organization" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "OrganizationMember" m
     WHERE m."organizationId" = "Organization"."id"
       AND m."userId" = current_setting('app.current_user', true)::text
  ));

DROP POLICY IF EXISTS organization_member_self ON "OrganizationMember";
CREATE POLICY organization_member_self ON "OrganizationMember"
  USING ("organizationId" = current_setting('app.current_organization', true)::text);

DROP POLICY IF EXISTS organization_member_bootstrap_read ON "OrganizationMember";
CREATE POLICY organization_member_bootstrap_read ON "OrganizationMember" FOR SELECT
  USING ("userId" = current_setting('app.current_user', true)::text);

DROP POLICY IF EXISTS engagement_org_scope ON "Engagement";
CREATE POLICY engagement_org_scope ON "Engagement"
  USING ("organizationId" = current_setting('app.current_organization', true)::text);

DROP POLICY IF EXISTS workspace_isolation_projects ON "Project";
CREATE POLICY workspace_isolation_projects ON "Project"
  USING ("workspaceId" = current_setting('app.current_workspace', true)
         OR "organizationId" = current_setting('app.current_organization', true)::text);

DROP POLICY IF EXISTS workspace_isolation_datasets ON "Dataset";
CREATE POLICY workspace_isolation_datasets ON "Dataset"
  USING ("workspaceId" = current_setting('app.current_workspace', true));

DROP POLICY IF EXISTS workspace_isolation_analyses ON "Analysis";
CREATE POLICY workspace_isolation_analyses ON "Analysis"
  USING ("workspaceId" = current_setting('app.current_workspace', true));

DROP POLICY IF EXISTS workspace_isolation_insights ON "Insight";
CREATE POLICY workspace_isolation_insights ON "Insight"
  USING ("workspaceId" = current_setting('app.current_workspace', true));

DROP POLICY IF EXISTS workspace_isolation_dashboards ON "Dashboard";
CREATE POLICY workspace_isolation_dashboards ON "Dashboard"
  USING ("workspaceId" = current_setting('app.current_workspace', true));

DROP POLICY IF EXISTS workspace_isolation_reports ON "Report";
CREATE POLICY workspace_isolation_reports ON "Report"
  USING ("workspaceId" = current_setting('app.current_workspace', true));

DROP POLICY IF EXISTS workspace_isolation_presentations ON "Presentation";
CREATE POLICY workspace_isolation_presentations ON "Presentation"
  USING ("workspaceId" = current_setting('app.current_workspace', true));

DROP POLICY IF EXISTS workspace_isolation_activity ON "Activity";
CREATE POLICY workspace_isolation_activity ON "Activity"
  USING ("workspaceId" = current_setting('app.current_workspace', true));

-- --- Compliance / portal / operations tables (prepared, dormant until RLS is enabled) ---
-- These were added after the first RLS pass. They are enabled and forced here so
-- the policy set covers the filing and client-portal evidence, not just the
-- legacy analytics tables. Enforcement still requires the query layer to be
-- wrapped (npm run tenancy:audit reports the gap).
ALTER TABLE "ComplianceFilingRun"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ComplianceFilingEvent"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientPortalToken"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientPortalAccount"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientPortalLoginToken"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientPortalUpload"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientComplianceProfile"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientComplianceStatus"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FilingRollout"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MailOutbox"               ENABLE ROW LEVEL SECURITY;

ALTER TABLE "ComplianceFilingRun"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "ComplianceFilingEvent"    FORCE ROW LEVEL SECURITY;
ALTER TABLE "ClientPortalToken"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "ClientPortalAccount"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "ClientPortalLoginToken"   FORCE ROW LEVEL SECURITY;
ALTER TABLE "ClientPortalUpload"       FORCE ROW LEVEL SECURITY;
ALTER TABLE "ClientComplianceProfile"  FORCE ROW LEVEL SECURITY;
ALTER TABLE "ClientComplianceStatus"   FORCE ROW LEVEL SECURITY;
ALTER TABLE "FilingRollout"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "MailOutbox"               FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compliance_run_org_scope ON "ComplianceFilingRun";
CREATE POLICY compliance_run_org_scope ON "ComplianceFilingRun"
  USING ("organizationId" = current_setting('app.current_organization', true)::text);

DROP POLICY IF EXISTS compliance_event_org_scope ON "ComplianceFilingEvent";
CREATE POLICY compliance_event_org_scope ON "ComplianceFilingEvent"
  USING ("organizationId" = current_setting('app.current_organization', true)::text);

DROP POLICY IF EXISTS portal_token_org_scope ON "ClientPortalToken";
CREATE POLICY portal_token_org_scope ON "ClientPortalToken"
  USING ("organizationId" = current_setting('app.current_organization', true)::text);

DROP POLICY IF EXISTS portal_account_org_scope ON "ClientPortalAccount";
CREATE POLICY portal_account_org_scope ON "ClientPortalAccount"
  USING ("organizationId" = current_setting('app.current_organization', true)::text);

-- The login token has no org column; scope it through its account.
DROP POLICY IF EXISTS portal_login_token_org_scope ON "ClientPortalLoginToken";
CREATE POLICY portal_login_token_org_scope ON "ClientPortalLoginToken"
  USING (EXISTS (
    SELECT 1 FROM "ClientPortalAccount" a
     WHERE a."id" = "ClientPortalLoginToken"."accountId"
       AND a."organizationId" = current_setting('app.current_organization', true)::text
  ));

DROP POLICY IF EXISTS portal_upload_org_scope ON "ClientPortalUpload";
CREATE POLICY portal_upload_org_scope ON "ClientPortalUpload"
  USING ("organizationId" = current_setting('app.current_organization', true)::text);

DROP POLICY IF EXISTS compliance_profile_org_scope ON "ClientComplianceProfile";
CREATE POLICY compliance_profile_org_scope ON "ClientComplianceProfile"
  USING ("organizationId" = current_setting('app.current_organization', true)::text);

DROP POLICY IF EXISTS compliance_status_org_scope ON "ClientComplianceStatus";
CREATE POLICY compliance_status_org_scope ON "ClientComplianceStatus"
  USING ("organizationId" = current_setting('app.current_organization', true)::text);

DROP POLICY IF EXISTS filing_rollout_org_scope ON "FilingRollout";
CREATE POLICY filing_rollout_org_scope ON "FilingRollout"
  USING ("organizationId" = current_setting('app.current_organization', true)::text);

-- Outbox rows with no organization are system notifications; they are not
-- visible to a tenant request. This is intentional, not a missing fallback.
DROP POLICY IF EXISTS mail_outbox_org_scope ON "MailOutbox";
CREATE POLICY mail_outbox_org_scope ON "MailOutbox"
  USING ("organizationId" = current_setting('app.current_organization', true)::text);

COMMENT ON POLICY organization_self ON "Organization" IS
  'Firm rows are only visible to requests with the org GUC set or the owner.';
COMMENT ON POLICY workspace_isolation_projects ON "Project" IS
  'Projects are visible in the legacy workspace OR to the active organization.';