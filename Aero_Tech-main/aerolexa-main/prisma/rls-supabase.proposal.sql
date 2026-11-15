-- ============================================================================
-- Ledgerly / Supabase — ROW LEVEL SECURITY PROPOSAL
--
-- STATUS: PROPOSAL ONLY. NOT EXECUTED. Review before applying.
-- Target: PostgreSQL (Supabase). SQLite cannot run any of this.
--
-- WHY THIS FILE EXISTS
--   prisma/rls.sql already defines GUC-based policies keyed on
--   app.current_user / app.current_workspace / app.current_organization, and is
--   intentionally dormant (RLS_QUERY_LAYER_WIRED = false in
--   lib/server/rls-status.ts). Those policies assume Prisma sets the GUCs.
--
--   This file is the OTHER half: policies for requests that arrive through the
--   Supabase anon/publishable key, where the identity is Supabase Auth's
--   auth.uid() (a uuid) rather than an app User.id (a cuid text id). The two id
--   spaces do not overlap, so a link table plus security-definer helpers are
--   required. Without them, auth.uid() policies would deny every row.
--
--   APPLY ONE MODEL OR THE OTHER. Permissive policies OR together, so keeping
--   both sets active silently widens access instead of documenting it.
--
--   Model A (recommended if you keep the existing app auth): do NOT apply this
--   file. Supabase is managed Postgres; Prisma is the only DB client; tenancy
--   stays in lib/auth/guard.ts + lib/server/members.ts.
--
--   Model B (apply this file): Supabase Auth drives the browser. The browser
--   uses the anon key and is RLS-bound. Prisma keeps connecting with the
--   `postgres` role, which is a Superuser/BYPASSRLS role in Supabase and is
--   therefore NOT filtered — server code remains trusted and unchanged.
--   Consequence to accept knowingly: anything that can reach the database with
--   the server credential can read everything. That is the normal Supabase
--   split (browser = untrusted, server = trusted); it is not a new weakness.
--
-- PRECONDITIONS (all must hold before this file is useful)
--   1. Prisma migrations have been deployed to the Supabase database
--      (npm run switch:postgres && npx prisma migrate deploy) — every table
--      referenced below must exist.
--   2. The browser client uses NEXT_PUBLIC_SUPABASE_URL +
--      NEXT_PUBLIC_SUPABASE_ANON_KEY (already wired in lib/supabase/client.ts).
--   3. Users sign in through Supabase Auth so auth.uid() is populated, and a
--      SupabaseIdentity row links that uid to the app's User row.
--   4. Row Level Security is NOT enabled on any table until the identity rows
--      exist — enabling first would make every row invisible.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Identity link: Supabase Auth uuid  <->  app User.id (cuid text)
--
-- This table is the bridge between the two identity systems and is therefore
-- the most security-sensitive object here. It is written only by trusted
-- server code (service role / Prisma), never by the browser.
-- ---------------------------------------------------------------------------

create table if not exists "SupabaseIdentity" (
  "userId"      text        primary key references "User"("id") on delete cascade,
  "supabaseUid" uuid        not null unique,
  "email"       text,
  "createdAt"   timestamptz not null default now()
);

create index if not exists "SupabaseIdentity_supabaseUid_idx"
  on "SupabaseIdentity" ("supabaseUid");

alter table "SupabaseIdentity" enable row level security;
alter table "SupabaseIdentity" force  row level security;

-- A signed-in user may confirm their own link (needed for client bootstrapping)
-- but may not enumerate others.
drop policy if exists supabase_identity_self on "SupabaseIdentity";
create policy supabase_identity_self on "SupabaseIdentity"
  for select to authenticated
  using ("supabaseUid" = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. Helper functions
--
-- Every helper is SECURITY DEFINER so it can read membership tables that the
-- caller cannot read directly. search_path is pinned to defeat search_path
-- hijacking, and EXECUTE is revoked from anon/public so an unauthenticated
-- caller cannot probe tenant structure.
-- ---------------------------------------------------------------------------

create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated;

create or replace function app_private.current_user_id()
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select i."userId"
    from "SupabaseIdentity" i
   where i."supabaseUid" = auth.uid()
   limit 1
$$;

-- The legacy 1:1 workspace: User.workspaceId. NULL for org-only accounts.
create or replace function app_private.current_workspace_id()
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select u."workspaceId"
    from "User" u
   where u."id" = app_private.current_user_id()
$$;

-- Firm-wide role: OWNER | ADMIN | MEMBER | AUDITOR. NULL when not a member.
create or replace function app_private.org_role(org_id text)
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select m."role"
    from "OrganizationMember" m
   where m."organizationId" = org_id
     and m."userId" = app_private.current_user_id()
   limit 1
$$;

-- Read access to a project: same workspace (legacy), explicit ProjectMember,
-- or any role in the project's organization. Mirrors artifactRoleWithOrg() in
-- lib/server/members.ts — keep the two in step.
create or replace function app_private.can_read_project(p_id text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from "Project" p
     where p."id" = p_id
       and (
            p."workspaceId" = app_private.current_workspace_id()
         or exists (
              select 1 from "ProjectMember" pm
               where pm."projectId" = p."id"
                 and pm."userId" = app_private.current_user_id()
            )
         or (p."organizationId" is not null
             and app_private.org_role(p."organizationId") is not null)
       )
  )
$$;

-- Write access: workspace owner, ProjectMember OWNER/EDITOR, or org OWNER/ADMIN.
create or replace function app_private.can_write_project(p_id text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from "Project" p
     where p."id" = p_id
       and (
            p."workspaceId" = app_private.current_workspace_id()
         or exists (
              select 1 from "ProjectMember" pm
               where pm."projectId" = p."id"
                 and pm."userId" = app_private.current_user_id()
                 and pm."role" in ('OWNER', 'EDITOR')
            )
         or (p."organizationId" is not null
             and app_private.org_role(p."organizationId") in ('OWNER', 'ADMIN'))
       )
  )
$$;

revoke execute on function app_private.current_user_id()   from public, anon;
revoke execute on function app_private.current_workspace_id() from public, anon;
revoke execute on function app_private.org_role(text)      from public, anon;
revoke execute on function app_private.can_read_project(text)  from public, anon;
revoke execute on function app_private.can_write_project(text) from public, anon;

grant execute on function app_private.current_user_id()      to authenticated;
grant execute on function app_private.current_workspace_id() to authenticated;
grant execute on function app_private.org_role(text)         to authenticated;
grant execute on function app_private.can_read_project(text)  to authenticated;
grant execute on function app_private.can_write_project(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Enable + FORCE RLS on the tenant-scoped tables
--
-- FORCE matters only for the table owner. Under Model B the app's own role
-- bypasses RLS (Superuser/BYPASSRLS), which is intended; the browser role
-- `authenticated` does not, and that is the boundary being drawn here.
-- ---------------------------------------------------------------------------

alter table "Workspace"          enable row level security;
alter table "User"               enable row level security;
alter table "Project"            enable row level security;
alter table "ProjectMember"      enable row level security;
alter table "Organization"       enable row level security;
alter table "OrganizationMember" enable row level security;
alter table "Engagement"         enable row level security;
alter table "EngagementMember"   enable row level security;
alter table "Dataset"            enable row level security;
alter table "DatasetVersion"     enable row level security;
alter table "Analysis"           enable row level security;
alter table "Insight"            enable row level security;
alter table "Dashboard"          enable row level security;
alter table "Report"             enable row level security;
alter table "Presentation"       enable row level security;
alter table "Notebook"           enable row level security;
alter table "Comment"            enable row level security;
alter table "Activity"           enable row level security;
alter table "Notification"       enable row level security;
alter table "Chat"               enable row level security;
alter table "ChatMessage"        enable row level security;

-- Deny-by-default: enabled with NO policy, so the browser reaches nothing.
-- These hold credentials, hashes, or token material and are server-only.
alter table "UserApiKey"            enable row level security;
alter table "Connector"             enable row level security;
alter table "ClientPortalToken"     enable row level security;
alter table "ClientPortalAccount"   enable row level security;
alter table "ClientPortalLoginToken" enable row level security;
alter table "MailOutbox"            enable row level security;
alter table "JobQueue"              enable row level security;
alter table "VerificationToken"     enable row level security;
alter table "PhoneOtp"              enable row level security;

-- ---------------------------------------------------------------------------
-- 4. Policies — identity & firm
-- ---------------------------------------------------------------------------

-- A user sees only their own account row. Co-member names come from the server
-- (listOrganizationMembers) so emails are never exposed to the browser.
drop policy if exists user_self on "User";
create policy user_self on "User"
  for select to authenticated
  using ("id" = app_private.current_user_id());

drop policy if exists workspace_self on "Workspace";
create policy workspace_self on "Workspace"
  for select to authenticated
  using ("id" = app_private.current_workspace_id());

drop policy if exists organization_member_read on "Organization";
create policy organization_member_read on "Organization"
  for select to authenticated
  using (app_private.org_role("id") is not null);

drop policy if exists organization_admin_write on "Organization";
create policy organization_admin_write on "Organization"
  for update to authenticated
  using (app_private.org_role("id") in ('OWNER', 'ADMIN'))
  with check (app_private.org_role("id") in ('OWNER', 'ADMIN'));

-- Firm roster is readable inside the firm; only OWNER/ADMIN may change it.
drop policy if exists organization_member_read on "OrganizationMember";
create policy organization_member_read on "OrganizationMember"
  for select to authenticated
  using (app_private.org_role("organizationId") is not null);

drop policy if exists organization_member_admin_write on "OrganizationMember";
create policy organization_member_admin_write on "OrganizationMember"
  for all to authenticated
  using (app_private.org_role("organizationId") in ('OWNER', 'ADMIN'))
  with check (app_private.org_role("organizationId") in ('OWNER', 'ADMIN'));

-- Engagements are confidential client silos: firm members only.
drop policy if exists engagement_org_scope on "Engagement";
create policy engagement_org_scope on "Engagement"
  for select to authenticated
  using (app_private.org_role("organizationId") is not null);

drop policy if exists engagement_admin_write on "Engagement";
create policy engagement_admin_write on "Engagement"
  for all to authenticated
  using (app_private.org_role("organizationId") in ('OWNER', 'ADMIN'))
  with check (app_private.org_role("organizationId") in ('OWNER', 'ADMIN'));

drop policy if exists engagement_member_scope on "EngagementMember";
create policy engagement_member_scope on "EngagementMember"
  for select to authenticated
  using (app_private.org_role("organizationId") is not null);

-- ---------------------------------------------------------------------------
-- 5. Policies — projects
-- ---------------------------------------------------------------------------

drop policy if exists project_read on "Project";
create policy project_read on "Project"
  for select to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or app_private.can_read_project("id")
  );

drop policy if exists project_write on "Project";
create policy project_write on "Project"
  for all to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or app_private.can_write_project("id")
  )
  with check (
    "workspaceId" = app_private.current_workspace_id()
    or app_private.can_write_project("id")
  );

drop policy if exists project_member_read on "ProjectMember";
create policy project_member_read on "ProjectMember"
  for select to authenticated
  using (
    "userId" = app_private.current_user_id()
    or app_private.can_read_project("projectId")
  );

drop policy if exists project_member_owner_write on "ProjectMember";
create policy project_member_owner_write on "ProjectMember"
  for all to authenticated
  using (app_private.can_write_project("projectId"))
  with check (app_private.can_write_project("projectId"));

-- ---------------------------------------------------------------------------
-- 6. Policies — analytics artifacts
--
-- One shape, repeated: the row belongs to my workspace, OR to a project I can
-- read. Writes additionally require write access to that project. Projectless
-- artifacts are writable only inside my own workspace.
-- ---------------------------------------------------------------------------

drop policy if exists dataset_read on "Dataset";
create policy dataset_read on "Dataset"
  for select to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_read_project("projectId"))
  );

drop policy if exists dataset_write on "Dataset";
create policy dataset_write on "Dataset"
  for all to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  )
  with check (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  );

-- Versions inherit their dataset's visibility.
drop policy if exists dataset_version_read on "DatasetVersion";
create policy dataset_version_read on "DatasetVersion"
  for select to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or exists (
      select 1 from "Dataset" d
       where d."id" = "DatasetVersion"."datasetId"
         and d."projectId" is not null
         and app_private.can_read_project(d."projectId")
    )
  );

drop policy if exists analysis_read on "Analysis";
create policy analysis_read on "Analysis"
  for select to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_read_project("projectId"))
  );

drop policy if exists analysis_write on "Analysis";
create policy analysis_write on "Analysis"
  for all to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  )
  with check (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  );

drop policy if exists insight_read on "Insight";
create policy insight_read on "Insight"
  for select to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_read_project("projectId"))
  );

drop policy if exists insight_write on "Insight";
create policy insight_write on "Insight"
  for all to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  )
  with check (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  );

drop policy if exists dashboard_read on "Dashboard";
create policy dashboard_read on "Dashboard"
  for select to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_read_project("projectId"))
  );

drop policy if exists dashboard_write on "Dashboard";
create policy dashboard_write on "Dashboard"
  for all to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  )
  with check (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  );

drop policy if exists report_read on "Report";
create policy report_read on "Report"
  for select to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_read_project("projectId"))
  );

drop policy if exists report_write on "Report";
create policy report_write on "Report"
  for all to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  )
  with check (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  );

drop policy if exists presentation_read on "Presentation";
create policy presentation_read on "Presentation"
  for select to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_read_project("projectId"))
  );

drop policy if exists presentation_write on "Presentation";
create policy presentation_write on "Presentation"
  for all to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  )
  with check (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  );

drop policy if exists notebook_read on "Notebook";
create policy notebook_read on "Notebook"
  for select to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_read_project("projectId"))
  );

drop policy if exists notebook_write on "Notebook";
create policy notebook_write on "Notebook"
  for all to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  )
  with check (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_write_project("projectId"))
  );

-- ---------------------------------------------------------------------------
-- 7. Policies — collaboration, activity, personal data
-- ---------------------------------------------------------------------------

drop policy if exists comment_read on "Comment";
create policy comment_read on "Comment"
  for select to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("projectId" is not null and app_private.can_read_project("projectId"))
  );

-- Anyone who can read the thread may comment; only the author may edit/delete.
drop policy if exists comment_insert on "Comment";
create policy comment_insert on "Comment"
  for insert to authenticated
  with check (
    "authorId" = app_private.current_user_id()
    and (
      "workspaceId" = app_private.current_workspace_id()
      or ("projectId" is not null and app_private.can_read_project("projectId"))
    )
  );

drop policy if exists comment_author_write on "Comment";
create policy comment_author_write on "Comment"
  for update to authenticated
  using ("authorId" = app_private.current_user_id())
  with check ("authorId" = app_private.current_user_id());

drop policy if exists comment_author_delete on "Comment";
create policy comment_author_delete on "Comment"
  for delete to authenticated
  using ("authorId" = app_private.current_user_id());

drop policy if exists activity_read on "Activity";
create policy activity_read on "Activity"
  for select to authenticated
  using (
    "workspaceId" = app_private.current_workspace_id()
    or ("organizationId" is not null and app_private.org_role("organizationId") is not null)
  );

-- Append-only from the browser: no UPDATE or DELETE policy exists on purpose.
drop policy if exists activity_insert on "Activity";
create policy activity_insert on "Activity"
  for insert to authenticated
  with check (
    "workspaceId" = app_private.current_workspace_id()
    or ("organizationId" is not null and app_private.org_role("organizationId") is not null)
  );

drop policy if exists notification_self on "Notification";
create policy notification_self on "Notification"
  for all to authenticated
  using ("userId" = app_private.current_user_id())
  with check ("userId" = app_private.current_user_id());

drop policy if exists chat_self on "Chat";
create policy chat_self on "Chat"
  for all to authenticated
  using ("userId" = app_private.current_user_id())
  with check ("userId" = app_private.current_user_id());

drop policy if exists chat_message_self on "ChatMessage";
create policy chat_message_self on "ChatMessage"
  for all to authenticated
  using (exists (
    select 1 from "Chat" c
     where c."id" = "ChatMessage"."chatId"
       and c."userId" = app_private.current_user_id()
  ))
  with check (exists (
    select 1 from "Chat" c
     where c."id" = "ChatMessage"."chatId"
       and c."userId" = app_private.current_user_id()
  ));

-- ---------------------------------------------------------------------------
-- 8. Deliberate non-policies (recommendations, not omissions)
--
--   * Public share links (Dashboard/Report/Notebook accessMode='public',
--     shareToken) and the client portal tokens are NOT exposed through RLS.
--     A share token is a capability, so a policy such as
--       using ("accessMode" = 'public')
--     would make every published artifact enumerable by anyone holding the
--     anon key. Those routes stay server-mediated (/apps/[shareToken],
--     /portal/[token]) where the token is verified and the row is fetched with
--     the server credential.
--   * ErrorReport, ComplianceEvent, ConsentRecord, MailOutbox are operational
--     or legal-evidence tables; they have no browser-readable policy at all.
--   * The remaining ~107 Prisma models (GST, TDS, deliverables, working
--     papers, MLOps, search, billing) are not exposed to the browser here.
--     Add policies table-by-table when a screen actually needs direct access;
--     until then they are unreachable, which is the safe default.
-- ---------------------------------------------------------------------------

commit;

-- ============================================================================
-- VERIFY AFTER APPROVAL (read-only; run these, do not trust the file)
--
--   -- 1. Which tables have RLS and which are forced?
--   select c.relname, c.relrowsecurity, c.relforcerowsecurity
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind = 'r'
--    order by c.relrowsecurity desc, c.relname;
--
--   -- 2. Policy inventory
--   select tablename, policyname, cmd, roles
--     from pg_policies where schemaname = 'public'
--    order by tablename, policyname;
--
--   -- 3. Negative control: as the `authenticated` role with NO JWT, every
--   --    tenant table must return zero rows.
--   set local role authenticated;
--   select count(*) from "Dataset";   -- must be 0
--
--   -- 4. Positive control: impersonate a linked user and confirm they see
--   --    exactly their own workspace's rows (replace the uuid).
--   select set_config('request.jwt.claims',
--     json_build_object('sub', '<supabase-user-uuid>', 'role', 'authenticated')::text, true);
--   select count(*) from "Dataset";
--
-- ROLLBACK (if a policy is wrong)
--   alter table "Dataset" disable row level security;   -- per table
--   -- or restore the previous definitions from prisma/rls.sql
-- ============================================================================
