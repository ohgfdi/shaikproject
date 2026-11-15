-- ===========================================================================
-- RLS batch 1 — ledger, billing and API-key tables
--
-- This is the first deployable slice of row-level security. It is ENABLED and
-- FORCED here, but enforcement stays off in the app (`RLS_ENABLED=false`,
-- `RLS_QUERY_LAYER_WIRED=false`) until the tenancy audit reaches zero. Adding
-- the policies now means each migrated table is protected the moment the
-- switch flips, instead of depending on a separate psql step.
--
-- TENANT KEY
--   `app.tenant_id` holds a Workspace id. Workspace ids are cuid STRINGS in
--   this schema (not uuid), so the policies compare text to text:
--       "workspaceId" = current_setting('app.tenant_id', true)
--   `lib/server/tenant-db.ts` sets it with a parameterized set_config inside a
--   transaction, so it is transaction-local and cannot leak across pooled
--   connections. It also sets `app.current_workspace` for the older analytics
--   policies in prisma/rls.sql.
--
-- FAIL CLOSED
--   current_setting(..., true) returns NULL when unset. `NULL = 'x'` is NULL,
--   which is not true, so SELECT/UPDATE/DELETE match zero rows; WITH CHECK
--   rejects INSERTs. There is deliberately no "if unset, show everything"
--   branch.
--
-- APP ROLE (required before enabling)
--   FORCE makes the policies apply to the table owner, but a superuser or a
--   role with BYPASSRLS still ignores them. The runtime must connect as a
--   dedicated, non-owner role. The migration role (DIRECT_URL) stays the owner
--   and runs `prisma migrate deploy`; the app role gets DML only:
--
--     CREATE ROLE ledgerly_app LOGIN PASSWORD '<generated>' NOBYPASSRLS;
--     GRANT CONNECT ON DATABASE "<db>" TO ledgerly_app;
--     GRANT USAGE ON SCHEMA public TO ledgerly_app;
--     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ledgerly_app;
--     GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ledgerly_app;
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ledgerly_app;
--
--   Then point the runtime DATABASE_URL at ledgerly_app (keep DIRECT_URL on the
--   owner for migrations). Verify with:
--     SELECT current_user, rolsuper, rolbypassrls
--       FROM pg_roles WHERE rolname = current_user;   -- both must be false
--     SELECT tableowner FROM pg_tables WHERE tablename = 'Book';
--
-- SCOPE NOTE
--   `Workspace`, `User` and the session cookie are intentionally absent: auth
--   bootstrap reads the user/workspace before any tenant is known, so forcing a
--   policy there would break sign-in. Their isolation stays in the application
--   layer (and `Workspace` has no parent tenant to compare against).
-- ===========================================================================

-- --- Subscription (billing) -------------------------------------------------
ALTER TABLE "Subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subscription" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_subscription ON "Subscription";
CREATE POLICY tenant_isolation_subscription ON "Subscription"
  USING ("workspaceId" = current_setting('app.tenant_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.tenant_id', true));

-- --- Invoice (billing) ------------------------------------------------------
ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invoice" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_invoice ON "Invoice";
CREATE POLICY tenant_isolation_invoice ON "Invoice"
  USING ("workspaceId" = current_setting('app.tenant_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.tenant_id', true));

-- --- UserApiKey (auth surface) ---------------------------------------------
ALTER TABLE "UserApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserApiKey" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_user_api_key ON "UserApiKey";
CREATE POLICY tenant_isolation_user_api_key ON "UserApiKey"
  USING ("workspaceId" = current_setting('app.tenant_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.tenant_id', true));

-- --- Book (ledger) ----------------------------------------------------------
ALTER TABLE "Book" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Book" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_book ON "Book";
CREATE POLICY tenant_isolation_book ON "Book"
  USING ("workspaceId" = current_setting('app.tenant_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.tenant_id', true));

-- --- Book children ----------------------------------------------------------
-- Child rows carry no workspaceId; scope them through their parent Book. The
-- subquery is itself subject to Book's policy, so an unset tenant sees nothing.
ALTER TABLE "BookAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookAccount" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_book_account ON "BookAccount";
CREATE POLICY tenant_isolation_book_account ON "BookAccount"
  USING (EXISTS (
    SELECT 1 FROM "Book" b
     WHERE b."id" = "BookAccount"."bookId"
       AND b."workspaceId" = current_setting('app.tenant_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Book" b
     WHERE b."id" = "BookAccount"."bookId"
       AND b."workspaceId" = current_setting('app.tenant_id', true)
  ));

ALTER TABLE "BookVoucher" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookVoucher" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_book_voucher ON "BookVoucher";
CREATE POLICY tenant_isolation_book_voucher ON "BookVoucher"
  USING (EXISTS (
    SELECT 1 FROM "Book" b
     WHERE b."id" = "BookVoucher"."bookId"
       AND b."workspaceId" = current_setting('app.tenant_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Book" b
     WHERE b."id" = "BookVoucher"."bookId"
       AND b."workspaceId" = current_setting('app.tenant_id', true)
  ));

ALTER TABLE "BookVoucherLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookVoucherLine" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_book_voucher_line ON "BookVoucherLine";
CREATE POLICY tenant_isolation_book_voucher_line ON "BookVoucherLine"
  USING (EXISTS (
    SELECT 1 FROM "BookVoucher" v
      JOIN "Book" b ON b."id" = v."bookId"
     WHERE v."id" = "BookVoucherLine"."voucherId"
       AND b."workspaceId" = current_setting('app.tenant_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "BookVoucher" v
      JOIN "Book" b ON b."id" = v."bookId"
     WHERE v."id" = "BookVoucherLine"."voucherId"
       AND b."workspaceId" = current_setting('app.tenant_id', true)
  ));

COMMENT ON POLICY tenant_isolation_book ON "Book" IS
  'Ledger books are visible only to the workspace in app.tenant_id; unset means no rows.';
