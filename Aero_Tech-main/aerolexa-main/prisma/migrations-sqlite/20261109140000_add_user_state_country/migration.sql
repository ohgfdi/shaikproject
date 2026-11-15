-- The User model gained `state`/`country` (client jurisdiction for compliance)
-- but no migration ever created them, so every User query failed on a freshly
-- migrated database. Additive and nullable: existing rows are untouched.
ALTER TABLE "User" ADD COLUMN "state" TEXT;
ALTER TABLE "User" ADD COLUMN "country" TEXT;
