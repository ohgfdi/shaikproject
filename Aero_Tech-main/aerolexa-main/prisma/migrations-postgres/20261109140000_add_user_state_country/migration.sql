-- The User model gained `state`/`country` (client jurisdiction for compliance)
-- but no migration ever created them, so signup/login failed with
-- "column User.state does not exist" on a freshly migrated database.
-- Idempotent + nullable: re-deploys and existing rows are safe.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "country" TEXT;
